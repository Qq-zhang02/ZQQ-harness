/**
 * 子代理家族五件套之二：worker 装配（docs/21 §3.1 自 subagents.ts 拆出，纯移动）。
 * runWorker 按一次性 Agent 实例装配——独立历史与 ToolRegistry（audience=worker 的全部
 * 系统工具；无 agent_task → 结构性禁嵌套）、独立升级额度与独立 spill/tmp 子目录、共享父
 * 会话的审批服务与已读台账（hash 乐观锁，per-reader 快照视图）、同款压缩装配（超压自动
 * 压缩；不备份——worker 历史不落盘）、会话级共享 MCP 连接（docs/6 P2 路线 A，懒加载挂
 * rt.mcp，见 workerMcpToolsOf）。本文件是三态装配的共用件：控制句柄与驻留上下文的同步
 * 构造（createWorkerSession，docs/17 起首派发与重启唤醒共用）+ 过程流 UI 聚合器
 * （makeWorkerUi，方案 B：tool/toolResult subagent 事件不进前台历史）+ Agent 装配
 * （mountWorkerAgent）。任务执行与结算在 subagent-report，存档与唤醒在 subagent-archive。
 */
import { join } from "node:path";
import { SUBAGENT_MAX_TOOL_ROUNDS } from "../config.ts";
import { loadMcpConfig } from "../mcp/manager.ts";
import { ToolRegistry, type Tool } from "../tools/registry.ts";
import { Agent, type AgentUi } from "../agent.ts";
import { createWorkspace, readAgentsMd } from "../workspace.ts";
import type { ProviderConfig } from "../providers/store.ts";
import { Registry } from "../core/registry.ts";
import { readerLedger } from "../core/file-tools.ts";
import { AUTO_DELIVERY_PREFIXES, SSE_EVENTS } from "../core/events.ts";
import type { ApprovalDecision } from "../approval/types.ts";
import type { PromptSection, SystemToolDeps } from "../core/types.ts";
import type { ActiveSubagent, SessionRuntime } from "../core/host.ts";
import { cfgOf, compactionDepsOf, reportUsage, type SessionShell } from "./session-runtime.ts";
import { archiveSourceOf, requestArchiveWorker } from "./subagent-archive.ts";
import { contextPctOf, deliverToCoordinator } from "./subagent-report.ts";
import type { WorkerSession } from "./subagent-records.ts";

/** worker 系统提示的 order 5 子代理职责段（docs/5 §8；协调者唯一能看到的是最终报告）。 */
export const WORKER_ROLE_SECTION = [
  "你是被协调者派出的子代理，独立完成一项具体任务。约束：",
  "- 专注任务书目标，不做任务书之外的事；写入尽量限定在任务书指明的范围内。",
  "- 遇到写入被拒（文件已被他人修改/超出范围）时：重新读取最新内容再操作，不要盲目重试。",
  "- 调用解释器与外部程序用 PATH 短名（python、node、pwsh 等），不要写绝对路径——引用工作区外的绝对路径会触发用户审批卡，拖慢任务。",
  "- 完成后输出报告（这是协调者唯一能看到的内容）：①结论（完成/部分完成/失败及原因）" +
    "②产出物清单（路径+一句话说明）③关键决定与假设 ④未决问题与建议后续任务。" +
    "报告精炼，细节写入工作区文件并引用路径。",
].join("\n");

/** worker 专用的子目录标签：seq 保证同会话唯一，name 只取文件系统安全字符。 */
export function workerDirTag(seq: number, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "anon";
  return `sub-${seq}-${safe}`;
}

/** 过程流单字段字符预算（方案 B 事件量控制）：preview 已由 agent.ts 的 previewArgs（160）截断，
 *  output（工具完整输出）在这里截到预算内 + 截断标记；全文始终有 A 的 transcript 落盘兜底。 */
const SUBAGENT_EVENT_TEXT_MAX = 500;

function clipEventText(s: string): string {
  return s.length <= SUBAGENT_EVENT_TEXT_MAX ? s : s.slice(0, SUBAGENT_EVENT_TEXT_MAX - 16) + "…（已截断）";
}

