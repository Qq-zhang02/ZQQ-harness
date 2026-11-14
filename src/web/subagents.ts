/**
 * 子代理（worker）运行机制（docs/5 §2，web 壳的一部分非模块；server.ts 零改动）：
 * runWorker 按一次性 Agent 实例装配——独立历史与 ToolRegistry（audience=worker 的全部
 * 系统工具；无 agent_task → 结构性禁嵌套）、独立升级额度（create() 实例级）与独立
 * spill/tmp 子目录、共享父会话的审批服务（串行队列 + [子代理 name] 标注）与已读台账
 * （hash 乐观锁，per-reader 快照视图）、同款压缩装配（超压自动压缩；不备份——worker
 * 历史不落盘）、会话级共享 MCP 连接（docs/6 P2 路线 A：worker 带 mcp__ 工具，
 * 懒加载挂 rt.mcp，见 workerMcpToolsOf）。
 * SA3 冲突治理（§5）：并发/累计配额在本函数同步段检查（并行派发循环（docs/15：同轮多个 agent_task）
 * 天然串行经过这里，检查+占用不会插队）；req.scope 经 AgentDeps.writeScope 进工具
 * 上下文（文件三工具硬拒、pwsh 守卫强制弹卡）；中止/超时信号同时挂到审批串行队列
 * （排队中的卡快速排空）。
 * SA4 可观测性：生命周期广播 SSE subagent 事件（spawned/done/error，配额拒绝不发）；
 * 完成记录进 rt.subagents（审计随会话落盘，恢复时以条数续期 subagentTotal 累计闸）。
 * worker 不进 runtimes Map、不占会话档；工具级过程流 UI（方案 B：tool/toolResult
 * subagent 事件，不进前台历史）+ 用量聚合，结束后一次 reportUsage 计入父会话 totals
 * （breakdown 差额归 other，守恒不破）。
 *
 * docs/9 可复用与归档：子代理分两类——一次性（缺省，任务结束即自动归档，行为与上述
 * 完全一致）与可复用（req.reusable）：装配一次跨任务驻留（Agent 与完整历史延续），
 * 每任务结束转 idle 待命（SSE phase:"idle" + 记录按 subId upsert state:"idle"），
 * SubagentService.followup 向空闲实例追加任务（历史延续即复用价值；scope/effort 等
 * Agent 构造期参数沿用首次派发），applySubagentControl 的 archive 动作 / 句柄
 * requestArchive 归档（idle 立即；执行中=中止当前任务后于收尾归档）。归档后
 * 仅可查看（记录 + transcript 只读），句柄注销不可再派。
 * docs/17 存档注入与重启唤醒：transcript.json 改为主对话 SessionData 同构格式
 * （kind:"subagent" + subagent 元数据块，含复活所需的 scope/effort/system 构造期参数）；
 * followup 命中「待命记录仍在、实例不在线、有存档」时自动唤醒——从存档回读完整历史
 * （Agent.restore 与主对话恢复同口径），按存档 meta 重装 Agent，同 subId 继续复用；
 * read_archive 工具（modules/tools/read-archive）经 archiveSourceOf 解析存档并渲染为
 * 可读文本注入上下文（主对话记录与子代理存档同一读取口径）。
 *
 * docs/11 W1（异常变动报告协调者）：界面归档空闲可复用子代理（协调者不可见的异常变动）
 * 向其收件箱送达状态通知；归档中止的任务结果带 archived:"request"（报告层输出归档说明
 * 而非待命提示）。
 *
 * docs/16（完成即时送达，派发非阻塞化）：agent_task/agent_followup 全部改为**非阻塞
 * 派发**——SubagentService.dispatch/followup 同步完成配额/寻址裁决并启动任务，立即返回
 * 受理回执（SubagentDispatch）；任务结算（完成/失败/打断/归档中止）后报告一律经
 * deliverToCoordinator 送进协调者收件箱（与用户运行中插话共队列，FIFO 按完成顺序逐条
 * 开轮处理；空闲时立即开轮；轮末排空时相邻报告合并为一轮，见 session-lifecycle）。
 * 协调者感知子代理状态的唯一事实源是送达消息与派发回执文本——SSE 事件不进协调者历史。
 * docs/11 的「暂停先行返回」（facing 通道）随阻塞式派发一并退役：pause 不再需要唤醒任何
 * 等待方（派发即返回，本就没有等待方），界面暂停（协调者不可见的异常变动）送达状态通知。
 *
 * docs/18（暂停/恢复机制退役，打断即终结）：W2-S 的轮边界挂起（pauseGate/闸门/打断重发）
 * 整体删除——挂起的 worker 站着并发槽不结算、一次性子代理无法归档，与「打断」的直觉相悖。
 * 新语义：stop（工具 stop_subagent / 界面 ⏹）= 置 stopRequested 标记 + ctl.abort()，复用
 * 归档中止同款收尾链（进行中的 LLM 请求/工具执行/排队审批一并取消）——一次性子代理随即
 * 归档收尾；可复用子代理转 idle 待命（保留上下文，继续工作只能经 agent_followup 发新
 * 任务书，没有「恢复」）。失败归因独立文案「任务被用户停止」。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ARCHIVE_RENDER_MAX_CHARS, SUBAGENT_ARCHIVE_CONTEXT_PCT, SUBAGENT_FOLLOWUP_CONTEXT_PCT, SUBAGENT_MAX_CONCURRENT, SUBAGENT_MAX_TASKS, SUBAGENT_MAX_TOOL_ROUNDS, SUBAGENT_MAX_TOTAL, SUBAGENT_RESULT_MAX_CHARS, SUBAGENT_WARN_CONTEXT_PCT } from "../config.ts";
import { loadMcpConfig } from "../mcp/manager.ts";
import { pruneToolResult } from "../tools/prune.ts";
import { ToolRegistry, type Tool } from "../tools/registry.ts";
import { Agent, type AgentUi } from "../agent.ts";
import { createWorkspace, readAgentsMd } from "../workspace.ts";
import type { ProviderConfig } from "../providers/store.ts";
import type { ChatMessage, EffortSetting } from "../llm/provider.ts";
import { Registry } from "../core/registry.ts";
import { readerLedger } from "../core/file-tools.ts";
import { SSE_EVENTS, AUTO_DELIVERY_PREFIXES } from "../core/events.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.ts";
import type { PromptSection, SectionContext, SubagentDispatch, SubagentRequest, SubagentResult, SubagentService, SubagentFollowup, SystemToolDeps } from "../core/types.ts";
import { assembleSystemPrompt } from "../core/sections.ts";
import { formatWorkerResult } from "../modules/tools/agent-task/agent-task.ts";
import type { ActiveSubagent, SessionRuntime } from "../core/host.ts";
import type { SessionData, SubagentArchiveMeta, SubagentRecord } from "./sessions.ts";
import { cfgOf, compactionDepsOf, reportUsage, requestApprovalFor, type SessionShell } from "./session-runtime.ts";

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

/** docs/20：协调者提示里的「子代理（worker）系统提示词说明」段正文——worker 共同系统
 *  提示的同构重放：与 mountWorkerAgent 的装配同源（ctx.promptSections 全量 + subagent-role；
 *  按派发参数附加的 ws.system 角色段/scope 不在其中）。render 惰性读 rt 当前状态——技能热更/
 *  worker MCP 首连（workerMcpToolsOf 触发 refreshSystemPrompt）后重建自动带新；无工作区
 *  （协调者未绑定时不可对话）返回 null 省段。 */
