/**
 * 会话运行态装配（模块化架构重构 §4.10，自 server.ts 迁出；web 壳的一部分，非模块）：
 * createRuntime 消费 ctx.tools/providerFormats/mcpTransports/skillSources/promptSections
 * 完成每会话装配；makeUi/doAsk 是 Agent → SSE 的推流接缝。
 * 全部共享单例收进 SessionShell（由 server.ts 构造并持有），本文件所有函数显式收 sh
 * ——与 store.ts 的显式参数风格一致，模块间无隐式全局。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { COMPACTION_PRESSURE, COMPACTION_SUMMARY_MAX_CHARS, DEFAULT_CONTEXT_LENGTH, EFFORT_OPTIONS, IMAGE_RULES, SANDBOX_OPTIONS, SANDBOX_ALIASES, SUBAGENT_ARCHIVE_CONTEXT_PCT, SUBAGENT_FOLLOWUP_CONTEXT_PCT, SUBAGENT_WARN_CONTEXT_PCT, TOOL_EVENT_ARGS_MAX_CHARS } from "../config.ts";
import { COMPACTION_PROMPT } from "../compaction.ts";
import { pruneToolResult } from "../tools/prune.ts";
import type { ChatMessage, LLMProvider, UsageBreakdown, UsageInfo } from "../llm/provider.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { Agent, type AgentUi } from "../agent.ts";
import { createWorkspace, readAgentsMd, type Workspace } from "../workspace.ts";
import { McpManager, loadMcpConfig } from "../mcp/manager.ts";
import { createProvider, normalizeEffort, type ProviderConfig, type ProviderFile } from "../providers/store.ts";
import type { SessionData, SessionStore } from "./sessions.ts";
import { restoreStoredMessages, toStoredMessages, type AttachmentStore } from "./attachments.ts";
import {
  askWithMode,
  auditAsked,
  auditDecided,
  auditStats,
  normalizeAskMode,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuditEvent,
} from "../approval/types.ts";
import { normalizeSandboxMode } from "../sandbox/types.ts";
import { scanSkills, skillDirsOf, type SkillInfo } from "../core/skills.ts";
import { AUTO_DELIVERY_PREFIXES, SSE_EVENTS, type SseEventName } from "../core/events.ts";
import type { HarnessContext } from "../core/context.ts";
import { createFileLedger } from "../core/file-tools.ts";
import { Registry } from "../core/registry.ts";
import type { AskUserAnswer, PromptSection, SystemToolDeps } from "../core/types.ts";
import type { RuntimeSettings, SessionRuntime } from "../core/host.ts";

/**
 * 壳侧共享单例袋：server.ts 构造一份，本文件与 session-lifecycle.ts 的函数
 * 以首参显式接收。runtimes/viewId/viewSeq/recentWorkspaces 是可变状态，改经
 * 属性赋值（shell.viewId = …），不再有模块级 let。
 */
export interface SessionShell {
  ctx: HarnessContext;
  sessions: SessionStore;
  /** 图片附件内容寻址库（docs/33）：会话档只存 sha256 引用、字节落 attachments/v1 一份 */
  attachments: AttachmentStore;
  providerFile: ProviderFile;
  runtimes: Map<string, SessionRuntime>;
  viewId: string;
  viewSeq: number;
  recentWorkspaces: string[];
  workspacesFile: string;
  userDir: string;
  globalMcpFile: string;
  sandboxTmpRoot: string;
  broadcast(event: SseEventName, data: unknown): void;
}

const zeroBreakdown = (): UsageBreakdown => ({
  systemPrompt: 0,
  skills: 0,
  systemTools: 0,
  mcp: 0,
  messages: 0,
  other: 0,
});

export const viewRt = (sh: SessionShell): SessionRuntime =>
  sh.runtimes.get(sh.viewId) ?? [...sh.runtimes.values()][0]!;

/** 完整参数 → tool 事件载荷（docs/28 P2-2）：截 TOOL_EVENT_ARGS_MAX_CHARS + 截断标记。
 *  makeUi（主对话）与 makeWorkerUi（子代理）共用——前端展开体渲染（write 内容/edit diff）
 *  的数据源；截断后前端 JSON.parse 失败会自动退回 preview 展示（toolinfo 降级路径）。 */
export function clipToolArgs(s: string): string {
  return s.length <= TOOL_EVENT_ARGS_MAX_CHARS ? s : s.slice(0, TOOL_EVENT_ARGS_MAX_CHARS) + "…（参数过长已截断）";
}

export const busyIds = (sh: SessionShell): string[] =>
  [...sh.runtimes.values()].filter((rt) => rt.busy).map((rt) => rt.id);

export const providerCfgById = (sh: SessionShell, id: string): ProviderConfig =>
  sh.providerFile.data.providers.find((p) => p.id === id) ??
  sh.providerFile.data.providers.find((p) => p.id === sh.providerFile.data.active) ??
  sh.providerFile.data.providers[0];

