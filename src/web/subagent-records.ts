/**
 * 子代理家族五件套之五：记录与用量（docs/21 §3.1 自 subagents.ts 拆出，纯移动）。
 * WorkerSession（worker 驻留上下文类型——用量/计时/累计统计字段的载体，与审计记录同族；
 * 装配与任务执行在 subagent-worker/subagent-report）+ SubagentRecord 审计落账（随会话存档、
 * 恢复时以条数续期 subagentTotal 累计闸，SA4）+ 用量聚合上报（结束后一次 reportUsage 计入
 * 父会话 totals，breakdown 差额归 other，守恒不破——不变量 1）+ 归档终结（记录定格
 * state:"archived" + archived 事件 + 句柄/驻留注销）。本文件是家族叶子：不 import 其他
 * subagent-* 文件（类型自足），可被全部兄弟文件安全引用。
 */
import { AUTO_DELIVERY_PREFIXES, SSE_EVENTS, type SseEventName } from "../core/events.ts";
import type { ActiveSubagent, SessionRuntime } from "../core/host.ts";
import type { SubagentResult } from "../core/types.ts";
import { reportUsage, settleCoordinatorClock, type SessionShell } from "./session-runtime.ts";
import type { Agent } from "../agent.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.ts";
import type { EffortSetting } from "../llm/provider.ts";
import type { SubagentRecord } from "./sessions.ts";

/** 控制动作的壳侧副作用接缝（docs/35 真机待办4）：活动句柄路径本就持有 sh 广播/送达/落盘；
 *  休眠待命记录（服务重启后残留）的归档同样需要这三件事——由两处调用方（createRuntime 工具
 *  闭包 / web-sessions 路由）就近装配注入。io 缺席（无壳的测试直调）只改记录，无副作用。 */
export interface SubagentControlIo {
  broadcast(event: SseEventName, data: unknown): void;
  /** 状态通知送进协调者收件箱（= deliverToCoordinator(sh, rt, text)） */
  deliver(text: string): void;
  /** 会话落盘（= persistSession(sh, rt)） */
  persist(): void;
}

/** 休眠待命记录（服务重启后运行实例不在线、待命记录仍在）的直接归档（docs/35 真机待办4）：
 *  无活动句柄可中止——记录就地定格 state:"archived" + archived 事件（前端行翻 📦）+ ui 路径
 *  状态通知（协调者视角的异常变动，与活动归档同约定）+ 落盘。返回面向调用方的结果文案。 */
export function archiveDormantRecord(rt: SessionRuntime, rec: SubagentRecord, via: "ui" | "model", io?: SubagentControlIo): string {
  upsertSubagentRecord(rt, { ...rec, state: "archived", at: new Date().toISOString() });
  io?.broadcast(SSE_EVENTS.subagent, {
    sessionId: rt.id,
    subId: rec.subId,
    name: rec.name,
    phase: "archived",
    ...(rec.tasks !== undefined ? { tasks: rec.tasks } : {}),
    ...(rec.rounds !== undefined ? { rounds: rec.rounds } : {}),
    ...(rec.usage ? { usage: rec.usage } : {}),
    ...(rec.transcript ? { transcript: rec.transcript } : {}),
    ...(rec.contextPct !== undefined ? { contextPct: rec.contextPct } : {}),
    ...(rec.elapsedMs !== undefined ? { elapsedMs: rec.elapsedMs } : {}),
  });
  if (via === "ui") {
    io?.deliver(
      `${AUTO_DELIVERY_PREFIXES.status} 可复用子代理 ${rec.name}#${rec.subId} 已被用户归档（服务重启后的休眠待命记录；不可再用 agent_followup 追加任务）。` +
        (rec.transcript
          ? `需要继续该方向的工作时用 agent_task 重新派发，任务书可让它先用 read_archive（subId=${rec.subId}）读过程存档接续上下文 [[过程档案#${rec.subId}]]。`
          : "需要继续该方向的工作时用 agent_task 重新派发。"),
    );
  }
  io?.persist();
  return `已归档子代理：${rec.name}#${rec.subId}（休眠待命——服务重启后运行实例不在线；共完成 ${rec.tasks ?? 0} 次任务）。归档后仅可查看过程存档，不可再派任务。`;
}

/** 可复用 worker 的驻留上下文（docs/9）：装配一次跨任务复用（Agent 与完整历史延续即复用
 *  价值）。Map 由 subagentServiceFor 闭包持有（服务与会话同生命周期）；runWorker 直调
 *  （单测）不传时用局部 Map——归档仍可用（经 activeSubagents 句柄），仅 followup 不可寻址。 */
