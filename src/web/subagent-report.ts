/**
 * 子代理家族五件套之三：送达与治理（docs/21 §3.1 自 subagents.ts 拆出，纯移动）。
 * docs/16 起任务结算的唯一出口：任务执行（runOneTask）+ 报告修剪与格式化（reportMessage）
 * + 收件箱送达（deliverToCoordinator——与用户运行中插话共队列，FIFO 按完成顺序逐条开轮；
 * 空闲立即开轮、忙碌轮末排空，见 session-lifecycle）+ 上下文治理三档判定（docs/10 R1：
 * warn 提示线 / followup 拒收线 / archive 强制归档线，收尾时按 contextPct 分流 idle/归档）
 * + 失败归因（docs/18 打断即终结：「任务被用户停止」独立文案）。协调者感知子代理状态的
 * 唯一事实源是送达消息与派发回执文本——SSE 事件不进协调者历史。
 */
import { SUBAGENT_ARCHIVE_CONTEXT_PCT, SUBAGENT_FOLLOWUP_CONTEXT_PCT, SUBAGENT_RESULT_MAX_CHARS, SUBAGENT_WARN_CONTEXT_PCT } from "../config.ts";
import { pruneToolResult } from "../tools/prune.ts";
import { AUTO_DELIVERY_PREFIXES, SSE_EVENTS } from "../core/events.ts";
import { formatWorkerResult } from "../modules/tools/agent-task/agent-task.ts";
import type { SessionRuntime } from "../core/host.ts";
import type { SubagentResult } from "../core/types.ts";
import type { ProviderConfig } from "../providers/store.ts";
import { cfgOf, requestApprovalFor, settleCoordinatorClock, type SessionShell } from "./session-runtime.ts";
import { dumpTranscript } from "./subagent-archive.ts";
import { finalizeArchive, finishSubagent, reportAggregated, reusableRecord, upsertSubagentRecord, usageFields, type WorkerSession } from "./subagent-records.ts";

/** worker 任务收尾时的上下文占用百分比（docs/10 R1）：估算输入（system + 工具 schema +
 *  技能 + 消息，Agent.contextEstimate 与主对话完全同口径）÷ 会话提供方上下文长度。
 *  Agent 未装配 / 长度非法（含测试桩无提供方）返回 undefined（记录不带字段）。 */
export function contextPctOf(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession): number | undefined {
  if (!ws.agent) return undefined;
  const len = (cfgOf(sh, rt) as { contextLength?: number } | undefined)?.contextLength ?? 0;
  if (!(len > 0)) return undefined;
  return Math.min(100, Math.round((ws.agent.contextEstimate().total / len) * 100));
}

/** 子代理报告/状态通知送达协调者（docs/11 W1，docs/16 起为任务结算的唯一出口）：进收件箱
 *  ——与用户运行中插话（W2-L1）
 *  共队列，FIFO 天然保序（多份报告按完成顺序逐条开轮处理）；协调者空闲时立即开轮消化，
 *  忙碌时由轮末排空续上。runtime 已被替换/会话已删（runtimes 对不上）或无宿主接缝时
 *  静默排队（测试直调场景），不丢文本。 */
export function deliverToCoordinator(sh: SessionShell, rt: SessionRuntime, text: string): void {
  (rt.inbox ??= []).push(text);
  const host = sh.ctx.sessionHost;
  if (rt.busy || !rt.workspace || sh.runtimes.get(rt.id) !== rt || !host) return;
  host.startTurn(rt, rt.inbox.shift()!);
}

/** 延迟送达的报告消息（docs/11 W1；docs/16 起为所有任务结算的送达形态）：与历史工具结果
 *  同格式（协调者既有的阅读习惯）+ 送达前缀；一次性子代理补自动归档注记（状态显式可见）。 */
export function reportMessage(res: SubagentResult, name: string): string {
  const body = formatWorkerResult(res, name, { warnPct: SUBAGENT_WARN_CONTEXT_PCT, followupPct: SUBAGENT_FOLLOWUP_CONTEXT_PCT });
  const tail = res.reusable ? "" : "\n（该子代理为一次性：任务结束已自动归档。）";
  return `${AUTO_DELIVERY_PREFIXES.report}\n${body}${tail}`;
}

/** followup 上下文门槛拒收文案（docs/10 R1；在线与唤醒两路共用，docs/17 起指引 read_archive）。 */
export function followupContextReject(name: string, subId: number, pct: number): string {
  return (
    `子代理 ${name}#${subId} 的上下文占用已达 ${pct}%（上限 ${SUBAGENT_FOLLOWUP_CONTEXT_PCT}%，subagentFollowupContextPct）——上下文过长的子代理继续任务容易产生幻觉，不宜再追加。` +
    `请用 archive_subagent 归档后用 agent_task 重新派发；任务书可让它先用 read_archive（subId=${subId}）读过程存档接续上下文 [[过程档案#${subId}]]。`
  );
}