export const cfgOf = (sh: SessionShell, rt: SessionRuntime): ProviderConfig =>
  providerCfgById(sh, rt.providerId);

/** 重扫某会话可用的技能（来源来自 ctx.skillSources 注册表），并同步进其 agent 系统提示。 */
export function rescanSkillsFor(sh: SessionShell, rt: SessionRuntime): SkillInfo[] {
  rt.skills = scanSkills(skillDirsOf(sh.ctx.skillSources.all(), rt.workspace?.root ?? null));
  rt.agent.setSkills(rt.skills);
  return rt.skills;
}

/** MCP 后台装配（docs/28 P1-3）：连接移出会话创建/换绑的关键路径——stdio 握手数百 ms~数秒，
 *  旧版串行 await 使每次新建/切换对话的 POST 要等全部服务器连完（切换卡顿次因）。
 *  这里 fire-and-forget：完成后热更系统提示的 MCP 段并广播 state（顶栏服务器状态即时更新）；
 *  startTurn 开跑前 await rt.mcpReady 收口。必须在 rt.agent 装配完成**之后**调用（完成回调
 *  要 setMcpInstructions）。整体失败降级为无 MCP 会话（apply 内建单服务器隔离；吞错防炸广播链）。 */
export function applyMcpInBackground(sh: SessionShell, rt: SessionRuntime, wsRoot: string | null): void {
  rt.mcpReady = (async () => {
    await rt.mcp.apply(
      await loadMcpConfig([sh.globalMcpFile]),
      wsRoot ? await loadMcpConfig([join(wsRoot, "mcp.json")]) : { mcpServers: {} },
      rt.registry,
    );
    rt.agent.setMcpInstructions(rt.mcp.instructionsText());
    sh.broadcast(SSE_EVENTS.state, currentState(sh, rt));
  })().catch(() => {});
}

/**
 * 重载某会话的 MCP（manage_mcp 写入 mcp.json 后调用）：整体断开→按最新合并配置重连→
 * 刷新系统提示的 MCP 使用说明→广播 state（顶栏服务器状态即时更新）。
 * 只影响本会话运行态；其他已开会话在新建对话/切换工作区时各自加载。
 */
export async function reloadMcpFor(sh: SessionShell, rt: SessionRuntime): Promise<string[]> {
  await rt.mcp.apply(
    await loadMcpConfig([sh.globalMcpFile]),
    rt.workspace ? await loadMcpConfig([join(rt.workspace.root, "mcp.json")]) : { mcpServers: {} },
    rt.registry,
  );
  rt.agent.setMcpInstructions(rt.mcp.instructionsText());
  sh.broadcast(SSE_EVENTS.state, currentState(sh, rt));
  return rt.mcp.status();
}

/** 会话切换到 cfg 提供方：重建 llm、思考档位回到其配置档位（save/activate/delete 共用）。
 *  docs/12 R2：视觉能力随提供方进出系统提示（图片直看指引行热更）。 */
export function applyProvider(sh: SessionShell, rt: SessionRuntime, cfg: ProviderConfig): void {
  rt.llm = createProvider(cfg, sh.ctx.providerFormats);
  rt.agent.setProvider(rt.llm);
  rt.agent.setVision(cfg.vision === true);
  rt.settings.effort = cfg.effort;
}

/** 新会话运行时缺省设置（docs/21 §2.4 单一出处）：防与提供方表单缺省漂移；
 *  消费点用展开拷贝，后续 per-session 修改不回写本常量。 */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  alwaysConfirm: false,
  effort: "high",
  askMode: "ask",
  sandboxMode: "workspace-write",
};

const totalsSnapshot = (rt: SessionRuntime) => ({
  prompt: rt.totals.prompt,
  completion: rt.totals.completion,
  cacheHit: rt.totals.cacheHit,
  reasoning: rt.totals.reasoning,
  breakdown: { ...rt.totals.breakdown },
});

/** 运行参数与设置项下发（唯一出处 config.ts）：P1 压缩阈值；P4 提供方格式清单；
 *  P7 默认上下文长度 + 档位/沙箱 option 文案与别名（前端不再硬编码）。/api/meta 同源。 */