/**
 * worker 共享 MCP 工具（docs/6 P2 路线 A）：首个 runWorker 懒加载。连接挂在本会话的
 * rt.mcp 上——协调者会话（唯一会派 worker 的形态）该 manager 闲置（createRuntime 与
 * bindWorkspace 对 coordinator 都跳过 apply，D3），专供 worker 正好；进程退出随
 * server.ts 既有 rt.mcp.stop() 统一回收，与普通会话同等待遇（server.ts 零改动）。
 * 工具注册进一次性模板 registry 再拍快照：McpManager.apply 是「一次性 apply 到一个
 * registry」的形态，快照复制给每个 worker 的独立 registry（execute 闭包无状态，
 * 共享同一批连接——每 server 一个进程，不是每 worker 一个）。
 * 每会话只连一次（rt.workerMcp 的 promise 缓存：同轮多 agent_task 并行首派不会双连，docs/15）；
 * 单服务器失败由 apply 内建隔离，整体异常降级为 null（worker 照旧不带 mcp__ 工具，
 * 不因 MCP 故障拒派）。红线不破：协调者自己的 rt.registry 仍仅 agent_task(s)、
 * 系统提示仍无 MCP 段（本函数不触碰它们）。
 * docs/20 修订：连接不再只等首个 worker 派发——协调者会话创建（createRuntime）与
 * bindWorkspace 会 fire-and-forget 预热本函数（「子代理系统提示词说明」段需要说明书；
 * 真机反馈：未预热时新会话首轮协调者对子代理 MCP 能力一无所知）。
 */