export function commonWorkerPromptSectionText(sh: SessionShell, rt: SessionRuntime): string | null {
  if (!rt.workspace) return null;
  // 与 toolDocsOf 同款行式：worker 受众系统工具的 summary 行（实例侧在 mountWorkerAgent
  // 注册后由 toolDocsOf 生成，这里按 def 直出——同一批 summary，排序规则一致）
  const toolDocs = sh.ctx.tools
    .all()
    .filter((d) => (d.audience ?? "worker") !== "coordinator" && d.summary)
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
  return (
    "# 子代理（worker）系统提示词说明\n" +
    "下面是每个子代理实际收到的系统提示词的共同部分原文（引用自子代理侧，不是对你的指令；按派发参数附加的任务角色段与写入范围不在其中）。" +
    "它们的基础规则、可用工具、可加载技能、MCP 服务器说明与遵循的 AGENTS.md 指令以此为准——派发任务书时与这些能力匹配：不要派它们做不到的事，也不要在任务书里重复其中已有的规则。" +
    "两级 AGENTS.md 全文也只在这里出现，你自身不再单独接收：\n\n" +
    assembleSystemPrompt(sections.all(), sc)
  );
}

/** worker 专用的子目录标签：seq 保证同会话唯一，name 只取文件系统安全字符。 */
function workerDirTag(seq: number, name: string): string {
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

/**
 * 派发启动的同步段（docs/16 非阻塞派发）：配额（C7）检查 + subagentTotal 自增 + spawned
 * 广播 + 控制句柄/并发登记全部同步完成——调用方（subagentServiceFor.dispatch，含 docs/15
 * 同轮多调用的并行分支天然串行经过这里）检查+登记构成原子段，不会被同批后续任务插队。
 * 超限立即 ok:false 回执——不排队（排队会让协调者误以为已受理）。ok=true 附任务 promise
 * （无人 await、与调用方解耦；结算值由服务层经 deliverToCoordinator 自动送达协调者）。
 */
function tryStartWorker(
  sh: SessionShell,
  rt: SessionRuntime,
  req: SubagentRequest,
  opts: { seq: number; signal?: AbortSignal; reusables?: Map<number, WorkerSession> },
): SubagentDispatch & { task?: Promise<SubagentResult> } {
  if (rt.workers.size >= SUBAGENT_MAX_CONCURRENT) {
    return {
      ok: false,
      error:
        `并发上限已达 ${SUBAGENT_MAX_CONCURRENT}（subagentMaxConcurrent）：本会话同时运行的子代理已满，` +
        "该任务未启动。请等现有子代理完成后再派（一次派发的任务数不要超过并发上限）。",
    };
  }
  if (rt.subagentTotal >= SUBAGENT_MAX_TOTAL) {
    return {
      ok: false,
      error: `累计上限已达 ${SUBAGENT_MAX_TOTAL}（subagentMaxTotal）：本会话派出的子代理总数已满，该任务未启动。`,
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
 * 失败一律 ok:false 返回（不抛错）。docs/16 后仅为直调便利出口（单测/冒烟脚本）——正式
 * 工具路径走 subagentServiceFor.dispatch（tryStartWorker 非阻塞派发 + 自动送达）。
 * docs/9：req.reusable=true 时装配的 Agent 跨任务驻留（任务结束转 idle 待命，followup/
 * archive 经 reusables Map 寻址）；一次性子代理的事件流与结果拼装与历史版本一致。
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

/**
 * worker 控制句柄与驻留上下文的同步构造（docs/9；docs/17 起首派发与重启唤醒共用）：
 * gate/active/ws 三件同步建好并登记（rt.activeSubagents.set；可复用再 reusables.set +
 * requestArchive 挂载）——登记先于装配，返回后句柄即可施控（装配窗口的打断/归档由
 * stopRequested/pendingArchive/archiveRequested 兜住）。broadcastSpawned=true 广播 spawned 事件（首派发；
 * 唤醒不广播——抽屉行已存在，随后 task 事件起跑翻行）。
 */
function createWorkerSession(
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
function makeWorkerUi(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession): AgentUi {
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
async function mountWorkerAgent(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession, ui: AgentUi): Promise<Agent> {
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
    maxToolRounds: SUBAGENT_MAX_TOOL_ROUNDS, // D5：达上限收尾总结，保证总能交报告
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

/** 装配 worker 并执行首个任务（tryStartWorker 配额通过后调用；docs/17 起装配三段共用）：
 *  spawned 广播 + 控制句柄注册（createWorkerSession）→ 构造期参数捕获（effort/scope/system
 *  ——transcript 存档 meta 由它生成，重启唤醒照此重装）→ Agent 装配（mountWorkerAgent）
 *  → runOneTask。 */
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

/**
 * 在 worker（ws）上执行一个任务并收尾（docs/9）：per-task 超时/中止信号与审批闭包、
 * followup 起跑事件（首任务省略——spawned 已表达）、报告修剪、transcript 累积重写、
 * 用量守恒上报，然后按类别分流——一次性：注销句柄 + done/error 事件 + 追加
 * state:"archived" 记录（与历史版本一致，仅记录多 state 字段）；可复用：转 idle 待命
 * （upsert state:"idle" 记录 + idle 事件），归档请求挂起时改走归档收尾。
 */
async function runOneTask(
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
        ...(transcript ? { transcript } : {}),
        tasks: ws.tasks,
        ...(ws.contextPct !== undefined ? { contextPct: ws.contextPct } : {}),
        ...(ws.elapsedMs > 0 ? { elapsedMs: ws.elapsedMs } : {}),
      });
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

/** worker 任务收尾时的上下文占用百分比（docs/10 R1）：估算输入（system + 工具 schema +
 *  技能 + 消息，Agent.contextEstimate 与主对话完全同口径）÷ 会话提供方上下文长度。
 *  Agent 未装配 / 长度非法（含测试桩无提供方）返回 undefined（记录不带字段）。 */
function contextPctOf(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession): number | undefined {
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
function deliverToCoordinator(sh: SessionShell, rt: SessionRuntime, text: string): void {
  (rt.inbox ??= []).push(text);
  const host = sh.ctx.sessionHost;
  if (rt.busy || !rt.workspace || sh.runtimes.get(rt.id) !== rt || !host) return;
  host.startTurn(rt, rt.inbox.shift()!);
}

/** 延迟送达的报告消息（docs/11 W1；docs/16 起为所有任务结算的送达形态）：与历史工具结果
 *  同格式（协调者既有的阅读习惯）+ 送达前缀；一次性子代理补自动归档注记（状态显式可见）。 */
function reportMessage(res: SubagentResult, name: string): string {
  const body = formatWorkerResult(res, name, { warnPct: SUBAGENT_WARN_CONTEXT_PCT, followupPct: SUBAGENT_FOLLOWUP_CONTEXT_PCT });
  const tail = res.reusable ? "" : "\n（该子代理为一次性：任务结束已自动归档。）";
  return `${AUTO_DELIVERY_PREFIXES.report}\n${body}${tail}`;
}

/** 归档入口（docs/9，句柄 requestArchive 的实现）：执行中 → 中止当前任务并在其收尾时
 *  归档（pendingArchive 标记）；idle → 立即归档；装配中（Agent 未就绪）→ 标记挂起，装配
 *  完成直接归档不执行任务。via（docs/11 W1）："ui"=界面按钮——空闲路径的归档是协调者
 *  看不见的异常变动，向其收件箱送达状态通知（"model"=工具路径，返回文案本身已抵达协调者）。
 *  返回面向调用方的结果文案。 */
function requestArchiveWorker(
  sh: SessionShell,
  rt: SessionRuntime,
  ws: WorkerSession,
  reusables: Map<number, WorkerSession>,
  via: "ui" | "model" = "model",
): string {
  if (ws.cur) {
    ws.cur.pendingArchive = true;
    ws.cur.ctl.abort();
    return `已请求归档：子代理 ${ws.name}#${ws.subId} 的当前任务将被中止，并在其结束后归档（之后不可再派任务）。`;
  }
  if (!ws.agent) {
    ws.archiveRequested = true; // 装配窗口：startWorker 装配完成后直接归档收尾
    return `已请求归档：子代理 ${ws.name}#${ws.subId} 尚在装配，将不执行任务直接归档（之后不可再派任务）。`;
  }
  const archiveNotice =
    ws.transcript !== undefined
      ? `可复用子代理 ${ws.name}#${ws.subId} 已被用户归档（不可再用 agent_followup 追加任务；需要继续该方向的工作时用 agent_task 重新派发，任务书可让它先用 read_archive（subId=${ws.subId}）读过程存档接续上下文 [[过程档案#${ws.subId}]]）。`
      : `可复用子代理 ${ws.name}#${ws.subId} 已被用户归档（不可再用 agent_followup 追加任务；需要继续该方向的工作时用 agent_task 重新派发）。`;
  finalizeArchive(sh, rt, ws, reusables);
  if (via === "ui") deliverToCoordinator(sh, rt, `${AUTO_DELIVERY_PREFIXES.status} ${archiveNotice}`);
  return `已归档子代理：${ws.name}#${ws.subId}（共完成 ${ws.tasks} 次任务）。归档后仅可查看过程存档，不可再派任务。`;
}

/** 记录 upsert（docs/9 可复用）：按 subId 定位替换（无则追加）。 */
function upsertSubagentRecord(rt: SessionRuntime, rec: SubagentRecord): void {
  const i = rt.subagents.findIndex((r) => r.subId === rec.subId);
  if (i >= 0) rt.subagents[i] = rec;
  else rt.subagents.push(rec);
}

/** 可复用子代理的记录构造（docs/9）：ok/error=最近一次任务；rounds/usage/tasks/elapsedMs=累计。 */
function reusableRecord(ws: WorkerSession, state: "idle" | "archived"): SubagentRecord {
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
function finalizeArchive(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession, reusables: Map<number, WorkerSession>): void {
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
}

// ---------- docs/17 存档注入与重启唤醒 ----------

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

/** followup 上下文门槛拒收文案（docs/10 R1；在线与唤醒两路共用，docs/17 起指引 read_archive）。 */
function followupContextReject(name: string, subId: number, pct: number): string {
  return (
    `子代理 ${name}#${subId} 的上下文占用已达 ${pct}%（上限 ${SUBAGENT_FOLLOWUP_CONTEXT_PCT}%，subagentFollowupContextPct）——上下文过长的子代理继续任务容易产生幻觉，不宜再追加。` +
    `请用 archive_subagent 归档后用 agent_task 重新派发；任务书可让它先用 read_archive（subId=${subId}）读过程存档接续上下文 [[过程档案#${subId}]]。`
  );
}

/**
 * 重启唤醒（docs/17）：followup 命中「待命记录仍在、运行实例不在线、有过程存档」的可复用
 * 子代理时走此路径——从存档回读完整历史（Agent.restore 与主对话恢复同口径），按存档 meta
 * 重装 Agent（scope/effort/system 沿用首次派发；旧格式存档无 meta 时继承会话缺省），同
 * subId 复活后执行追加任务（task 事件起跑、报告自动送达，与在线 followup 完全同口径）。
 * 同步段完成存档读取/闸门复查/句柄登记（防插队）；装配与任务异步推进；唤醒装配失败按
 * startWorker 同款归档收尾。返回受理回执（调用方=SubagentService.followup）。
 */
function reviveFollowup(
  sh: SessionShell,
  rt: SessionRuntime,
  reusables: Map<number, WorkerSession>,
  rec: SubagentRecord,
  freq: SubagentFollowup,
  signal: AbortSignal | undefined,
  deliver: (p: Promise<SubagentResult>, name: string) => void,
): SubagentDispatch {
  // 闸门复查（与在线 followup 同口径，先于存档读取——不读注定被拒的档；数字用存档记录的累计值）
  if ((rec.tasks ?? 0) >= SUBAGENT_MAX_TASKS) {
    return {
      ok: false,
      error: `任务次数上限已达 ${SUBAGENT_MAX_TASKS}（subagentMaxTasks）：子代理 ${rec.name}#${rec.subId} 的累计任务数已满。请用 archive_subagent 归档后重新 agent_task 派发。`,
    };
  }
  if (rec.contextPct !== undefined && rec.contextPct >= SUBAGENT_FOLLOWUP_CONTEXT_PCT) {
    return { ok: false, error: followupContextReject(rec.name, rec.subId, rec.contextPct) };
  }
  if (rt.workers.size >= SUBAGENT_MAX_CONCURRENT) {
    return {
      ok: false,
      error: `并发上限已达 ${SUBAGENT_MAX_CONCURRENT}（subagentMaxConcurrent）：本会话同时运行的子代理已满，该任务未启动。请等现有子代理完成后再派。`,
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

/** 用量盒 → { usage? } 拼装（有量才带字段；原 runWorker 成功路径同款）。 */
function usageFields(u: { prompt: number; completion: number; reasoning: number; cacheHit: number }): { usage?: { prompt: number; completion: number; reasoning?: number; cacheHit?: number } } {
  if (u.prompt <= 0 && u.completion <= 0) return {};
  return {
    usage: { prompt: u.prompt, completion: u.completion, ...(u.reasoning ? { reasoning: u.reasoning } : {}), ...(u.cacheHit ? { cacheHit: u.cacheHit } : {}) },
  };
}

/** 控制入口的唯一实现（W2-S；docs/18 起暂停/恢复退役）：按 subId（优先）或 name 匹配
 *  活动子代理并施加 stop（打断当前任务，同名者全部生效）或 archive（归档可复用子代理
 *  ——空闲立即归档，执行中=中止当前任务后归档；一次性子代理不支持手动归档）。idle 态
 *  没有任务在执行，无 stop 对象。两处消费——createRuntime 注入协调者工具的
 *  deps.subagentControl、web-sessions 的 /api/subagent/control 路由。返回面向调用方
 *  （模型/HTTP）的结果文案；miss 时附活动清单供自纠错。 */
export function applySubagentControl(
  rt: SessionRuntime,
  target: { name?: string; subId?: number },
  action: "stop" | "archive",
  via: "ui" | "model" = "model",
): string {
  const live = [...rt.activeSubagents.values()];
  const matches =
    target.subId !== undefined
      ? live.filter((a) => a.subId === target.subId)
      : target.name !== undefined
        ? live.filter((a) => a.name === target.name)
        : [];
  if (matches.length === 0) {
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

/** worker 全程 transcript 落盘（docs/6 P3 方案 A；docs/17 起为主对话 SessionData 同构格式）：
 *  kind:"subagent" + subagent 元数据块（累计统计 + 复活所需的 scope/effort/system 构造期
 *  参数）+ messages（标准 ChatMessage[]，含思考块与工具调用/结果；不含系统提示——按工作区
 *  可重建，省一份重复），另带 id/title/updatedAt/workspace/messageCount/runMs/totals 主档
 *  同名字段。同一形状三处消费一个口径：/api/subagent-transcript（前端抽屉）、read_archive
 *  （存档注入）、followup 唤醒（历史回读 + 构造期参数还原）。写到 worker 私有 spill 子目录
 *  的 transcript.json（目录随会话删除连带清理）；返回相对 spill/<sessionId>/ 的路径供
 *  SubagentRecord/SubagentResult/SSE 事件携带。失败返回 undefined。 */
function dumpTranscript(sh: SessionShell, rt: SessionRuntime, ws: WorkerSession, state: "idle" | "archived"): string | undefined {
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

/** worker 收尾统一出口（SA4，一次性子代理）：审计记录进 rt.subagents（随 toSessionData
 *  落盘、恢复续期配额）+ 广播 done/error 事件（前端工具块时间线；usage/rounds 与结果同源）。
 *  docs/9：一次性任务结束即自动归档——记录带 state:"archived"。
 *  transcript（docs/6 P3 方案 A）：过程存档相对路径，记录与事件都携带——前端时间线行
 *  与报告标记据此显示「📄 过程」入口。 */
function finishSubagent(
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
}

/** worker 全程用量一次计入父会话（分类明细随 worker 历史消亡，差额归 other——守恒不变量 1）。 */
function reportAggregated(sh: SessionShell, rt: SessionRuntime, usage: { prompt: number; completion: number; reasoning: number; cacheHit: number }): void {
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

/**
 * 子代理服务（按会话实例化，P8 seam 的 v2 实现）：默认名自动编号 sub-1/sub-2。
 * server.ts bootstrap 经 ctx.subagent 挂载；createRuntime 对 kind=coordinator 注入给
 * agent_task/agent_followup。docs/16：两方法都是**非阻塞派发**——同步完成配额/寻址裁决
 * 并启动（tryStartWorker 的同步段原子完成检查+登记），立即返回 SubagentDispatch 回执；
 * 任务 promise 与调用方解耦，结算（完成/失败/打断/归档中止）后报告一律经
 * deliverToCoordinator 自动送达协调者（异常归一化 ok:false，不抛错）。
 * docs/9：reusables Map 持有本会话存活的可复用 worker 驻留上下文（followup 寻址/归档释放）；
 * seq 惰性从存档记录最大 subId 续期（服务创建早于存档恢复，且防重启后与可复用记录
 * upsert 撞 subId）。
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
      if (ws.tasks >= SUBAGENT_MAX_TASKS) {
        return {
          ok: false,
          error: `任务次数上限已达 ${SUBAGENT_MAX_TASKS}（subagentMaxTasks）：子代理 ${ws.name}#${ws.subId} 的累计任务数已满。请用 archive_subagent 归档后重新 agent_task 派发。`,
        };
      }
      // docs/10 R1：上下文门槛（默认 35%）——上下文过长的子代理继续任务容易产生幻觉，
      // 服务端硬闸拒绝（不依赖模型自觉读数）；指引归档重派 + read_archive 存档接续。
      if (ws.contextPct !== undefined && ws.contextPct >= SUBAGENT_FOLLOWUP_CONTEXT_PCT) {
        return { ok: false, error: followupContextReject(ws.name, ws.subId, ws.contextPct) };
      }
      if (rt.workers.size >= SUBAGENT_MAX_CONCURRENT) {
        return {
          ok: false,
          error: `并发上限已达 ${SUBAGENT_MAX_CONCURRENT}（subagentMaxConcurrent）：本会话同时运行的子代理已满，该任务未启动。请等现有子代理完成后再派。`,
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

/** followup 目标解析结果（docs/17 起结构化）：在线空闲实例 / 可唤醒记录（待命记录仍在、
 *  实例不在线、有过程存档——followup 自动走复活路径） / 明确错误文案。 */
type FindReusableResult = WorkerSession | { revivable: SubagentRecord } | { error: string };

/** followup 目标解析（docs/9；docs/17 修订唤醒语义）：按 subId（优先）或 name（存活可复用
 *  中必须唯一）定位空闲待命的 WorkerSession；各种不可派状态（不存在/已归档/同名歧义/
 *  执行中）各给明确文案；「记录在、实例不在线」的 idle 可复用子代理有存档即返回
 *  revivable（自动唤醒），无存档才报失效。归档过的驻留已从 Map 与 activeSubagents 注销
 *  ——这里查到的在线的都是存活的。 */
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
      if (rec.state === "idle") {
        // docs/17：待命记录仍在、运行实例不在线（服务重启）——有过程存档即可唤醒
        if (rec.reusable && rec.transcript) return { revivable: rec };
        return {
          error:
            `子代理 ${rec.name}#${rec.subId} 的待命记录仍在，但其运行实例已不在线，且没有可唤醒的过程存档（未落盘成功或已被清理）。` +
            `请用 agent_task 重新派发；任务书可让它先用 read_archive（subId=${rec.subId}）读过程存档接续上下文（存档也不可用时无法接续）。`,
        };
      }
      return {
        error: `子代理 ${rec.name}#${rec.subId} 已归档，不可再派任务${rec.reusable ? "" : "（一次性子代理用完即归档）"}。请用 agent_task 重新派发。`,
      };
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
