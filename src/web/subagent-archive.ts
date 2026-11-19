/**
 * 子代理家族五件套之四：存档与唤醒（docs/21 §3.1 自 subagents.ts 拆出，纯移动）。
 * docs/6 P3 方案 A + docs/17：worker 全程 transcript 落盘（主对话 SessionData 同构格式，
 * kind:"subagent" + subagent 元数据块——含复活所需的 scope/effort/system 构造期参数）、
 * 新旧两种存档格式的宽容解析、read_archive 工具的存档解析接缝（archiveSourceOf，主会话
 * 与全部 worker 同一闭包）、归档入口（requestArchiveWorker——句柄 requestArchive 的实现：
 * 执行中=中止当前任务后收尾归档；idle=立即；装配中=标记挂起）、重启唤醒（reviveFollowup
 * ——followup 命中「待命记录仍在、实例不在线、有存档」时从存档回读历史按 meta 重装 Agent）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { THRESHOLDS } from "../config.ts";
import { AUTO_DELIVERY_PREFIXES } from "../core/events.ts";
import type { Agent } from "../agent.ts";
import type { ChatMessage } from "../llm/provider.ts";
import type { SessionRuntime } from "../core/host.ts";
import type { SubagentDispatch, SubagentFollowup, SubagentResult, SystemToolDeps } from "../core/types.ts";
import type { SessionData, SubagentArchiveMeta, SubagentRecord } from "./sessions.ts";
import type { SessionShell } from "./session-runtime.ts";
import { finalizeArchive, type WorkerSession } from "./subagent-records.ts";
import { deliverToCoordinator, followupContextReject, runOneTask } from "./subagent-report.ts";
import { createWorkerSession, makeWorkerUi, mountWorkerAgent, workerDirTag } from "./subagent-worker.ts";

/** 存档文件宽容解析（docs/17）：新格式 = SessionData 同构（kind:"subagent"，带 subagent 元
 *  数据），旧格式 = 裸 {messages}（docs/6 P3 原版）。messages 非法/JSON 损坏返回 null。 */
function parseArchive(raw: string): { messages: ChatMessage[]; meta?: SubagentArchiveMeta } | null {
  try {
    const d = JSON.parse(raw) as Partial<SessionData> & { messages?: unknown };
    if (!d || !Array.isArray(d.messages)) return null;
    return {
      messages: d.messages as ChatMessage[],
      ...(d.subagent && typeof d.subagent === "object" ? { meta: d.subagent } : {}),
    };
  } catch {
    return null;
  }
}

/** worker 全程 transcript 落盘（docs/6 P3 方案 A；docs/17 起为主对话 SessionData 同构格式）：
 *  kind:"subagent" + subagent 元数据块（累计统计 + 复活所需的 scope/effort/system 构造期
 *  参数）+ messages（标准 ChatMessage[]，含思考块与工具调用/结果；不含系统提示——按工作区
 *  可重建，省一份重复），另带 id/title/updatedAt/workspace/messageCount/runMs/totals 主档
 *  同名字段。同一形状三处消费一个口径：/api/subagent-transcript（前端抽屉）、read_archive
 *  （存档注入）、followup 唤醒（历史回读 + 构造期参数还原）。写到 worker 私有 spill 子目录
 *  的 transcript.json（目录随会话删除连带清理）；返回相对 spill/<sessionId>/ 的路径供
 *  SubagentRecord/SubagentResult/SSE 事件携带。失败返回 undefined。 */
export function dumpTranscript(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession, state: "idle" | "archived"): string | undefined {
  const worker = ws.agent;
  if (!worker || !ws.spillDir) return undefined;
  try {
    mkdirSync(ws.spillDir, { recursive: true });
    const messages = worker.messages.filter((m) => m.role !== "system");
    const u = ws.usage;
    const data: SessionData = {
      id: rt.id,
      title: ws.description ? `${ws.name}·${ws.description}` : ws.name,
      updatedAt: new Date().toISOString(),
      workspace: rt.workspace?.root ?? "",
      messageCount: messages.length,
      kind: "subagent",
      ...(ws.effort ? { effort: ws.effort } : {}),
      ...(ws.elapsedMs > 0 ? { runMs: ws.elapsedMs } : {}),
      totals: {
        prompt: u.prompt,
        completion: u.completion,
        ...(u.cacheHit ? { cacheHit: u.cacheHit } : {}),
        ...(u.reasoning ? { reasoning: u.reasoning } : {}),
      },
      subagent: archiveMetaOf(ws, state),
      messages,
    };
    writeFileSync(join(ws.spillDir, "transcript.json"), JSON.stringify(data, null, 2), "utf8");
    return join(ws.dirTag, "transcript.json");
  } catch {
    return undefined;
  }
}