export async function workerMcpToolsOf(sh: SessionShell, rt: SessionRuntime): Promise<readonly Tool[] | null> {
  rt.workerMcp ??= (async (): Promise<readonly Tool[] | null> => {
    const globalCfg = await loadMcpConfig([sh.globalMcpFile]);
    const wsCfg = rt.workspace ? await loadMcpConfig([join(rt.workspace.root, "mcp.json")]) : { mcpServers: {} };
    if (Object.keys(globalCfg.mcpServers).length === 0 && Object.keys(wsCfg.mcpServers).length === 0) return null;
    const template = new ToolRegistry();
    try {
      await rt.mcp.apply(globalCfg, wsCfg, template);
    } catch (e) {
      console.warn(`[subagent] worker MCP 装配失败（降级为不带 mcp__ 工具）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    // docs/20：MCP 说明书随协调者的「子代理系统提示词说明」段注入——首次连接成功后重建
    // 一次协调者系统提示（本 promise 缓存保证只触发一次；协调者 rt.agent 在任何派发发生前
    // 已装配就位）。独立 try：刷新异常绝不影响 worker 拿工具（测试桩 agent 可能缺该方法）。
    try {
      rt.agent?.refreshSystemPrompt();
    } catch {
      /* 刷新失败不阻断 worker 装配 */
    }
    return template.list();
  })();
  return rt.workerMcp;
}

/**
 * worker 控制句柄与驻留上下文的同步构造（docs/9；docs/17 起首派发与重启唤醒共用）：
 * gate/active/ws 三件同步建好并登记（rt.activeSubagents.set；可复用再 reusables.set +
 * requestArchive 挂载）——登记先于装配，返回后句柄即可施控（装配窗口的打断/归档由
 * stopRequested/pendingArchive/archiveRequested 兜住）。broadcastSpawned=true 广播 spawned 事件（首派发；
 * 唤醒不广播——抽屉行已存在，随后 task 事件起跑翻行）。
 */
export function createWorkerSession(
  sh: SessionShell,
  rt: SessionRuntime,
  fixed: { seq: number; name: string; description?: string; reusable: boolean; spillDir?: string },
  reusables: Map<number, WorkerSession>,
  broadcastSpawned: boolean,
): WorkerSession {
  const { seq, name, description, reusable } = fixed;
  const dirTag = workerDirTag(seq, name);
  if (broadcastSpawned) {
    // SA4 可观测性（D8）：配额通过即广播 spawned——先于装配发出，配合 try 全包，保证
    // 「spawned ⟹ 必有 done/error（一次性）/archived（可复用）收尾」（配额拒绝在调用方
    // 提前返回，未启动不发事件）。
    sh.broadcast(SSE_EVENTS.subagent, {
      sessionId: rt.id,
      subId: seq,
      name,
      phase: "spawned",
      ...(description ? { summary: description } : {}),
      ...(reusable ? { reusable: true } : {}),
      taskStartedAt: Date.now(), // 前端「本次用时」种子（runOneTask 开始后由快照/轮询校正）
    });
  }
  // docs/18（暂停/恢复退役）：控制面只剩 stop（打断即终结）与 requestArchive。stop =
  // 置 stopRequested + abort 当前任务的 ctl——归档中止同款收尾链（LLM 请求/工具执行/
  // 排队审批一并取消），任务随即结算（一次性=归档；可复用=转 idle 待命，无恢复）。登记先于
  // 装配，调用方在返回的 promise 首次让出后即可施控。docs/9：可复用句柄跨任务驻留
  // （run⇄idle，archive 注销）；idle 态没有任务在执行，stop 无对象（防御：仅 run 态生效）。
  const active: ActiveSubagent = {
    subId: seq,
    name,
    status: "run",
    ...(reusable ? { reusable: true, tasks: 0, ...(description ? { summary: description } : {}) } : {}),
    stop: (via: "ui" | "model" = "model") => {
      if (active.status !== "run") return; // idle 无任务在执行；重复调用幂等（标记已置/abort 幂等）
      ws.stopRequested = true; // ws 级：装配窗口与任务间隙的打断由 runOneTask 开始时消费
      ws.cur?.ctl.abort(); // 中止当前任务（请求/工具/审批一并取消），收尾由 runOneTask 既有链路完成
      if (via === "ui") {
        // 界面打断是协调者看不见的异常变动（与 docs/11 W1 的 UI 归档同约定）——状态通知
        // 自动送达；工具路径（via="model"）的返回文案本身已抵达协调者，不重复送。
        deliverToCoordinator(
          sh,
          rt,
          `${AUTO_DELIVERY_PREFIXES.status} 子代理 ${name}#${seq} 的当前任务已被用户打断：进行中的请求与工具执行已中止` +
            `${reusable ? `，它转为空闲待命（保留已有上下文）——继续该方向的工作请用 agent_followup 向它发新任务书（没有「恢复」，被打断的任务不会自动续跑）` : `，该子代理（一次性）已随之归档`}。` +
            `任务的结算报告会作为新消息自动送达。`,
        );
      }
    },
    liveMessages: () => ws.agent?.messages.filter((m) => m.role !== "system") ?? [], // 装配段回填 ws.agent 后即有值
  };
  const ws: WorkerSession = {
    subId: seq,
    name,
    ...(description ? { description } : {}),
    agent: null,
    active,
    dirTag,
    ...(fixed.spillDir ? { spillDir: fixed.spillDir } : {}),
    cur: null,
    tasks: 0,
    rounds: 0,
    usage: { prompt: 0, completion: 0, reasoning: 0, cacheHit: 0 },
    elapsedMs: 0,
    lastOk: false,
  };
  if (reusable) {
    active.requestArchive = (via) => requestArchiveWorker(sh, rt, ws, reusables, via);
    reusables.set(seq, ws);
  }
  // docs/10 R1 修订（一直显示）：运行中/待命子代理的实时上下文占用出口——run 态实时
  // 估算（估算器带逐消息/字符串缓存），idle 态返回收尾快照；currentState 与
  // /api/subagent/context 轮询消费。放 ws 定义之后（闭包读 ws 与 rt 提供方）。
  active.liveContextPct = () => contextPctOf(sh, rt, ws);
  // 运行计时出口：累计毫秒（含进行中任务的已耗时）；无任何运行史返回 undefined（快照不带字段）
  active.liveElapsedMs = () => {
    const live = ws.cur ? Date.now() - ws.cur.startedAt : 0;
    return ws.elapsedMs + live > 0 ? ws.elapsedMs + live : undefined;
  };
  rt.activeSubagents.set(seq, active);
  return ws;
}