/** 打断结算的归因文案（docs/18）：stop 置标记后经 ctl.abort 收尾——与「归档中止」共用
 *  abort 路径、靠标记区分。runOneTask 开始前的打断（装配窗口/任务间隙）用同一文案。 */
const STOP_WHY = "任务被用户停止（进行中的请求与工具执行已中止；没有恢复机制）";

/** 失败归因：归档中止（docs/9）> 用户停止（docs/18）> 外部中止 > 超时 >（异常消息 | 空回复）。 */
function failureWhy(
  outerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  e: unknown,
  pendingArchive: boolean,
  stopRequested: boolean | undefined,
): string {
  if (pendingArchive) return "任务被归档请求中止";
  if (stopRequested) return STOP_WHY;
  return outerSignal?.aborted
    ? "子代理被用户中止"
    : timeoutSignal?.aborted
      ? `子代理超时（${timeoutMs}ms）`
      : e !== undefined
        ? e instanceof Error
          ? e.message
          : String(e)
        : "子代理未能给出最终报告（空回复）";
}

/**
 * 在 worker（ws）上执行一个任务并收尾（docs/9）：per-task 超时/中止信号与审批闭包、
 * followup 起跑事件（首任务省略——spawned 已表达）、报告修剪、transcript 累积重写、
 * 用量守恒上报，然后按类别分流——一次性：注销句柄 + done/error 事件 + 追加
 * state:"archived" 记录（与历史版本一致，仅记录多 state 字段）；可复用：转 idle 待命
 * （upsert state:"idle" 记录 + idle 事件），归档请求挂起时改走归档收尾。
 */
