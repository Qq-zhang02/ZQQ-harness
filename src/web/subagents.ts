/**
 * 子代理（worker）运行机制——家族门面（docs/5 §2 起；docs/21 §3.1 D1 拆分后本文件只留
 * 门面与派发/配额/控制，装配/结算/存档/记录在兄弟文件）：
 *   subagent-worker.ts   装配三态共用件（createWorkerSession/mountWorkerAgent/makeWorkerUi）+ worker MCP
 *   subagent-report.ts   任务执行结算（runOneTask）+ 报告格式化 + 收件箱送达 + 上下文治理三档
 *   subagent-archive.ts  transcript 落盘 + 存档解析 + read_archive source + 归档入口 + 重启唤醒
 *   subagent-records.ts  WorkerSession 驻留类型 + 审计记录 + 用量聚合 + 休眠归档（家族叶子）
 *   subagent-status.ts   subagent_status 状态表文案（docs/32，家族六件套之六）
 * 保留在本文件：SubagentService 门面（subagentServiceFor）+ 非阻塞派发的同步段（tryStartWorker/
 * startWorker，docs/16：配额检查+登记原子完成，超限立即 ok:false 不排队）+ 控制入口
 * （applySubagentControl）+ 协调者提示的「子代理系统提示词说明」段（commonWorkerPromptSectionText）。
 * SA3 冲突治理（§5）：并发/累计配额在 tryStartWorker 同步段检查（docs/15 同轮并行派发天然串行
 * 经过，检查+占用不会插队）；req.scope 经 AgentDeps.writeScope 进工具上下文；中止/超时信号挂审批串行队列。
 * docs/16（完成即时送达，派发非阻塞化）：dispatch/followup 同步完成配额/寻址裁决并启动任务，立即
 * 返回受理回执；结算（完成/失败/打断/归档中止）后报告一律经 deliverToCoordinator 送进协调者收件箱
 * （与用户运行中插话共队列，FIFO 按完成顺序逐条开轮）。协调者感知子代理状态的唯一事实源是送达
 * 消息与派发回执文本——SSE 事件不进协调者历史。
 */
import { join } from "node:path";
import { THRESHOLDS } from "../config.ts";
import { readAgentsMd } from "../workspace.ts";
import type { ProviderConfig } from "../providers/store.ts";
import { Registry } from "../core/registry.ts";
import type { PromptSection, SectionContext, SubagentDispatch, SubagentRequest, SubagentResult, SubagentService } from "../core/types.ts";
import { assembleSystemPrompt } from "../core/sections.ts";
import type { SessionRuntime } from "../core/host.ts";
import type { SubagentRecord } from "./sessions.ts";
import { cfgOf, type SessionShell } from "./session-runtime.ts";
import { WORKER_ROLE_SECTION, createWorkerSession, makeWorkerUi, mountWorkerAgent, workerDirTag } from "./subagent-worker.ts";
import { deliverToCoordinator, followupContextReject, reportMessage, runOneTask } from "./subagent-report.ts";
import { reviveFollowup } from "./subagent-archive.ts";
import { archiveDormantRecord, finalizeArchive, finishSubagent, type SubagentControlIo, type WorkerSession } from "./subagent-records.ts";

// 家族公共面 re-export：消费方（session-runtime/lifecycle、web-sessions、测试与冒烟脚本）
// 的 import 路径保持在 ./subagents.ts 不变（沿 session-runtime 对 server.ts 的同款先例）。
export { WORKER_ROLE_SECTION, workerMcpToolsOf } from "./subagent-worker.ts";
export { archiveSourceOf } from "./subagent-archive.ts";
export { subagentStatusText } from "./subagent-status.ts"; // docs/32：状态表文案（家族六件套之六）
export type { WorkerSession, SubagentControlIo } from "./subagent-records.ts";

/** docs/20：协调者提示里的「子代理（worker）系统提示词说明」段正文——worker 共同系统
 *  提示的同构重放：与 mountWorkerAgent 的装配同源（ctx.promptSections 全量 + subagent-role；
 *  按派发参数附加的 ws.system 角色段/scope 不在其中）。render 惰性读 rt 当前状态——技能热更/
 *  worker MCP 首连（workerMcpToolsOf 触发 refreshSystemPrompt）后重建自动带新；无工作区
 *  （协调者未绑定时不可对话）返回 null 省段。 */