/** 存档 meta 块（docs/17）：累计统计与 SubagentRecord 同口径（ok/error 属最近任务故不入档
 *  ——记录为准）+ 构造期参数（scope/effort/system，唤醒重装 Agent 用）。 */
function archiveMetaOf(ws: WorkerSession, state: "idle" | "archived"): SubagentArchiveMeta {
  const u = ws.usage;
  return {
    subId: ws.subId,
    name: ws.name,
    ...(ws.description ? { description: ws.description } : {}),
    reusable: ws.active.reusable === true,
    tasks: ws.tasks,
    ...(ws.rounds > 0 ? { rounds: ws.rounds } : {}),
    ...(u.prompt > 0 || u.completion > 0
      ? {
          usage: {
            prompt: u.prompt,
            completion: u.completion,
            ...(u.reasoning ? { reasoning: u.reasoning } : {}),
            ...(u.cacheHit ? { cacheHit: u.cacheHit } : {}),
          },
        }
      : {}),
    ...(ws.contextPct !== undefined ? { contextPct: ws.contextPct } : {}),
    ...(ws.elapsedMs > 0 ? { elapsedMs: ws.elapsedMs } : {}),
    state,
    ...(ws.effort ? { effort: ws.effort } : {}),
    ...(ws.scope && ws.scope.length > 0 ? { scope: ws.scope } : {}),
    ...(ws.system?.trim() ? { system: ws.system } : {}),
  };
}

/** 归档入口（docs/9，句柄 requestArchive 的实现）：执行中 → 中止当前任务并在其收尾时
 *  归档（pendingArchive 标记）；idle → 立即归档；装配中（Agent 未就绪）→ 标记挂起，装配
 *  完成直接归档不执行任务。via（docs/11 W1）："ui"=界面按钮——空闲路径的归档是协调者
 *  看不见的异常变动，向其收件箱送达状态通知（"model"=工具路径，返回文案本身已抵达协调者）。
 *  返回面向调用方的结果文案。 */
export function requestArchiveWorker(
  sh: SessionShell,
  rt: SessionRuntime,
  ws: WorkerSession,
  reusables: Map<number, WorkerSession>,
  via: "ui" | "model" = "model",
): string {
  if (ws.cur) {
    ws.cur.pendingArchive = true;
    ws.cur.ctl.abort();
    return `已请求归档：子代理 ${ws.name}#${ws.subId} 的当前任务将被中止，并在其结束后归档（归档后仍可用 agent_followup 从存档唤醒复活继续）。`;
  }
  if (!ws.agent) {
    ws.archiveRequested = true; // 装配窗口：startWorker 装配完成后直接归档收尾
    return `已请求归档：子代理 ${ws.name}#${ws.subId} 尚在装配，将不执行任务直接归档（归档后仍可用 agent_followup 从存档唤醒复活继续）。`;
  }
  const archiveNotice =
    ws.transcript !== undefined
      ? `可复用子代理 ${ws.name}#${ws.subId} 已被用户归档（需要继续该方向的工作时用 agent_followup 从存档唤醒复活，或 agent_task 重新派发——任务书可让新实例先用 read_archive（subId=${ws.subId}）读过程存档接续上下文 [[过程档案#${ws.subId}]]）。`
      : `可复用子代理 ${ws.name}#${ws.subId} 已被用户归档（无过程存档，唤醒复活不可用；需要继续该方向的工作时用 agent_task 重新派发）。`;
  finalizeArchive(sh, rt, ws, reusables);
  if (via === "ui") deliverToCoordinator(sh, rt, `${AUTO_DELIVERY_PREFIXES.status} ${archiveNotice}`);
  return `已归档子代理：${ws.name}#${ws.subId}（共完成 ${ws.tasks} 次任务）。归档不是终结：需要继续时用 agent_followup 从存档唤醒复活，或 read_archive 查看过程后重新派发。`;
}

/**
 * 唤醒/复活（docs/17 重启唤醒 + docs/41 归档复活）：followup 命中「记录仍在、运行实例
 * 不在线、有过程存档」的子代理时走此路径（idle 休眠与 archived 归档同通道；一次性转正
 * 为可复用）——从存档回读完整历史（Agent.restore 与主对话恢复同口径），按存档 meta
 * 重装 Agent（scope/effort/system 沿用首次派发；旧格式存档无 meta 时继承会话缺省），同
 * subId 复活后执行追加任务（task 事件起跑、报告自动送达，与在线 followup 完全同口径）。
 * 同步段完成存档读取/闸门复查/句柄登记（防插队）；装配与任务异步推进；唤醒装配失败按
 * startWorker 同款归档收尾。返回受理回执（调用方=SubagentService.followup）。
 */