export async function runOneTask(
  sh: SessionShell,
  rt: SessionRuntime,
  ws: WorkerSession,
  task: string,
  opts: { timeoutMs?: number; description?: string; first: boolean },
  outerSignal: AbortSignal | undefined,
  reusables: Map<number, WorkerSession>,
): Promise<SubagentResult> {
  // 中止/超时信号合并后同时挂两处：worker 的 LLM 调用链 + 父会话审批串行队列
  // （§5.2：排队中的审批请求发现信号已中止立即 cancelled，队列快速排空）；
  // ctl 是归档/打断的共用中止入口（docs/9/18）——requestArchive 与 stop 都经它终止当前任务。
  const timeoutSignal = opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  const ctl = new AbortController();
  const parts: AbortSignal[] = [ctl.signal, ...(outerSignal ? [outerSignal] : []), ...(timeoutSignal ? [timeoutSignal] : [])];
  const sig = parts.length > 1 ? AbortSignal.any(parts) : parts[0]!;
  const startedAt = Date.now();
  ws.cur = {
    usage: { prompt: 0, completion: 0, reasoning: 0, cacheHit: 0 },
    startedAt,
    ctl,
    pendingArchive: false,
    ...(outerSignal ? { outerSignal } : {}),
    ...(timeoutSignal ? { timeoutSignal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  ws.active.status = "run";
  ws.active.taskStartedAt = startedAt; // 前端「本次用时」实时取值（收尾清除）
  ws.approval = requestApprovalFor(sh, rt, { signal: sig });
  if (!opts.first) {
    // followup 起跑事件（docs/9）：前端抽屉行 idle→run + 摘要更新
    sh.broadcast(SSE_EVENTS.subagent, {
      sessionId: rt.id,
      subId: ws.subId,
      name: ws.name,
      phase: "task",
      ...(opts.description ? { summary: opts.description } : {}),
      taskStartedAt: startedAt,
    });
  }

  let rounds: number | undefined;
  let res: SubagentResult;
  try {
    if (ws.stopRequested) throw new Error(STOP_WHY); // 派发后、任务开始前即被打断（装配窗口/任务间隙）
    const r = await ws.agent!.run(task, sig);
    rounds = r?.rounds;
    reportAggregated(sh, rt, ws.cur.usage);
    if (r && r.finalText) {
      // 报告预算：超出修剪为预算内文本；剪掉量超 spill 阈值时全文落 worker 私有目录
      const pr = pruneToolResult(r.finalText, SUBAGENT_RESULT_MAX_CHARS, ws.spillDir ? { dir: ws.spillDir } : undefined);
      res = {
        ok: true,
        text: pr.text,
        rounds: r.rounds,
        ...usageFields(ws.cur.usage),
      };
    } else {
      res = { ok: false, text: "", error: failureWhy(outerSignal, timeoutSignal, opts.timeoutMs, undefined, ws.cur.pendingArchive, ws.stopRequested), rounds };
    }
  } catch (e) {
    reportAggregated(sh, rt, ws.cur.usage);
    res = { ok: false, text: "", error: failureWhy(outerSignal, timeoutSignal, opts.timeoutMs, e, ws.cur.pendingArchive, ws.stopRequested), rounds };
  }
  const cur = ws.cur!;
  ws.cur = null;
  // 任务用时折算：本次耗时并入累计，结果/记录/事件携带
  const taskMs = Date.now() - cur.startedAt;
  ws.elapsedMs += taskMs;
  res.elapsedMs = taskMs;
  delete ws.active.taskStartedAt;
  ws.approval = undefined;
  if (ws.stopRequested) {
    // docs/18：打断结算的送达标记——协调者侧跳过失败报告（通知/工具文案已覆盖）
    res.stopped = true;
    ws.stopRequested = false; // 消费（不影响后续 followup 任务）
  }

  res.subId = ws.subId;
  // docs/10 R1：任务收尾时的上下文占用快照（与主对话 contextEstimate 同口径）——只在任务
  // 边界更新（运行中不跳动），协调者拿到的是稳定可比较的数字；followup 门槛与前端展示
  // 的共同消费源。
  const contextPct = contextPctOf(sh, rt, ws);
  if (contextPct !== undefined) {
    ws.contextPct = contextPct;
    ws.active.contextPct = contextPct;
    res.contextPct = contextPct;
  }
  // docs/17：收尾形态先判定（存档 meta.state 要落对值）——一次性必归档；可复用=归档请求
  // 挂起或上下文超归档线 → 归档，否则 idle 待命。
  const toArchived = !ws.active.reusable || cur.pendingArchive || (contextPct !== undefined && contextPct > SUBAGENT_ARCHIVE_CONTEXT_PCT);
  if (ws.active.reusable) {
    // 可复用收尾（docs/9）：累计统计先入账（下方存档 meta 随之落盘，拿到最新累计值）
    ws.tasks++;
    if (res.rounds !== undefined) ws.rounds += res.rounds;
    ws.usage.prompt += cur.usage.prompt;
    ws.usage.completion += cur.usage.completion;
    ws.usage.reasoning += cur.usage.reasoning;
    ws.usage.cacheHit += cur.usage.cacheHit;
    ws.lastOk = res.ok;
    ws.lastError = res.ok ? undefined : res.error;
    res.reusable = true;
    res.name = ws.name;
    res.taskNo = ws.tasks;
  }
  // 全程过程落盘（docs/6 P3 方案 A；docs/17 起为主对话 SessionData 同构格式）：成功/失败
  // 都写（失败的部分过程同样有排查价值）；可复用为跨任务累积重写（同一 transcript.json
  // 随任务增长）。best-effort，写失败不影响结果返回（记录不带入口，前端不显示「📄 过程」）。
  const transcript = dumpTranscript(sh, rt, ws, toArchived ? "archived" : "idle");
  if (transcript) {
    res.transcript = transcript;
    ws.transcript = transcript;
  }

  if (ws.active.reusable) {
    if (cur.pendingArchive) {
      res.archived = "request"; // docs/11 W1：归档请求中止的收尾——工具层输出归档说明而非待命提示
      finalizeArchive(sh, rt, ws, reusables);
    } else if (contextPct !== undefined && contextPct > SUBAGENT_ARCHIVE_CONTEXT_PCT) {
      // docs/10 R1：上下文超过强制归档线——不转 idle 直接归档（继续驻留只会诱导协调者向
      // 高幻觉风险实例追加任务）；归档语义与手动归档一致，res.forceArchived 让工具层把
      // 待命提示替换为归档说明。
      res.forceArchived = true;
      res.archived = "context"; // docs/11 W1：与归档请求中止同带归档原因（消费面统一）
      finalizeArchive(sh, rt, ws, reusables);
    } else {
      ws.active.status = "idle";
      ws.active.tasks = ws.tasks;
      upsertSubagentRecord(rt, reusableRecord(ws, "idle"));
      // idle 事件载荷与记录同口径（累计统计）——前端行展示与 state 快照回填一致，不闪烁
      sh.broadcast(SSE_EVENTS.subagent, {
        sessionId: rt.id,
        subId: ws.subId,
        name: ws.name,
        phase: "idle",
        ok: res.ok,
        ...(ws.rounds > 0 ? { rounds: ws.rounds } : {}),
        ...usageFields(ws.usage),
        ...(!res.ok && res.error ? { error: res.error } : {}),
        ...(transcript ? { transcript: transcript } : {}),
        tasks: ws.tasks,
        ...(ws.contextPct !== undefined ? { contextPct: ws.contextPct } : {}),
        ...(ws.elapsedMs > 0 ? { elapsedMs: ws.elapsedMs } : {}),
      });
      // docs/35 真机待办1：若这是最后一个 run 态子代理，协调者编排计时在此折算收口
      // （随后报告送达若开新轮，startTurn 会重新起算「本次」——累计无缝衔接）
      settleCoordinatorClock(sh, rt);
    }
    return res;
  }

  // 一次性收尾：与历史版本一致——先注销控制句柄（收尾广播后不可再施控），再 done/error +
  // state:"archived" 审计记录（用完即归档，docs/9）；记录/事件带 contextPct（docs/10 R1，
  // 纯观测——一次性子代理无 followup 决策面）。
  rt.activeSubagents.delete(ws.subId);
  finishSubagent(sh, rt, { subId: ws.subId, name: ws.name, ...(ws.description ? { description: ws.description } : {}) }, res, transcript);
  return res;
}