export const metaSnapshot = (sh: SessionShell) => ({
  pressureThreshold: COMPACTION_PRESSURE,
  defaultContextLength: DEFAULT_CONTEXT_LENGTH,
  efforts: EFFORT_OPTIONS,
  sandbox: SANDBOX_OPTIONS,
  sandboxAliases: SANDBOX_ALIASES,
  providerFormats: sh.ctx.providerFormats.all().map((d) => ({ format: d.format, label: d.label })),
  // docs/10 R1：子代理上下文治理档位（前端 ⚠ 标记的单一出处，不硬编码）。
  // docs/21 §2.2-⑤：补发第三档 subagentArchivePct（强制归档线）——三档全部下发，
  // 前端不再写 25/35 兜底数字（meta 未到时不显示档位标记）。
  subagentWarnPct: SUBAGENT_WARN_CONTEXT_PCT,
  subagentFollowupPct: SUBAGENT_FOLLOWUP_CONTEXT_PCT,
  subagentArchivePct: SUBAGENT_ARCHIVE_CONTEXT_PCT,
  // docs/22 §4.1：消息图片规则（张数/单张字节/mime 白名单）单一出处 config.IMAGE_RULES——
  // 前端校验与按钮 title 由此渲染，不再硬编码（HTML 静态 accept 保留作无 JS 降级）。
  imageRules: IMAGE_RULES,
  // docs/21 §2.4 协议解耦：自动送达消息前缀——前端判别/剥前缀用 startsWith(meta)，不写死文案
  autoReportPrefix: AUTO_DELIVERY_PREFIXES.report,
  autoStatusPrefix: AUTO_DELIVERY_PREFIXES.status,
});

export function currentState(sh: SessionShell, rt: SessionRuntime) {
  return {
    sessionId: rt.id,
    kind: rt.kind, // 会话形态（SA2）：前端据此显示 🎯 徽标与协调者占位文案
    busy: rt.busy,
    runningIds: busyIds(sh),
    effort: rt.settings.effort,
    contextLimit: cfgOf(sh, rt).contextLength,
    alwaysConfirm: rt.settings.alwaysConfirm,
    askMode: rt.settings.askMode,
    sandboxMode: rt.settings.sandboxMode,
    audit: auditStats(rt.auditEvents),
    workspace: rt.workspace?.root ?? null,
    workspaces: sh.recentWorkspaces,
    model: cfgOf(sh, rt).model,
    providerId: cfgOf(sh, rt).id,
    providerName: cfgOf(sh, rt).name,
    vision: cfgOf(sh, rt).vision === true, // docs/10 R3：前端据此显示 📎 上传按钮
    totals: totalsSnapshot(rt),
    // 运行计时：runMs=已结束轮的累计（不含在飞）；turnStartedAt=本次轮开始时刻（busy 时有值，
    // 前端本地滴算「本次」，累计显示 = runMs + 在飞滴答，无双算）
    runMs: rt.runMs,
    ...(rt.turnStartedAt !== null ? { turnStartedAt: rt.turnStartedAt } : {}),
    context: rt.agent.contextEstimate(),
    turn: rt.turnInfo, // 运行轮锚点：busy 时非空，前端切回运行中的会话用它补齐全部过程
    mcpServers: rt.mcp.status(),
    skills: rt.skills.map((s) => s.name),
    subagents: rt.subagents, // worker 审计记录（SA4）：/status 与刷新恢复的数据源
    // 需求三（docs/8 §3.2）：运行中 worker 瞬态清单——前端抽屉列表的数据源之一
    // （切换会话/刷新后恢复「谁在跑」）；瞬态不入档，空数组也照发。
    // docs/9：可复用句柄跨任务驻留——增发 status（run/idle）与 reusable/summary/tasks
    // （idle 行的「空闲待命 · 已完成 N 次任务」展示与 followup 寻址提示）；
    // docs/10 R1 修订：contextPct 用 liveContextPct 实时取值（run 态估算、idle 态快照）——
    // 运行中也一直有数可显示。
    activeSubagents: [...rt.activeSubagents.values()].map((a) => ({
      subId: a.subId,
      name: a.name,
      status: a.status,
      ...(a.reusable ? { reusable: true } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.tasks !== undefined ? { tasks: a.tasks } : {}),
      ...(() => {
        const pct = a.liveContextPct?.() ?? a.contextPct;
        return pct !== undefined ? { contextPct: pct } : {};
      })(),
      // 运行计时：taskStartedAt=当前任务开始时刻（run 态，前端本地滴答「本次用时」）；
      // elapsedMs=累计毫秒快照（含进行中任务的已耗时——liveElapsedMs 闭包实时取值）
      ...(a.taskStartedAt !== undefined ? { taskStartedAt: a.taskStartedAt } : {}),
      ...(() => {
        const ms = a.liveElapsedMs?.();
        return ms !== undefined ? { elapsedMs: ms } : {};
      })(),
    })),
    meta: metaSnapshot(sh),
  };
}