export interface WorkerSession {
  subId: number;
  name: string;
  /** 首次派发的任务摘要（记录的 description，身份稳定不随任务变） */
  description?: string;
  /** Agent 装配完成后回填（句柄/事件先于装配注册） */
  agent: Agent | null;
  /** 持久控制句柄（可复用：spawn→archive 驻留 activeSubagents；一次性：spawn→done/error） */
  active: ActiveSubagent;
  spillDir?: string;
  dirTag: string;
  /** 当前任务的审批闭包（per-task 重建：中止信号要挂对当前任务的链，docs/9） */
  approval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 当前任务运行态（idle 时为 null） */
  cur: {
    /** 本任务用量盒（AgentUi.printUsage 聚合写入） */
    usage: { prompt: number; completion: number; reasoning: number; cacheHit: number };
    /** 本任务开始时刻（epoch ms；收尾时折算用时并入 ws.elapsedMs） */
    startedAt: number;
    /** 归档中止入口（requestArchive 用；外部中止/超时仍走 outerSignal/timeoutSignal） */
    ctl: AbortController;
    /** 归档请求标记：任务收尾时归档而非转 idle */
    pendingArchive: boolean;
    outerSignal?: AbortSignal;
    timeoutSignal?: AbortSignal;
    timeoutMs?: number;
  } | null;
  /** 打断请求标记（docs/18，ws 级——覆盖装配窗口与任务间隙）：stop 置位（+ abort 当前
   *  任务的 ctl，若有）；runOneTask 开始时消费（任务未开始即结算）、收尾时归因「任务被
   *  用户停止」，两处都重置——下一任务不受影响。 */
  stopRequested?: boolean;
  /** 累计统计（记录 upsert 用）：已完成任务数 / 累计轮数 / 累计用量 / 累计运行毫秒 */
  tasks: number;
  rounds: number;
  usage: { prompt: number; completion: number; reasoning: number; cacheHit: number };
  elapsedMs: number;
  /** 最近一次任务收尾时的上下文占用百分比（docs/10 R1：Agent.contextEstimate ÷ 提供
   *  方上下文长度，与主对话同口径；followup 门槛与前端展示的消费源） */
  contextPct?: number;
  /** 最新 transcript 相对路径（每任务结束累积重写） */
  transcript?: string;
  /** 最近一次任务结果（记录的 ok/error） */
  lastOk: boolean;
  lastError?: string;
  /** 装配期收到的归档请求（docs/9）：装配完成即归档收尾，不执行首任务 */
  archiveRequested?: boolean;
  /** Agent 构造期参数（docs/17 存档 meta 用）：首派发从 req 捕获、唤醒从存档 meta 回填。
   *  effort 缺省继承会话档位；scope 缺省整个工作区；system 缺省无角色段。 */
  effort?: EffortSetting;
  scope?: string[];
  system?: string;
}

/** 用量盒 → { usage? } 拼装（有量才带字段；原 runWorker 成功路径同款）。 */
export function usageFields(u: { prompt: number; completion: number; reasoning: number; cacheHit: number }): { usage?: { prompt: number; completion: number; reasoning?: number; cacheHit?: number } } {
  if (u.prompt <= 0 && u.completion <= 0) return {};
  return {
    usage: { prompt: u.prompt, completion: u.completion, ...(u.reasoning ? { reasoning: u.reasoning } : {}), ...(u.cacheHit ? { cacheHit: u.cacheHit } : {}) },
  };
}

/** 记录 upsert（docs/9 可复用）：按 subId 定位替换（无则追加）。 */
export function upsertSubagentRecord(rt: SessionRuntime, rec: SubagentRecord): void {
  const i = rt.subagents.findIndex((r) => r.subId === rec.subId);
  if (i >= 0) rt.subagents[i] = rec;
  else rt.subagents.push(rec);
}

/** 可复用子代理的记录构造（docs/9）：ok/error=最近一次任务；rounds/usage/tasks/elapsedMs=累计。 */
export function reusableRecord(ws: WorkerSession, state: "idle" | "archived"): SubagentRecord {
  return {
    subId: ws.subId,
    name: ws.name,
    ...(ws.description ? { description: ws.description } : {}),
    ok: ws.lastOk,
    ...(ws.rounds > 0 ? { rounds: ws.rounds } : {}),
    ...usageFields(ws.usage),
    ...(!ws.lastOk && ws.lastError ? { error: ws.lastError } : {}),
    ...(ws.transcript ? { transcript: ws.transcript } : {}),
    reusable: true,
    ...(ws.tasks > 0 ? { tasks: ws.tasks } : {}),
    ...(ws.contextPct !== undefined ? { contextPct: ws.contextPct } : {}),
    ...(ws.elapsedMs > 0 ? { elapsedMs: ws.elapsedMs } : {}),
    state,
    at: new Date().toISOString(),
  };
}