export function reviveFollowup(
  sh: SessionShell,
  rt: SessionRuntime,
  reusables: Map<number, WorkerSession>,
  rec: SubagentRecord,
  freq: SubagentFollowup,
  signal: AbortSignal | undefined,
  deliver: (p: Promise<SubagentResult>, name: string) => void,
): SubagentDispatch {
  // 闸门复查（与在线 followup 同口径，先于存档读取——不读注定被拒的档；数字用存档记录的累计值）
  if ((rec.tasks ?? 0) >= THRESHOLDS.subagentMaxTasks) {
    return {
      ok: false,
      error: `任务次数上限已达 ${THRESHOLDS.subagentMaxTasks}（subagentMaxTasks）：子代理 ${rec.name}#${rec.subId} 的累计任务数已满。请用 archive_subagent 归档后重新 agent_task 派发。`,
    };
  }
  if (rec.contextPct !== undefined && rec.contextPct >= THRESHOLDS.subagentFollowupContextPct) {
    return { ok: false, error: followupContextReject(rec.name, rec.subId, rec.contextPct) };
  }
  if (rt.workers.size >= THRESHOLDS.subagentMaxConcurrent) {
    return {
      ok: false,
      error: `并发上限已达 ${THRESHOLDS.subagentMaxConcurrent}（subagentMaxConcurrent）：本会话同时运行的子代理已满，该任务未启动。请等现有子代理完成后再派。`,
    };
  }
  // 存档读取（同步段）：宽容解析新旧两种格式（docs/17）；读取失败降级为指引重派文案
  const parentSpill = sh.sessions.spillDir(rt.id);
  let archive: ReturnType<typeof parseArchive> = null;
  if (parentSpill && rec.transcript) {
    try {
      archive = parseArchive(readFileSync(join(parentSpill, rec.transcript), "utf8"));
    } catch {
      archive = null;
    }
  }
  if (!archive || archive.messages.length === 0) {
    return {
      ok: false,
      error:
        `子代理 ${rec.name}#${rec.subId} 的待命记录仍在、运行实例不在线，但自动唤醒失败（过程存档读取失败或为空）。` +
        `请用 agent_task 重新派发；任务书可让它先用 read_archive（subId=${rec.subId}）读过程存档接续上下文（同样失败则无法接续）。`,
    };
  }
  const desc = freq.description?.trim();
  const ws = createWorkerSession(
    sh,
    rt,
    {
      seq: rec.subId,
      name: rec.name,
      ...(rec.description ? { description: rec.description } : {}),
      reusable: true,
      ...(parentSpill ? { spillDir: join(parentSpill, workerDirTag(rec.subId, rec.name)) } : {}),
    },
    reusables,
    false, // 唤醒不广播 spawned——抽屉行已存在，随后 runOneTask 的 task 事件起跑翻行
  );
  // 存档回填（docs/17）：累计统计/最近任务结果/构造期参数——唤醒后的实例即「存档时刻的那个它」
  ws.tasks = rec.tasks ?? 0;
  ws.rounds = rec.rounds ?? 0;
  ws.usage = {
    prompt: rec.usage?.prompt ?? 0,
    completion: rec.usage?.completion ?? 0,
    reasoning: rec.usage?.reasoning ?? 0,
    cacheHit: rec.usage?.cacheHit ?? 0,
  };
  ws.elapsedMs = rec.elapsedMs ?? 0;
  ws.contextPct = rec.contextPct;
  ws.lastOk = rec.ok;
  ws.lastError = rec.ok ? undefined : rec.error;
  ws.transcript = rec.transcript;
  ws.active.tasks = ws.tasks;
  if (archive.meta?.effort) ws.effort = archive.meta.effort;
  if (archive.meta?.scope && archive.meta.scope.length > 0) ws.scope = archive.meta.scope;
  if (archive.meta?.system?.trim()) ws.system = archive.meta.system;
  if (desc) ws.active.summary = desc; // 抽屉行摘要随最近任务更新
  const p = (async (): Promise<SubagentResult> => {
    let worker: Agent;
    try {
      worker = await mountWorkerAgent(sh, rt, ws, makeWorkerUi(sh, rt, ws));
    } catch (e) {
      // 唤醒装配失败：与 startWorker 同款归档收尾（记录定格 archived，不再可派）
      const why = e instanceof Error ? e.message : String(e);
      ws.lastOk = false;
      ws.lastError = `唤醒装配失败：${why}`;
      finalizeArchive(sh, rt, ws, reusables);
      return { ok: false, text: "", error: ws.lastError, subId: rec.subId, reusable: true, name: rec.name };
    }
    ws.agent = worker;
    worker.restore(archive.messages); // 系统提示按当前工作区重建，历史逐条回读（主对话恢复同款）
    if (ws.archiveRequested) {
      // 唤醒装配窗口收到归档请求：不执行任务，直接归档收尾
      const res: SubagentResult = { ok: false, text: "", error: "任务未开始：唤醒后即被归档", subId: rec.subId, reusable: true, name: rec.name };
      ws.lastOk = false;
      ws.lastError = res.error;
      finalizeArchive(sh, rt, ws, reusables);
      return res;
    }
    return await runOneTask(sh, rt, ws, freq.task, { timeoutMs: freq.timeoutMs, description: desc, first: false }, signal, reusables);
  })().catch((e): SubagentResult => ({ ok: false, text: "", error: e instanceof Error ? e.message : String(e), subId: rec.subId, reusable: true, name: rec.name }));
  rt.workers.add(p); // 并发闸（C7）口径；句柄已在同步段登记
  void p.finally(() => rt.workers.delete(p)).catch(() => {});
  deliver(p, rec.name);
  return { ok: true, subId: rec.subId, name: rec.name };
}