function makeUi(sh: SessionShell, rt: SessionRuntime): AgentUi {
  const ml = () => rt.agent.messages.length;
  return {
    // 模型思考流（reasoning_content）增量：前端按 kind === "reasoning" 分流到思考流面板
    printReasoningDelta: (t) => sh.broadcast(SSE_EVENTS.delta, { sessionId: rt.id, ml: ml(), kind: "reasoning", text: t }),
    printTextDelta: (t) => sh.broadcast(SSE_EVENTS.delta, { sessionId: rt.id, ml: ml(), kind: "content", text: t }),
    // P2-2（docs/28）：args=完整参数（截 TOOL_EVENT_ARGS_MAX_CHARS）——前端展开体渲染
    // write 内容/edit diff 用；argsPreview 仍发（兜底显示与旧前端兼容）
    printToolCall: (name, preview, callId, args) =>
      sh.broadcast(SSE_EVENTS.tool, {
        sessionId: rt.id,
        ml: ml(),
        name,
        preview,
        ...(callId ? { id: callId } : {}),
        ...(args ? { args: clipToolArgs(args) } : {}),
      }),
    printToolResult: (output, meta, callId) =>
      sh.broadcast(SSE_EVENTS.toolResult, { sessionId: rt.id, ml: ml(), output, meta, ...(callId ? { id: callId } : {}) }),
    printInfo: (m) => sh.broadcast(SSE_EVENTS.info, { sessionId: rt.id, message: m }),
    onCompaction: (record) => {
      // 先 init 整体重渲染（压缩卡片/新历史），再发 compaction——前端的"上下文已压缩"提示行
      // 落在重渲染之后才会留在对话底部（顺序反了会被重渲染冲掉）
      sh.broadcast(SSE_EVENTS.init, { sessionId: rt.id, messages: rt.agent.messages, state: currentState(sh, rt) });
      sh.broadcast(SSE_EVENTS.compaction, { sessionId: rt.id, ...record });
    },
    // W2-L2（docs/8 §1.3.3）：interim 对合并进 history 后广播一次 init 快照重渲染——
    // ①interim 回应块与后续轮次正确分段（否则下一轮 content delta 会接排在 interim 文本后，
    // 复用 curAnswer）；②ml 锚点一次性对齐（docs/7 §2.2 切回过滤坑随合并快照消除）；
    // ③后台会话走 sessCache.messages 同路径，切回重放自然一致。复用 init 事件名，契约零改动。
    onInterimMerged: () => {
      sh.broadcast(SSE_EVENTS.init, { sessionId: rt.id, messages: rt.agent.messages, state: currentState(sh, rt) });
    },
    printUsage: (u) => reportUsage(sh, rt, u),
  };
}

/**
 * ask_user 询问服务（docs/32）：前台会话（普通+协调者）的工具接缝实现——广播 askUser
 * 事件弹卡（问题 + 选项，前端附「其它」自由输入），挂 rt.pendingAskUsers 等待 /api/ask-user
 * 决议。Map 按 askId 存槽（对比审批的单槽 pendingApproval）：协调者同轮并行多问不互相覆盖。
 * 中止信号随挂随监听（/api/stop、轮中止）→ cancelled 收场；决议幂等（迟到触发是空操作）。
 */
export function askUserFor(
  sh: SessionShell,
  rt: SessionRuntime,
): (q: { question: string; options: string[]; signal?: AbortSignal }) => Promise<AskUserAnswer> {
  return (q) =>
    new Promise<AskUserAnswer>((resolveP) => {
      const id = crypto.randomUUID();
      const settle = (a: AskUserAnswer): void => {
        if (!rt.pendingAskUsers.delete(id)) return; // 已回答/已取消：迟到触发空操作
        resolveP(a);
      };
      rt.pendingAskUsers.set(id, settle);
      q.signal?.addEventListener("abort", () => settle({ cancelled: true }), { once: true });
      sh.broadcast(SSE_EVENTS.askUser, { sessionId: rt.id, id, question: q.question, options: q.options });
    });
}

/** 单次用量计入会话合计并广播 usage 事件（makeUi 与子代理 worker 汇总共用）。 */
export function reportUsage(sh: SessionShell, rt: SessionRuntime, u: UsageInfo): void {
  rt.totals.prompt += u.promptTokens;
  rt.totals.completion += u.completionTokens;
  if (u.cacheHitTokens) rt.totals.cacheHit += u.cacheHitTokens;
  if (u.reasoningTokens) rt.totals.reasoning += u.reasoningTokens;
  if (u.breakdown) {
    for (const k of Object.keys(u.breakdown) as (keyof UsageBreakdown)[]) {
      rt.totals.breakdown[k] += u.breakdown[k];
    }
  }
  sh.broadcast(SSE_EVENTS.usage, {
    sessionId: rt.id,
    call: u,
    totals: totalsSnapshot(rt),
    context: rt.agent.contextEstimate(),
  });
}