/** 归档终结（docs/9）：记录定格 state:"archived" + archived 事件 + 句柄/驻留注销（释放
 *  Agent 与历史）。之后仅可查看（记录 + transcript 只读），不可再派任务。 */
export function finalizeArchive(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession, reusables: Map<number, WorkerSession>): void {
  upsertSubagentRecord(rt, reusableRecord(ws, "archived"));
  rt.activeSubagents.delete(ws.subId);
  reusables.delete(ws.subId);
  const u = usageFields(ws.usage);
  sh.broadcast(SSE_EVENTS.subagent, {
    sessionId: rt.id,
    subId: ws.subId,
    name: ws.name,
    phase: "archived",
    ...(ws.tasks > 0 ? { tasks: ws.tasks } : {}),
    ...(ws.rounds > 0 ? { rounds: ws.rounds } : {}),
    ...(u.usage ? { usage: u.usage } : {}),
    ...(ws.transcript ? { transcript: ws.transcript } : {}),
    ...(ws.contextPct !== undefined ? { contextPct: ws.contextPct } : {}),
    ...(ws.elapsedMs > 0 ? { elapsedMs: ws.elapsedMs } : {}),
  });
  // docs/35 真机待办1：这可能是最后一个 run 态子代理的收尾——协调者编排计时在此折算收口
  settleCoordinatorClock(sh, rt);
}

/** worker 收尾统一出口（SA4，一次性子代理）：审计记录进 rt.subagents（随 toSessionData
 *  落盘、恢复续期配额）+ 广播 done/error 事件（前端工具块时间线；usage/rounds 与结果同源）。
 *  docs/9：一次性任务结束即自动归档——记录带 state:"archived"。
 *  transcript（docs/6 P3 方案 A）：过程存档相对路径，记录与事件都携带——前端时间线行
 *  与报告标记据此显示「📄 过程」入口。 */
export function finishSubagent(
  sh: SessionShell,
  rt: SessionRuntime,
  id: { subId: number; name: string; description?: string },
  res: SubagentResult,
  transcript?: string,
): void {
  rt.subagents.push({
    ...id,
    ok: res.ok,
    ...(res.rounds !== undefined ? { rounds: res.rounds } : {}),
    ...(res.usage ? { usage: res.usage } : {}),
    ...(!res.ok && res.error ? { error: res.error } : {}),
    ...(transcript ? { transcript: transcript } : {}),
    ...(res.contextPct !== undefined ? { contextPct: res.contextPct } : {}),
    ...(res.elapsedMs !== undefined ? { elapsedMs: res.elapsedMs } : {}),
    state: "archived",
    at: new Date().toISOString(),
  });
  sh.broadcast(SSE_EVENTS.subagent, {
    sessionId: rt.id,
    subId: id.subId,
    name: id.name,
    phase: res.ok ? "done" : "error",
    ...(res.rounds !== undefined ? { rounds: res.rounds } : {}),
    ...(res.usage ? { usage: res.usage } : {}),
    ...(!res.ok && res.error ? { error: res.error } : {}),
    ...(transcript ? { transcript: transcript } : {}),
    ...(res.contextPct !== undefined ? { contextPct: res.contextPct } : {}),
    ...(res.elapsedMs !== undefined ? { elapsedMs: res.elapsedMs } : {}),
  });
  settleCoordinatorClock(sh, rt); // docs/35 真机待办1：最后一个子代理收尾 → 编排计时收口
}

/** worker 全程用量一次计入父会话（分类明细随 worker 历史消亡，差额归 other——守恒不变量 1）。 */
export function reportAggregated(sh: SessionShell, rt: SessionRuntime, usage: { prompt: number; completion: number; reasoning: number; cacheHit: number }): void {
  if (usage.prompt <= 0 && usage.completion <= 0) return;
  reportUsage(sh, rt, {
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    ...(usage.cacheHit ? { cacheHitTokens: usage.cacheHit } : {}),
    ...(usage.reasoning ? { reasoningTokens: usage.reasoning } : {}),
    breakdown: {
      systemPrompt: 0,
      skills: 0,
      systemTools: 0,
      mcp: 0,
      messages: 0,
      other: usage.prompt, // 差额全部归 other：输入发生在 worker 独立上下文
    },
  });
}