/**
 * 存档解析接缝（docs/17）：SystemToolDeps.archiveSource 的会话级实现——主会话 toolDeps
 * （createRuntime 注入，普通会话读旧会话档）与全部 worker 的 workerDeps（mountWorkerAgent
 * 注入，接续已归档子代理）共用同一闭包。subId=本会话子代理过程存档（rt.subagents 记录 →
 * spill transcript 文件，路径收口防穿越）；sessionId=主对话会话档（SessionStore.load，
 * UUID 校验内建）。参数二选一；解析失败/缺参附可用存档清单供自纠错。返回面向模型的标签行
 * 与原始 messages（渲染成可读文本在工具层）。
 */
export function archiveSourceOf(sh: SessionShell, rt: SessionRuntime): NonNullable<SystemToolDeps["archiveSource"]> {
  const listText = (): string => {
    const items = rt.subagents
      .filter((r) => r.transcript)
      .map((r) => `${r.name}#${r.subId}${r.tasks ? `（${r.tasks} 次任务）` : ""}`)
      .join("、");
    return items || "无";
  };
  return (q) => {
    if (q.subId !== undefined && q.subId !== null && q.sessionId !== undefined && q.sessionId !== null) {
      return { ok: false, error: "subId 与 sessionId 只能二选一：子代理过程存档用 subId，主对话记录用 sessionId。" };
    }
    if (q.subId !== undefined && q.subId !== null) {
      const rec = rt.subagents.find((r) => r.subId === q.subId);
      if (!rec?.transcript) {
        return {
          ok: false,
          error: `本会话没有子代理 #${q.subId} 的过程存档。本会话可用的存档：${listText()}；也可改传 sessionId 读主对话记录。`,
        };
      }
      const base = sh.sessions.spillDir(rt.id);
      const file = base ? resolve(base, rec.transcript) : null;
      const rel = file && base ? relative(base, file) : "";
      if (!file || !base || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: "存档路径不合法。" };
      let parsed: ReturnType<typeof parseArchive> = null;
      try {
        parsed = parseArchive(readFileSync(file, "utf8"));
      } catch {
        parsed = null;
      }
      if (!parsed) return { ok: false, error: `子代理 ${rec.name}#${rec.subId} 的过程存档读取失败或已损坏。` };
      return {
        ok: true,
        label: `过程存档 · 子代理 ${rec.name}#${rec.subId}${rec.tasks ? `（共 ${rec.tasks} 次任务）` : ""}`,
        messages: parsed.messages,
      };
    }
    if (q.sessionId) {
      const data = sh.sessions.load(q.sessionId); // UUID 校验 + 存在性 + messages 数组校验内建
      if (!data) return { ok: false, error: `会话 ${q.sessionId} 不存在或已损坏（sessionId 是会话列表里那条对话的 UUID）。` };
      return {
        ok: true,
        label: `会话存档 · ${data.title || "（无标题）"}（${data.messages.length} 条消息）`,
        messages: data.messages,
      };
    }
    return {
      ok: false,
      error: `需要 subId（本会话子代理过程存档）或 sessionId（主对话记录）之一。本会话可用的子代理存档：${listText()}。`,
    };
  };
}