/** 审批服务（capability seam）：never 模式连卡都不弹直接 unavailable；否则 SSE 推卡等 POST 决议。
 *  worker（子代理）复用同一服务——审批路由到父会话同一张卡，语义零变化（docs/5 §1.2）。
 *  会话级串行链（docs/5 §5.2 C3）：并行 worker 同时触发审批时按序决议，后来的排队——
 *  doAsk 的单槽 pendingApproval 在互斥下同时至多一张卡在等，不会被覆盖导致 promise 永挂。
 *  链存 rt.approvalChain（每个 worker 经 runWorker 各自拿到 requestApprovalFor 的新闭包，
 *  闭包局部变量做不到跨 worker 排队）。opts.signal（worker 的中止/超时信号）：排队中的
 *  请求发起前发现已中止直接 cancelled，队列快速排空。正在等的卡也随信号立即 cancelled
 *  （docs/6 P1）——否则 abort 后工具仍挂在审批 promise 上，轮结束的 cancelled 收尾永远
 *  到不了（循环等待死锁）。前台 agent 未传 signal 时动态取当前轮的 rt.abortCtl 信号
 *  （startTurn 每轮新建 AbortController；同病同修——普通会话按停止同样解锁）。 */
export function requestApprovalFor(
  sh: SessionShell,
  rt: SessionRuntime,
  opts?: { signal?: AbortSignal },
): (req: ApprovalRequest) => Promise<ApprovalDecision> {
  return (req) => {
    // 生效信号：worker 的合并信号（已含轮信号）优先；前台 agent 用 ask 时刻的当前轮信号
    const live = opts?.signal ?? rt.abortCtl?.signal ?? undefined;
    const askOnce = (): Promise<ApprovalDecision> => {
      if (live?.aborted) return Promise.resolve("cancelled" satisfies ApprovalDecision);
      const mode = rt.settings.askMode; // live 读（docs/30）：运行中改审批策略，下一次 ask 即生效
      // auto（docs/30）：普通拦截卡不弹直接放行——审计照写 asked+decided 对（auto:true 标注
      // 区分人工卡）；justification 提权卡不短路：模型自我升权仍走人工，+1/-1 额度门不拆。
      if (mode === "auto" && !req.justification) {
        rt.auditEvents.push(auditAsked(rt.auditEvents, req));
        rt.auditEvents.push(auditDecided(rt.auditEvents, req, "allowed-once", new Date().toISOString(), { auto: true }));
        return Promise.resolve("allowed-once" satisfies ApprovalDecision);
      }
      return askWithMode(mode, req, (r) => doAsk(sh, rt, r, live));
    };
    const p = (rt.approvalChain ?? Promise.resolve()).then(askOnce, askOnce);
    rt.approvalChain = p.catch(() => {}); // 链条不断：前一个被拒/取消/异常也继续下一个
    return p;
  };
}

function doAsk(sh: SessionShell, rt: SessionRuntime, req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  return new Promise((resolveP) => {
    const settle = (decision: ApprovalDecision) => {
      // 本卡仍是单槽占用者才清槽：正常决议/abort 取消只能生效一次，迟到的重复触发
      // （先决议后 abort、或轮结束收尾与 abort 竞争）为空操作，不重复记审计
      if (rt.pendingApproval !== settle) return;
      rt.pendingApproval = null;
      rt.auditEvents.push(auditDecided(rt.auditEvents, req, decision));
      resolveP(decision);
    };
    rt.pendingApproval = settle;
    rt.auditEvents.push(auditAsked(rt.auditEvents, req));
    sh.broadcast(SSE_EVENTS.approval, { sessionId: rt.id, ...req });
    // 等待中的卡随中止信号立即取消（docs/6 P1）：决议走既有 cancelled 通道（审计记
    // decided/cancelled，工具按「被取消」分支自寻出路，fail-closed 不破）。监听器只看
    // 本卡（settle 身份比对）——先前已决议的卡留下的迟到触发不会误伤后卡（如别的
    // worker 超时信号触发时，后卡可能属于并未中止的第三者）。
    signal?.addEventListener("abort", () => settle("cancelled"), { once: true });
  });
}

/** 压缩依赖：用该会话的 provider 生成摘要（不带工具、不加思考参数），压缩前先备份原 history。
 *  opts.backup=false 供 worker 使用——worker 历史不落盘，没有可备份对象。 */
export function compactionDepsOf(sh: SessionShell, rt: SessionRuntime, opts?: { backup?: boolean }) {
  return {
    contextLength: () => cfgOf(sh, rt).contextLength,
    summarize: async (messages: ChatMessage[]): Promise<string> => {
      const text = messages
        .map((m) => {
          const body =
            typeof m.content === "string"
              ? m.content
              : m.role === "assistant"
                ? (m.content ?? "") +
                  " " +
                  m.toolCalls.map((t) => `${t.name}(${t.arguments})`).join(" ")
                : "";
          return `[${m.role}] ${body}`;
        })
        .join("\n\n");
      // 摘要输入本身也要防超长：只保留头部（docs/10 R2 起 pruneToolResult 为 head-only，
      // 不再保留尾部；超过部分的信息损失可接受，备份里仍有全文）——预算为阈值键
      // compactionSummaryMaxChars（默认 300k，initConfig 热重绑）
      const capped = pruneToolResult(text, COMPACTION_SUMMARY_MAX_CHARS).text;
      const r = await rt.llm.chat({
        messages: [{ role: "user", content: COMPACTION_PROMPT + "\n\n" + capped }],
        effort: "off", // 辅助调用强制关思考（openai 路线显式 thinking:disabled；anthropic 路线不发思考参数）：不付思考成本，思考流也不串进前端
      });
      return r.content;
    },
      ...(opts?.backup === false
        ? {}
        // docs/33：压缩前备份同样只存引用（图片字节在附件库里，备份 JSON 不再嵌 base64）
        : { backup: (history: ChatMessage[]): void => sh.sessions.backupBeforeCompact(rt.id, toStoredMessages(sh.attachments, history)) }),
  };
}