/** worker 过程流 UI + 用量聚合器（docs/6 P3 方案 B；docs/17 起首派发与唤醒共用）：
 *  worker 中间过程仍不进前台历史/上下文（D8 两层架构不破），但工具调用/结果实时穿透为
 *  subagent 事件的 tool/toolResult phase（带 subId/name 配对；文本截断；只发 tool 级不发
 *  delta 级——事件量控制）。不带 ml 锚点：route() 缓冲重放不过滤，切回运行中会话时重放
 *  进抽屉（偏差 22 同机制）。docs/9：用量盒随任务走（ws.cur）——printUsage 聚合进
 *  「当前任务」的盒，idle 期间无写入。 */
export function makeWorkerUi(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession): AgentUi {
  return {
    printReasoningDelta: () => {},
    printTextDelta: () => {},
    printToolCall: (toolName, preview, callId) => {
      sh.broadcast(SSE_EVENTS.subagent, {
        sessionId: rt.id,
        subId: ws.subId,
        name: ws.name,
        phase: "tool",
        toolName,
        preview: clipEventText(preview),
        ...(callId ? { id: callId } : {}),
      });
    },
    printToolResult: (output, _meta, callId) => {
      sh.broadcast(SSE_EVENTS.subagent, {
        sessionId: rt.id,
        subId: ws.subId,
        name: ws.name,
        phase: "toolResult",
        output: clipEventText(output),
        ...(callId ? { id: callId } : {}),
      });
    },
    printInfo: () => {},
    printUsage: (u) => {
      const box = ws.cur?.usage;
      if (!box) return;
      box.prompt += u.promptTokens;
      box.completion += u.completionTokens;
      if (u.reasoningTokens) box.reasoning += u.reasoningTokens;
      if (u.cacheHitTokens) box.cacheHit += u.cacheHitTokens;
    },
  };
}

/**
 * worker Agent 装配（docs/17 起首派发与重启唤醒共用）：独立 ToolRegistry（audience=worker
 * 的全部系统工具——无 agent_task 结构性禁嵌套 D6——加会话共享 MCP 工具快照）+ 系统提示
 * （父会话 sections + order 5 职责段 + ws.system 角色段）+ Agent 构造（scope/effort 等
 * 构造期参数读 ws——首派发为 req 捕获值，唤醒为存档 meta 回填值）。审批闭包 per-task
 * 重建（runOneTask 挂 ws.approval），中止信号挂对当前任务的链；装配后、任务前的窗口没有
 * 工具在跑，unavailable 兜底不可达。返回未执行任何任务的 Agent；ws.agent 回填由调用方
 * 负责（唤醒路径先 restore 存档历史再回填）。
 */