export function commonWorkerPromptSectionText(sh: SessionShell, rt: SessionRuntime): string | null {
  if (!rt.workspace) return null;
  // 与 toolDocsOf 同款行式：worker 受众系统工具的 summary 行（实例侧在 mountWorkerAgent
  // 注册后由 toolDocsOf 生成，这里按 def 直出——同一批 summary，排序规则一致）。
  // docs/32 三值受众：coordinator 与 front（ask_user 等）都不入 worker 提示词重放
  const toolDocs = sh.ctx.tools
    .all()
    .filter((d) => {
      const a = d.audience ?? "worker";
      return a !== "coordinator" && a !== "front" && d.summary;
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => `${d.name} —— ${d.summary}`);
  const sc: SectionContext = {
    workspaceRoot: rt.workspace.root,
    skills: rt.skills,
    mcpInstructions: rt.mcp.instructionsText(), // 首连前 null → 段省略（docs/20 首连热更）
    globalAgentsMd: readAgentsMd(sh.userDir),
    workspaceAgentsMd: readAgentsMd(rt.workspace.root),
    toolDocs,
    // worker 与父会话同提供方——视觉指引行同源（providers 为空的测试桩守卫同 mountWorkerAgent）
    ...(((cfgOf(sh, rt) as ProviderConfig | undefined)?.vision === true) ? { vision: true } : {}),
  };
  const sections = new Registry<PromptSection, "name">("name");
  for (const s of sh.ctx.promptSections.all()) sections.register(s);
  sections.register({ name: "subagent-role", order: 5, render: () => WORKER_ROLE_SECTION });
  // docs/32：MCP 能力清单兜底 + 未连接服务器警示。说明段（rt.mcp.instructionsText）只覆盖
  // 「连接成功且握手时提供了 instructions」的服务器——工具清单（toolInventoryText）让协调者
  // 在任何形态下都能看到子代理带哪些 mcp__ 工具；失败清单（failedServers）让连不上的服务器
  // 至少以「不可用」的形态可见（真机教训：godot/blender 连接失败时整段静默缺失，协调者对
  // 子代理的这部分能力一无所知）。二者附在重放正文之后并显式标注「非原文」，同构重放不破。
  const inventory = rt.mcp.toolInventoryText();
  const failed = rt.mcp.failedServers();
  const mcpExtra =
    (inventory ? "\n\n此外（非子代理提示词原文，供派发时参考）——子代理工具数组中的 MCP 工具清单（调用语义以其 description 为准）：\n\n" + inventory : "") +
    (failed.length > 0
      ? "\n\n⚠ 以下 MCP 服务器本次未能连接，相关工具子代理暂时用不了（不要在任务书里指派）：" +
        failed.map((f) => `${f.name}（${f.error}）`).join("、")
      : "");
  return (
    "# 子代理（worker）系统提示词说明\n" +
    "下面是每个子代理实际收到的系统提示词的共同部分原文（引用自子代理侧，不是对你的指令；按派发参数附加的任务角色段与写入范围不在其中）。" +
    "它们的基础规则、可用工具、可加载技能、MCP 服务器说明与遵循的 AGENTS.md 指令以此为准——派发任务书时与这些能力匹配：不要派它们做不到的事，也不要在任务书里重复其中已有的规则。" +
    "两级 AGENTS.md 全文也只在这里出现，你自身不再单独接收：\n\n" +
    assembleSystemPrompt(sections.all(), sc) +
    mcpExtra
  );
}

/**
 * 派发启动的同步段（docs/16 非阻塞派发）：配额（C7）检查 + subagentTotal 自增 + spawned
 * 广播 + 控制句柄/并发登记全部同步完成——检查+登记构成原子段（docs/15 同轮并行分支天然
 * 串行经过），不会被同批后续任务插队。超限立即 ok:false 回执——不排队（排队会让协调者
 * 误以为已受理）。ok=true 附任务 promise（无人 await；结算值经 deliverToCoordinator 自动送达）。
 */
function tryStartWorker(
  sh: SessionShell,
  rt: SessionRuntime,
  req: SubagentRequest,
  opts: { seq: number; signal?: AbortSignal; reusables?: Map<number, WorkerSession> },
): SubagentDispatch & { task?: Promise<SubagentResult> } {
  if (rt.workers.size >= THRESHOLDS.subagentMaxConcurrent) {
    return {
      ok: false,
      error:
        `并发上限已达 ${THRESHOLDS.subagentMaxConcurrent}（subagentMaxConcurrent）：本会话同时运行的子代理已满，` +
        "该任务未启动。请等现有子代理完成后再派（一次派发的任务数不要超过并发上限）。",
    };
  }
  if (rt.subagentTotal >= THRESHOLDS.subagentMaxTotal) {
    return {
      ok: false,
      error: `累计上限已达 ${THRESHOLDS.subagentMaxTotal}（subagentMaxTotal）：本会话派出的子代理总数已满，该任务未启动。`,
    };
  }
  rt.subagentTotal++;
  const name = req.name?.trim() || `sub-${opts.seq}`;
  // startWorker 的同步段（spawned 广播、句柄/闸门登记）在本次调用内同步执行完毕；装配→任务
  // 异步自行推进。catch 归一化意外拒绝（与历史服务层同口径：失败一律 ok:false，不抛错）。
  const task = startWorker(sh, rt, { ...req, name }, opts, opts.reusables ?? new Map<number, WorkerSession>()).catch(
    (e): SubagentResult => ({ ok: false, text: "", error: e instanceof Error ? e.message : String(e) }),
  );
  rt.workers.add(task); // 并发闸（C7）与中止级联（C8）的口径：rt.workers.size（同步登记防插队）
  void task.finally(() => rt.workers.delete(task)).catch(() => {}); // 结算释放并发槽；兜底吞意外拒绝（送达在服务层 then 按结果分流）
  return { ok: true, subId: opts.seq, name, task };
}

/**
 * 装配并运行一个 worker：阻塞至其完成（或超时/中止），返回 SubagentResult（首个任务的结果）。
 * 失败一律 ok:false 返回（不抛错）。docs/16 后仅为直调便利出口（单测/冒烟脚本）——正式工具
 * 路径走 subagentServiceFor.dispatch。docs/9：reusable=true 时 Agent 跨任务驻留（任务结束转
 * idle 待命，followup/archive 经 reusables Map 寻址）；一次性子代理与历史版本一致。
 */
export async function runWorker(
  sh: SessionShell,
  rt: SessionRuntime,
  req: SubagentRequest,
  opts: { seq: number; signal?: AbortSignal; reusables?: Map<number, WorkerSession> },
): Promise<SubagentResult> {
  const started = tryStartWorker(sh, rt, req, opts);
  if (!started.ok) return { ok: false, text: "", error: started.error };
  return await started.task!;
}

/** 装配 worker 并执行首个任务（tryStartWorker 配额通过后调用；docs/17 起装配三段共用）：
 *  spawned 广播+句柄注册（createWorkerSession）→ 构造期参数捕获（effort/scope/system，
 *  transcript meta 用）→ Agent 装配（mountWorkerAgent）→ runOneTask。 */
async function startWorker(
  sh: SessionShell,
  rt: SessionRuntime,
  req: SubagentRequest,
  opts: { seq: number; signal?: AbortSignal },
  reusables: Map<number, WorkerSession>,
): Promise<SubagentResult> {
  const name = req.name?.trim() || `sub-${opts.seq}`;
  const description = req.description?.trim() || undefined;
  const reusable = req.reusable === true;
  const { signal } = opts;
  const parentSpill = sh.sessions.spillDir(rt.id);
  const ws = createWorkerSession(
    sh,
    rt,
    {
      seq: opts.seq,
      name,
      ...(description ? { description } : {}),
      reusable,
      ...(parentSpill ? { spillDir: join(parentSpill, workerDirTag(opts.seq, name)) } : {}),
    },
    reusables,
    true,
  );
  if (req.effort) ws.effort = req.effort;
  if (req.scope && req.scope.length > 0) ws.scope = req.scope;
  if (req.system?.trim()) ws.system = req.system;
  try {
    const worker = await mountWorkerAgent(sh, rt, ws, makeWorkerUi(sh, rt, ws));
    // 需求三续（docs/8 第三棒）：liveMessages 已在句柄上（闭包读 worker）；docs/9：驻留回填
    ws.agent = worker;
    if (ws.archiveRequested) {
      // 装配窗口收到归档请求：不执行首任务，直接归档收尾（spawned ⟹ archived 守恒）
      const res: SubagentResult = { ok: false, text: "", error: "任务未开始：派发后即被归档", subId: opts.seq, reusable: true, name };
      ws.lastOk = false;
      ws.lastError = res.error;
      finalizeArchive(sh, rt, ws, reusables);
      return res;
    }
  } catch (e) {
    // 装配失败也要保证 spawned ⟹ 收尾（一次性=error 记录/事件；可复用=直接归档带错误）
    const res: SubagentResult = {
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
      subId: opts.seq,
    };
    if (reusable) {
      ws.lastOk = false;
      ws.lastError = res.error;
      res.reusable = true;
      res.name = name;
      finalizeArchive(sh, rt, ws, reusables);
    } else {
      rt.activeSubagents.delete(opts.seq);
      finishSubagent(sh, rt, { subId: opts.seq, name, ...(description ? { description } : {}) }, res, undefined);
    }
    return res;
  }
  // 首任务执行与收尾（docs/9：一次性=done/error 即自动归档；可复用=idle 待命）
  return runOneTask(sh, rt, ws, req.task, { timeoutMs: req.timeoutMs, description, first: true }, signal, reusables);
}

/** 控制入口的唯一实现（W2-S；docs/18 起暂停/恢复退役）：按 subId（优先）或 name 匹配
 *  活动子代理并施加 stop（打断当前任务，同名者全部生效）或 archive（归档可复用子代理
 *  ——空闲立即归档，执行中=中止当前任务后归档；一次性子代理不支持手动归档）。idle 态没有
 *  任务在执行，无 stop 对象。docs/35 真机待办4：archive 无活动匹配时回落到休眠待命记录
 *  （archiveDormantRecord）——不再要求先复活才能归档。两处消费——createRuntime 注入协调者
 *  工具的 deps.subagentControl、web-sessions 的 /api/subagent/control 路由。返回面向调用方
 *  （模型/HTTP）的结果文案；miss 时附活动清单供自纠错。 */
export function applySubagentControl(
  rt: SessionRuntime,
  target: { name?: string; subId?: number },
  action: "stop" | "archive",
  via: "ui" | "model" = "model",
  io?: SubagentControlIo,
): string {
  const live = [...rt.activeSubagents.values()];
  const matches =
    target.subId !== undefined
      ? live.filter((a) => a.subId === target.subId)
      : target.name !== undefined
        ? live.filter((a) => a.name === target.name)
        : [];
  if (matches.length === 0) {
    // docs/35 真机待办4：归档回落休眠待命记录（重启后实例不在线、记录仍在的 idle 可复用）
    if (action === "archive") {
      const dormant = rt.subagents.filter((r) => r.reusable && r.state === "idle" && (target.subId !== undefined ? r.subId === target.subId : r.name === target.name));
      if (dormant.length > 0) return dormant.map((r) => archiveDormantRecord(rt, r, via, io)).join("\n");
    }
    const list = live
      .map((a) => `${a.name}#${a.subId}${a.status === "idle" ? "（空闲待命）" : ""}`)
      .join("、");
    return `没有匹配的活动子代理（指定：${target.subId !== undefined ? `subId=${target.subId}` : `name=${target.name}`}）。当前活动：${list || "无"}。只能打断正在运行的子代理、归档空闲待命的可复用子代理，已归档的不可再操作。`;
  }
  if (action === "archive") {
    const hits = matches.filter((m) => m.reusable);
    const skipped = matches.filter((m) => !m.reusable);
    if (hits.length === 0) {
      return `匹配到的子代理（${matches.map((m) => `${m.name}#${m.subId}`).join("、")}）是一次性子代理：任务结束即自动归档，无需手动归档（运行中如需终止可打断它）。`;
    }
    const msgs = hits.map((m) => m.requestArchive?.(via) ?? `错误：子代理 ${m.name}#${m.subId} 不支持归档。`);
    if (skipped.length > 0) {
      msgs.push(`（${skipped.map((m) => `${m.name}#${m.subId}`).join("、")} 为一次性子代理已跳过：任务结束即自动归档。）`);
    }
    return msgs.join("\n");
  }
  const acting = matches.filter((m) => m.status !== "idle");
  if (acting.length === 0) {
    return `匹配的子代理当前空闲待命（没有正在执行的任务），没有可打断的对象。`;
  }
  for (const m of acting) m.stop(via); // docs/18：打断即终结；via="ui" 时状态通知自动送达协调者收件箱
  const head = `已打断子代理：${acting.map((m) => `${m.name}#${m.subId}`).join("、")}。`;
  const tail = acting.every((m) => m.reusable)
    ? "可复用子代理转为空闲待命（保留上下文）——继续该方向的工作用 agent_followup 发新任务书（没有恢复机制，被打断的任务不会自动续跑）。"
    : "一次性子代理已随之归档；可复用子代理转为空闲待命（保留上下文），继续工作用 agent_followup 发新任务书。";
  return head + "进行中的 LLM 请求与工具执行（含 pwsh 进程）已当场中止，已完成的进度保留在历史、半截内容作废。" + tail;
}

/**
 * 子代理服务（按会话实例化，P8 seam 的 v2 实现）：默认名自动编号 sub-1/sub-2。
 * server.ts bootstrap 经 ctx.subagent 挂载；createRuntime 对 kind=coordinator 注入给
 * agent_task/agent_followup。docs/16：两方法都是**非阻塞派发**——同步完成配额/寻址裁决
 * 并启动，立即返回 SubagentDispatch 回执；结算（完成/失败/打断/归档中止）后报告一律经
 * deliverToCoordinator 自动送达协调者（异常归一化 ok:false，不抛错）。docs/9：reusables Map
 * 持有本会话存活的可复用 worker 驻留上下文；seq 惰性从存档记录最大 subId 续期（防撞 subId）。
 */
export function subagentServiceFor(sh: SessionShell, rt: SessionRuntime): SubagentService {
  let seq: number | null = null;
  const reusables = new Map<number, WorkerSession>();
  // 结算送达（docs/16）：任务 promise 与派发调用方解耦——结算值（含兜底归一化的意外拒绝）
  // 一律格式化为报告消息送进协调者收件箱（空闲立即开轮，忙碌排队轮末排空）。
  const deliver = (p: Promise<SubagentResult>, name: string): void => {
    void p.then(
      // docs/18：用户打断的结算不送达失败报告（状态通知/工具文案已覆盖同一信息，避免一次操作两条消息）
      (res) => {
        if (!res.stopped) deliverToCoordinator(sh, rt, reportMessage(res, name));
      },
      (e: unknown) =>
        deliverToCoordinator(sh, rt, reportMessage({ ok: false, text: "", error: e instanceof Error ? e.message : String(e) }, name)),
    );
  };
  return {
    dispatch: (req, signal) => {
      seq = (seq ?? rt.subagents.reduce((m, r) => Math.max(m, r.subId), 0)) + 1;
      const started = tryStartWorker(sh, rt, req, { seq, signal, reusables });
      if (!started.ok) return started;
      deliver(started.task!, started.name);
      return { ok: true, subId: started.subId, name: started.name };
    },
    followup: (target, freq, signal) => {
      const found = findReusable(rt, reusables, target);
      if ("error" in found) return { ok: false, error: found.error };
      // docs/17：待命记录仍在、实例不在线、有过程存档 → 自动唤醒（同 subId 复活后追加任务）
      if ("revivable" in found) return reviveFollowup(sh, rt, reusables, found.revivable, freq, signal, deliver);
      const ws = found;
      if (ws.tasks >= THRESHOLDS.subagentMaxTasks) {
        return {
          ok: false,
          error: `任务次数上限已达 ${THRESHOLDS.subagentMaxTasks}（subagentMaxTasks）：子代理 ${ws.name}#${ws.subId} 的累计任务数已满。请用 archive_subagent 归档后重新 agent_task 派发。`,
        };
      }
      // docs/10 R1：上下文门槛（默认 35%）——上下文过长的子代理继续任务容易产生幻觉，
      // 服务端硬闸拒绝（不依赖模型自觉读数）；指引归档重派 + read_archive 存档接续。
      if (ws.contextPct !== undefined && ws.contextPct >= THRESHOLDS.subagentFollowupContextPct) {
        return { ok: false, error: followupContextReject(ws.name, ws.subId, ws.contextPct) };
      }
      if (rt.workers.size >= THRESHOLDS.subagentMaxConcurrent) {
        return {
          ok: false,
          error: `并发上限已达 ${THRESHOLDS.subagentMaxConcurrent}（subagentMaxConcurrent）：本会话同时运行的子代理已满，该任务未启动。请等现有子代理完成后再派。`,
        };
      }
      const desc = freq.description?.trim();
      if (desc) ws.active.summary = desc; // 抽屉行摘要随最近任务更新
      const p = runOneTask(sh, rt, ws, freq.task, { timeoutMs: freq.timeoutMs, description: desc, first: false }, signal, reusables).catch(
        (e): SubagentResult => ({ ok: false, text: "", error: e instanceof Error ? e.message : String(e) }),
      );
      rt.workers.add(p); // 并发闸（C7）口径；runOneTask 起跑（task 事件）已在同步段完成
      void p.finally(() => rt.workers.delete(p)).catch(() => {});
      deliver(p, ws.name);
      return { ok: true, subId: ws.subId, name: ws.name };
    },
  };
}

/** followup 目标解析结果（docs/17 起结构化）：在线空闲实例 / 可唤醒记录（记录仍在、
 *  实例不在线、有过程存档——idle 休眠与 archived 归档同通道自动唤醒复活，docs/41） / 明确错误文案。 */
type FindReusableResult = WorkerSession | { revivable: SubagentRecord } | { error: string };

/** followup 目标解析（docs/9；docs/17 唤醒 / docs/41 归档复活）：按 subId（优先）或 name
 *  （存活可复用中必须唯一）定位空闲待命的 WorkerSession；各种不可派状态（不存在/同名歧义/
 *  执行中）各给明确文案；「记录在、实例不在线」的子代理（idle 休眠或 archived 归档，可复用
 *  与一次性一视同仁）有存档即返回 revivable（自动唤醒复活，一次性转正为可复用），无存档才
 *  报失效。归档过的驻留已从 Map 与 activeSubagents 注销——这里查到的在线的都是存活的。 */
function findReusable(
  rt: SessionRuntime,
  reusables: Map<number, WorkerSession>,
  target: { name?: string; subId?: number },
): FindReusableResult {
  const alive = [...reusables.values()].filter((w) => rt.activeSubagents.get(w.subId) === w.active);
  const cands =
    target.subId !== undefined
      ? alive.filter((w) => w.subId === target.subId)
      : target.name !== undefined
        ? alive.filter((w) => w.name === target.name)
        : [];
  if (cands.length === 0) {
    const rec =
      target.subId !== undefined
        ? rt.subagents.find((r) => r.subId === target.subId)
        : target.name !== undefined
          ? [...rt.subagents].reverse().find((r) => r.name === target.name)
          : undefined;
    if (rec) {
      if (rec.state === "idle" || rec.state === "archived") {
        // docs/17 待命唤醒 / docs/41 归档复活：有过程存档即可唤醒——可复用原样延续；
        // 一次性转正为可复用（reviveFollowup 创建即 reusable=true）。超时/打断的半成品由此接续
        if (rec.transcript) return { revivable: rec };
        return {
          error:
            `子代理 ${rec.name}#${rec.subId} 的记录仍在，但其运行实例已不在线，且没有可唤醒的过程存档（未落盘成功或已被清理）。` +
            `请用 agent_task 重新派发；任务书可让它先用 read_archive（subId=${rec.subId}）读过程存档接续上下文（存档也不可用时无法接续）。`,
        };
      }
      return { error: `子代理 ${rec.name}#${rec.subId} 状态异常（${rec.state}），请用 agent_task 重新派发。` };
    }
    const idleList = alive.filter((w) => w.active.status === "idle").map((w) => `${w.name}#${w.subId}`).join("、");
    return {
      error: `没有找到这个子代理（指定：${target.subId !== undefined ? `subId=${target.subId}` : `name=${target.name}`}）。当前空闲待命的可复用子代理：${idleList || "无"}。`,
    };
  }
  if (cands.length > 1) {
    return { error: `同名可复用子代理有 ${cands.length} 个（${cands.map((w) => `${w.name}#${w.subId}`).join("、")}）——请用 subId 精确指定。` };
  }
  const ws = cands[0]!;
  if (ws.active.status !== "idle") {
    return {
      error: `子代理 ${ws.name}#${ws.subId} 正在执行任务——agent_followup 只在任务之间使用；它当前任务的报告完成后会自动送达，届时再追加新任务（需要立即终止它时用 stop_subagent 打断，它随即转空闲待命）。`,
    };
  }
  return ws;
}