// 子代理服务装配（v2 worker 运行机制）在 web/subagents.ts；re-export 保持 server.ts 装配路径不变
export { subagentServiceFor } from "./subagents.ts";
// W2-S：协调者工具的子代理控制实现（pause/resume ↔ rt.activeSubagents）
import { applySubagentControl, commonWorkerPromptSectionText, subagentStatusText, workerMcpToolsOf } from "./subagents.ts";
// docs/17：read_archive 的存档解析实现（主会话 toolDeps 与 worker 的 workerDeps 同一闭包）
import { archiveSourceOf } from "./subagents.ts";

/** 创建一份会话运行态（新会话或从磁盘恢复）。workspaceRoot=null 为引导占位。
 *  opts.kind / fromDisk.kind = "coordinator" 时装配为协调者会话（registry 仅 agent_task(s)，docs/5 D1）。 */
export async function createRuntime(
  sh: SessionShell,
  opts: { id?: string; workspaceRoot?: string | null; kind?: "normal" | "coordinator"; fromDisk?: SessionData },
): Promise<SessionRuntime> {
  const id = opts.id ?? crypto.randomUUID();
  const kind: "normal" | "coordinator" = opts.kind ?? (opts.fromDisk?.kind === "coordinator" ? "coordinator" : "normal");
  let workspace: Workspace | null = null;
  if (opts.fromDisk?.workspace) {
    const st = statSync(opts.fromDisk.workspace, { throwIfNoEntry: false });
    if (st?.isDirectory()) workspace = createWorkspace(opts.fromDisk.workspace);
  } else if (opts.workspaceRoot) {
    workspace = createWorkspace(opts.workspaceRoot);
  }

  const rt: SessionRuntime = {
    id,
    workspace,
    kind,
    agent: null as unknown as Agent,
    llm: null as unknown as LLMProvider,
    providerId: sh.providerFile.data.active,
    settings: { ...DEFAULT_RUNTIME_SETTINGS },
    totals: { prompt: 0, completion: 0, cacheHit: 0, reasoning: 0, breakdown: zeroBreakdown() },
    runMs: 0,
    turnStartedAt: null,
    auditEvents: [],
    compactions: [],
    skills: [],
    mcp: new McpManager(sh.ctx.mcpTransports),
    registry: new ToolRegistry(),
    busy: false,
    abortCtl: null,
    pendingApproval: null,
    pendingAskUsers: new Map(), // ask_user 待答槽（docs/32；/api/ask-user 按 id 决议，瞬态不入档）
    turnInfo: null,
    workers: new Set(),
    subagentTotal: 0, // C7 累计闸：会话生命周期内单调递增；从存档恢复时按 subagents 记录条数续期（见下）
    subagents: [], // worker 审计记录（SA4）：完成时由 runWorker 追加，随 toSessionData 落盘
    activeSubagents: new Map(), // W2-S：运行中 worker 的控制句柄（runWorker 登记/注销，瞬态）
    fileLedger: createFileLedger(),
  };

  // 系统工具：组合清单注册的 SystemToolDef 逐会话实例化（升级额度/技能清单等会话私有）。
  // 按 kind×受众分流（docs/5 D1；docs/32 三值受众）：normal 装 worker+front；
  // coordinator 装 coordinator+front（front=前台会话共同工具，如 ask_user）——协调者自身的
  // 实质工具结构性缺位，幻觉调用 run_pwsh 等只收「未知工具」。
  const effectiveWorkspace = workspace ?? createWorkspace(process.cwd()); // 引导占位：选中真实工作区前禁止对话
  const toolDeps: SystemToolDeps = {
    ctx: sh.ctx,
    // 活读取 rt.workspace：bindWorkspace 就地绑定引导会话时闭包不能停在旧快照
    // （否则 read_file/manage_mcp 的相对路径解析到 process.cwd()，而 write/edit 用
    //  ToolContext.workspace 走 agent 是对的——同一会话内两套基准会分叉）
    workspace: () => rt.workspace ?? effectiveWorkspace,
    skills: () => rt.skills,
    requestApproval: requestApprovalFor(sh, rt),
    alwaysConfirm: () => rt.settings.alwaysConfirm,
    sandboxMode: () => rt.settings.sandboxMode,
    spillDir: () => sh.sessions.spillDir(rt.id) ?? undefined,
    privateTempDir: () => join(sh.sandboxTmpRoot, rt.id),
    mcpStatus: () => rt.mcp.status(),
    reloadMcp: () => reloadMcpFor(sh, rt),
    // docs/10 R3：view_image 的视觉模型解析（热读取 providers.json——设置后无需重启）与
    // 辅助调用的用量上报（计入本会话合计，六类守恒；breakdown 全归 other）。
    // docs/12 R2：selfVision——会话自身有视觉时 view_image 优先用自身（模型自己读图）。
    selfVision: () => {
      const cfg = cfgOf(sh, rt) as ProviderConfig | undefined; // 空 providers 桩守卫
      return cfg?.vision === true ? cfg : null;
    },
    vision: () => {
      const d = sh.providerFile.data;
      return d.providers.find((p) => p.id === d.visionProvider) ?? null;
    },
    reportAuxUsage: (u) => reportUsage(sh, rt, u),
    ledger: rt.fileLedger, // 已读台账（hash 乐观锁）：与 worker 共享同一实例
    // docs/17：read_archive 的存档解析（本会话子代理过程存档 + 任意主对话记录——同一闭包
    // 也注入全部 worker，见 subagents.ts mountWorkerAgent）
    archiveSource: archiveSourceOf(sh, rt),
    // docs/32：ask_user 的询问接缝（front 受众——普通+协调者都注册本工具；worker 的
    // workerDeps 不注入此缝，工具层对子代理报「不能直接向用户提问」）
    askUser: askUserFor(sh, rt),
    ...(kind === "coordinator" && sh.ctx.subagent ? { subagent: sh.ctx.subagent(rt) } : {}),
    // W2-S：协调者的 stop_subagent 工具经此触达 rt.activeSubagents（普通会话不注入）；
    // docs/9：archive_subagent 工具与 /api/subagent/control 的归档动作共用本缝（action 联合扩 "archive"）
    ...(kind === "coordinator" ? { subagentControl: (target: { name?: string; subId?: number }, action: "stop" | "archive") => applySubagentControl(rt, target, action) } : {}),
    // docs/32：subagent_status 工具的状态表文案接缝（闭包读 rt——活动句柄与历史记录实时取值）
    ...(kind === "coordinator" ? { subagentStatus: (opts?: { all?: boolean }) => subagentStatusText(rt, opts) } : {}),
  };
  for (const def of sh.ctx.tools.all()) {
    const audience = def.audience ?? "worker";
    // docs/32 三值受众：front 两类前台会话都装；其余受众与 kind 精确匹配
    // （coordinator↔coordinator、worker↔normal）
    const wanted = audience === "front" || (audience === "coordinator") === (kind === "coordinator");
    if (!wanted) continue;
    rt.registry.register({ ...def.create(toolDeps), summary: def.summary });
  }
  // 协调者不接 MCP（docs/5 D3/§2：registry 仅 agent_task(s)；mcp__ 工具不注册，
  // 系统提示的 MCP 段也不会注入）。普通会话与 worker 照旧——但连接改后台装配
  // （docs/28 P1-3：不再阻塞会话创建；见 applyMcpInBackground 注释）。
  const wantMcp = kind !== "coordinator";

  // 从磁盘恢复：先按会话记录的提供方/档位/策略还原，再回填历史
  const d = opts.fromDisk;
  if (d) {
    const want = typeof d.providerId === "string" ? sh.providerFile.data.providers.find((x) => x.id === d.providerId) : undefined;
    rt.providerId = (want ?? providerCfgById(sh, sh.providerFile.data.active)).id;
    const restoredEffort = normalizeEffort(d.effort);
    if (restoredEffort) rt.settings.effort = restoredEffort;
    rt.settings.askMode = normalizeAskMode(d.askMode);
    rt.settings.sandboxMode = normalizeSandboxMode(d.sandboxMode);
    rt.auditEvents = Array.isArray(d.events) ? d.events : [];
    rt.compactions = Array.isArray(d.compactions) ? d.compactions : [];
    // worker 审计记录（SA4）：恢复展示 + 累计配额续期（偏差 15——重启后 subagentTotal
    // 不再归零；被拒任务历史上就不计累计，条数 = 真正启动过的 worker 数）
    rt.subagents = Array.isArray(d.subagents) ? d.subagents : [];
    rt.subagentTotal = rt.subagents.length;
    rt.totals = {
      prompt: d.totals?.prompt ?? 0,
      completion: d.totals?.completion ?? 0,
      cacheHit: d.totals?.cacheHit ?? 0,
      reasoning: d.totals?.reasoning ?? 0,
      breakdown: { ...zeroBreakdown(), ...(d.totals?.breakdown ?? {}) },
    };
    rt.runMs = d.runMs ?? 0; // 累计运行毫秒（旧档缺省 0）
  } else {
    rt.providerId = providerCfgById(sh, sh.providerFile.data.active).id;
    rt.settings.effort = cfgOf(sh, rt).effort;
  }
  rt.llm = createProvider(cfgOf(sh, rt), sh.ctx.providerFormats);

  rt.skills = scanSkills(skillDirsOf(sh.ctx.skillSources.all(), workspace?.root ?? null));

  // docs/20：协调者会话追加「子代理（worker）系统提示词说明」段（order 35，工具行之后）——
  // worker 共同系统提示的同构重放（subagents.ts commonWorkerPromptSectionText）：含子代理的
  // 可用工具/技能/MCP 说明与两级 AGENTS.md（后者在其中出现一次即可——sections.ts 两段对
  // coordinator 渲染 null，协调者不再单独注入）。render 惰性读 rt 当前状态：技能热更等既有
  // rebuild 自动带新；worker MCP 首连后由 workerMcpToolsOf 触发 refreshSystemPrompt 补上
  // MCP 说明。普通会话字节不变（直传 ctx.promptSections）。
  let coordSections: Registry<PromptSection, "name"> | undefined;
  if (kind === "coordinator") {
    coordSections = new Registry<PromptSection, "name">("name");
    for (const s of sh.ctx.promptSections.all()) coordSections.register(s);
    coordSections.register({ name: "subagent-prompt", order: 35, render: () => commonWorkerPromptSectionText(sh, rt) });
  }

  rt.agent = new Agent({
    provider: rt.llm,
    registry: rt.registry,
    workspace: effectiveWorkspace,
    ui: makeUi(sh, rt),
    requestApproval: requestApprovalFor(sh, rt),
    settings: rt.settings,
    // maxToolRounds 不传：Agent 每轮 live 读 DEFAULTS（docs/24 热应用——保存即对运行中会话生效）
    skills: rt.skills,
    // AGENTS.md 两级注入：全局 ~/.ZQQ-harness/AGENTS.md + 工作区根 AGENTS.md（冲突以工作区为准）
    agentsMd: workspace ? readAgentsMd(workspace.root) : null,
    globalAgentsMd: readAgentsMd(sh.userDir),
    mcpInstructions: rt.mcp.instructionsText(),
    ...(kind === "coordinator" ? { sessionKind: kind } : {}), // 协调者 base/skills/mcp 段分支（normal 字节不变）
    ...((cfgOf(sh, rt) as ProviderConfig | undefined)?.vision === true ? { vision: true } : {}), // docs/12 R2：视觉会话注入图片直看指引（空 providers 桩守卫）
    sandboxMode: rt.settings.sandboxMode,
    spillDir: () => sh.sessions.spillDir(rt.id) ?? undefined,
    privateTempDir: () => join(sh.sandboxTmpRoot, rt.id),
    compaction: compactionDepsOf(sh, rt),
    promptSections: coordSections ?? sh.ctx.promptSections, // docs/20：coordinator 加 subagent-prompt 段；normal 直传（字节不变）
  });
  // docs/33：恢复时解析附件引用（{mime,ref} → 校验 sha256 → {mime,data}；缺失/损坏降级丢图+标注；
  // 旧档内联 base64 原样兼容）
  if (d) rt.agent.restore(restoreStoredMessages(sh.attachments, d.messages));
  // P1-3（docs/28）：MCP 后台装配放 agent 就位之后启动（完成回调要 setMcpInstructions）
  if (wantMcp) applyMcpInBackground(sh, rt, workspace?.root ?? null);
  // docs/20 修订（真机反馈）：协调者创建即预热 worker MCP——「子代理系统提示词说明」段
  // 需要 MCP 说明书，但连接原是首个 worker 派发才触发：新会话/重启恢复后的首轮协调者对
  // 子代理 MCP 能力一无所知。
  // docs/32 修订：预热升级为**首轮闸门**——promise 挂 rt.mcpReady，startTurn 既有的
  // await 对协调者生效（首条消息发出时 MCP 说明必已就位，与普通会话 applyMcpInBackground
  // 同语义；真机实证：协调者原为 no-op，ref_database 秒连能赶上、godot 冷启动赶不上首轮
  // 请求 → 表现为「godot/blender 未注入」）。最坏等待 = 握手超时 + 重试宽限 + 重试握手
  // （约 20s+10s+20s）；无配置/快连近瞬时。引导会话（未绑工作区）不在此预热——此刻只有
  // 全局配置，缓存住会让 bindWorkspace 后的工作区级配置丢失（那边会补）。
  if (kind === "coordinator" && workspace) {
    rt.mcpReady = workerMcpToolsOf(sh, rt).then((): void => {}).catch(() => {});
  }

  sh.runtimes.set(id, rt);
  return rt;
}