export async function mountWorkerAgent(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession, ui: AgentUi): Promise<Agent> {
  const name = ws.name;
  const spillDir = ws.spillDir;
  const privateTempDir = join(sh.sandboxTmpRoot, rt.id, ws.dirTag);
  const w = rt.workspace ?? createWorkspace(process.cwd());
  const workerDeps: SystemToolDeps = {
    ctx: sh.ctx,
    workspace: () => w,
    skills: () => rt.skills,
    requestApproval: (r) =>
      // 审批卡标注来源：command 前缀（纯文本场景可识别）+ subagent 字段（前端卡片展示）
      ws.approval
        ? ws.approval({ ...r, command: `[子代理 ${name}] ${r.command}`, subagent: name })
        : Promise.resolve("unavailable" satisfies ApprovalDecision),
    alwaysConfirm: () => rt.settings.alwaysConfirm,
    sandboxMode: () => rt.settings.sandboxMode,
    spillDir: () => spillDir,
    privateTempDir: () => privateTempDir,
    mcpStatus: () => rt.mcp.status(),
    reloadMcp: async () => ["子代理会话不支持 MCP 配置重载（manage_mcp 只在普通会话可用）"],
    // docs/10 R3：worker 也能用 view_image（视觉模型解析同父会话；用量直接计入父会话合计
    // ——视觉调用不属当前任务的 LLM 轮次，不进 ws.cur 聚合盒，即时上报更诚实）。
    // docs/12 R2：worker 与父会话同提供方——自身视觉同源优先。
    selfVision: () => {
      const cfg = cfgOf(sh, rt) as ProviderConfig | undefined; // 测试桩 providers 可为空（先例 :623）
      return cfg?.vision === true ? cfg : null;
    },
    vision: () => {
      const d = sh.providerFile.data;
      return d.providers.find((p) => p.id === d.visionProvider) ?? null;
    },
    reportAuxUsage: (u) => reportUsage(sh, rt, u),
    // per-reader 乐观锁视图（§5.3）：写入校验比对「本 worker 上次所见」，凭据共享父会话
    ledger: readerLedger(rt.fileLedger),
    // docs/17：read_archive 的存档解析（主会话 toolDeps 注入同一实现——见 archiveSourceOf）
    archiveSource: archiveSourceOf(sh, rt),
  };
  const registry = new ToolRegistry();
  for (const def of sh.ctx.tools.all()) {
    if ((def.audience ?? "worker") === "coordinator") continue;
    registry.register({ ...def.create(workerDeps), summary: def.summary });
  }
  // worker 带真 MCP 工具（docs/6 P2 路线 A，修订偏差 19）：与普通会话同一信任模型
  // （用户显式配置的可信工具，不走 pwsh 工作区守卫与审批）——worker 无需再绕行
  // run_pwsh 模拟 MCP 查询而触发审批卡。
  const mcpTools = await workerMcpToolsOf(sh, rt);
  for (const t of mcpTools ?? []) registry.register(t);

  // 系统提示 = 父会话 sections（sessionKind=normal 渲染：base 安全规则/工具/技能/两级 AGENTS.md）
  // + order 5 子代理职责段 +（可选）ws.system 角色段
  const sections = new Registry<PromptSection, "name">("name");
  for (const s of sh.ctx.promptSections.all()) sections.register(s);
  sections.register({ name: "subagent-role", order: 5, render: () => WORKER_ROLE_SECTION });
  const sys = ws.system?.trim();
  if (sys) sections.register({ name: "subagent-system", order: 5, render: () => sys });

  return new Agent({
    provider: rt.llm,
    registry,
    workspace: w,
    ui,
    requestApproval: workerDeps.requestApproval,
    settings: { alwaysConfirm: rt.settings.alwaysConfirm, effort: ws.effort ?? rt.settings.effort }, // D4：缺省继承父会话
    maxToolRounds: SUBAGENT_MAX_TOOL_ROUNDS, // D5：达上限收尾总结，保证总能交报告；worker 创建时读 live binding（热应用对后续派发生效）
    skills: rt.skills,
    agentsMd: readAgentsMd(w.root),
    globalAgentsMd: readAgentsMd(sh.userDir),
    mcpInstructions: mcpTools && mcpTools.length > 0 ? rt.mcp.instructionsText() : null, // worker 带 MCP 时说明段照常渲染（sessionKind=normal）
    // scope 写入分区（§5.4）：透传工具上下文（文件三工具硬拒 / pwsh 守卫弹卡）
    ...(ws.scope && ws.scope.length > 0 ? { writeScope: ws.scope } : {}),
    // docs/12 R2：worker 与父会话同提供方——视觉能力同源（图片直看指引；worker 要看
    // 磁盘图片仍走 view_image，指引行里已划清边界）。providers 为空的测试桩守卫同 :623。
    ...((cfgOf(sh, rt) as ProviderConfig | undefined)?.vision === true ? { vision: true } : {}),
    // docs/18：pauseGate/interruptSignal（轮边界挂起/打断重发）已随暂停机制退役——打断
    // 走 ctl.abort 的既有中止链（AgentDeps 两字段删除）。
    sandboxMode: rt.settings.sandboxMode,
    spillDir: () => spillDir,
    privateTempDir: () => privateTempDir,
    compaction: compactionDepsOf(sh, rt, { backup: false }), // 同款压缩；worker 历史不落盘无备份
    promptSections: sections,
  });
}
