/**
 * 会话宿主接缝（模块化架构重构 §4.10）：SessionRuntime 是各路由 handler 与
 * 壳侧装配逻辑之间的共享通货，SessionHost 是 web-* 模块触碰会话机器的
 * 唯一通道（模块 ↛ 壳：handler 需要的能力经 setup 时捕获的 ctx.sessionHost
 * 取用，避免模块反向 import server.ts）。两个类型只含类型导出，无运行时代价。
 * SessionHost 的成员集 = 现有路由清单的真实需求（多一个都不要）。
 */
import type { Agent } from "../agent.ts";
import type { CompactOutcome, CompactionRecord } from "../compaction.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { ProviderConfig, ProviderFile } from "../providers/store.ts";
import type { Tool, ToolRegistry } from "../tools/registry.ts";
import type { Workspace } from "../workspace.ts";
import type { SessionStore, SubagentRecord } from "../web/sessions.ts";
import type { ApprovalDecision, AuditEvent, AskMode } from "../approval/types.ts";
import type { SandboxMode } from "../sandbox/types.ts";
import type { ChatImage, ChatMessage, EffortSetting, LLMProvider, UsageBreakdown } from "../llm/provider.ts";
import type { SkillInfo } from "./skills.ts";
import type { SseEventName } from "./events.ts";
import type { AskUserAnswer, SubagentResult } from "./types.ts";
import type { FileLedger } from "./file-tools.ts";
import type { ProviderLimitKind } from "./progress.ts";

/** 活动子代理的控制句柄（W2-S，docs/18 起暂停/恢复机制退役）：由 web/subagents.ts 的
 *  runWorker 创建登记，stop_subagent 工具与 /api/subagent/control 路由经
 *  applySubagentControl 施控。可复用子代理（docs/9）的句柄跨任务驻留（spawn→archive）：
 *  任务结束后 status="idle" 待命，followup 再入 run；archive_subagent/UI 经 requestArchive
 *  归档（归档即注销句柄）。一次性子代理仍为 spawn→done/error（status 恒 "run"，结束即注销）。 */
export interface ActiveSubagent {
  subId: number;
  name: string;
  /** 可复生子代理标记（docs/9）：句柄跨任务驻留；一次性子代理缺省不写 */
  reusable?: boolean;
  /** 只读子代理（docs/42）：状态表标注「只读」 */
  readOnly?: boolean;
  /** 生命周期（docs/9）：run=任务执行中；idle=可复用待命（无进行中任务）。一次性子代理只有 run。 */
  status: "run" | "idle";
  /** 任务摘要（可复用子代理 idle 行展示；随 followup 更新为最近任务摘要） */
  summary?: string;
  /** 已完成任务数（可复用子代理） */
  tasks?: number;
  /** 最近一次任务收尾时的上下文占用百分比（docs/10 R1；任务边界更新的快照） */
  contextPct?: number;
  /** 当前任务开始时刻（epoch ms；run 态有值，前端本地滴答显示「本次用时」；idle 清空） */
  taskStartedAt?: number;
  /** 累计运行毫秒（跨任务，含进行中任务的已耗时；快照下发/轮询消费） */
  liveElapsedMs?(): number | undefined;
  /** 实时上下文占用（docs/10 R1 修订：一直显示）——run 态实时估算（估算器带逐消息缓存，
   *  重复调用成本低），idle 态返回收尾快照；Agent 未装配返回 undefined。前端列表行/
   *  详情页轮询消费。 */
  liveContextPct?(): number | undefined;
  /** 打断（docs/18：暂停/恢复机制退役，打断即终结）：立即中止当前任务——进行中的 LLM 请求、
   *  工具执行与排队中的审批一并取消，任务随即结算（一次性=归档收尾；可复用=转 idle 待命，
   *  继续工作只能经 agent_followup 发新任务）。via 区分入口："ui"=界面按钮——协调者看不见
   *  的异常变动，实现侧会向其收件箱自动送达状态通知；"model"（缺省）=stop_subagent 工具
   *  （返回文案本身已抵达协调者，不重复送）。幂等；仅 status==="run" 生效。 */
  stop(via?: "ui" | "model"): void;
  /** 归档入口（docs/9，仅可复用句柄）：idle→立即归档；执行中→中止当前任务并在收尾时
   *  归档。via（docs/11 W1）区分入口："ui"=界面按钮——空闲归档是协调者看不见的异常变动，
   *  实现侧会向协调者收件箱送达状态通知；"model"=archive_subagent 工具（返回文案本身已
   *  抵达协调者，不重复送）。返回面向调用方（模型/HTTP）的结果文案。 */
  requestArchive?(via?: "ui" | "model"): string;
  /** 运行中 worker 的实时历史快照（不含系统提示，docs/8 第三棒）：/api/subagent-transcript
   *  对运行中 worker 服务——前端抽屉详情页轮询拉取（思考/正文/工具与结果全量，刷新/切回
   *  不丢）。worker Agent 在句柄登记之后才装配，实现侧闭包读当前值；装配前返回空数组。 */
  liveMessages?(): ChatMessage[];
}

/** 会话级运行设置（随会话存档的四个开关）。 */
export interface RuntimeSettings {
  alwaysConfirm: boolean;
  effort: EffortSetting;
  askMode: AskMode;
  sandboxMode: SandboxMode;
}

/** 每会话常驻运行态：切换对话不销毁，后台会话继续运行。 */
export interface SessionRuntime {
  id: string;
  workspace: Workspace | null; // null=引导占位（未选择工作区，禁止对话）
  /** 会话形态：normal=普通会话（现状）；coordinator=仅 agent_task(s) 工具的前台协调者（docs/5） */
  kind: "normal" | "coordinator";
  agent: Agent;
  llm: LLMProvider;
  providerId: string;
  settings: RuntimeSettings;
  totals: {
    prompt: number;
    completion: number;
    cacheHit: number;
    reasoning: number;
    breakdown: UsageBreakdown;
  };
  auditEvents: AuditEvent[];
  compactions: CompactionRecord[];
  skills: SkillInfo[];
  mcp: McpManager;
  /** MCP 后台装配Promise（docs/28 P1-3）：会话创建/换绑不再阻塞在 stdio 握手上——连接
   *  完成后热更系统提示 MCP 段并广播 state；startTurn 开跑前 await 它（首条消息发出时
   *  mcp__ 工具与说明书必已就位，语义与旧串行装配等价）。永不 reject（失败降级无 MCP）。 */
  mcpReady?: Promise<void>;
  registry: ToolRegistry;
  busy: boolean;
  /** 累计运行毫秒（只计已结束的轮；随会话存档/恢复，前端显示「累计运行时间」） */
  runMs: number;
  /** 当前运行轮的开始时刻（epoch ms；busy 时有值，前端本地滴答显示「本次运行时间」） */
  turnStartedAt: number | null;
  abortCtl: AbortController | null;
  pendingApproval: ((decision: ApprovalDecision) => void) | null;
  /** ask_user 的待答槽（docs/32）：askId → 决议回调。Map 而非单槽——同轮并行多个提问
   *  （协调者同轮多工具并行执行）不互相覆盖；/api/ask-user 按 id 决议，/api/stop 与
   *  轮中止经信号触发 cancelled。瞬态不入档（与 pendingApproval 同口径）。 */
  pendingAskUsers: Map<string, (answer: AskUserAnswer) => void>;
  /** 审批串行链（docs/5 §5.2 C3）：会话级共享——前台 agent 与每个 worker 的审批请求
   *  排同一条链，doAsk 单槽在互斥下同时至多一张卡在等（不能挂在 requestApprovalFor
   *  闭包里：每个 worker 会拿到自己的新链，互不排队） */
  approvalChain?: Promise<unknown>;
  /** 协调者会话 busy 期排队的用户消息（W2-L1，docs/7 §2.3）：/api/chat 对 busy 协调者
   *  不再 409 而是入队（FIFO），轮结束由 startTurn finally 逐条消费各开一轮。瞬态
   *  不入档（重启即失效，用户消息未进 history 前不落盘）；普通会话不用（busy 仍 409）。 */
  inbox?: string[];
  /** 当前运行轮的锚点（开始时历史长度+用户消息）：前端切走再切回时用它对齐重放实时事件 */
  turnInfo: { ml: number; userText: string } | null;
  /** 首轮装配进度已展示过（docs/36，瞬态不入档）：本运行实例只在第一条消息开跑时广播
   *  装配步骤（系统提示词/技能/两级 AGENTS.md → MCP 注入 → 请求已发出）；重启/恢复档的
   *  运行实例是新对象，首条消息同样展示（MCP 重连等待正好需要这个可见性）。 */
  assemblyShown?: boolean;
  /** 本会话活动 worker（并行闸与中止级联用；SA3 起由 subagentServiceFor 登记/注销） */
  workers: Set<Promise<SubagentResult>>;
  /** 本会话累计派出的 worker 数（C7 累计闸；跨轮持续，重启从存档 subagents 记录条数续期） */
  subagentTotal: number;
  /** 已完成 worker 的审计记录（docs/5 SA4）：随 toSessionData 落盘、currentState 下发 /status */
  subagents: SubagentRecord[];
  /** 已读文件台账（hash 乐观锁）：本会话与其派出的全部 worker 共享同一实例（docs/5 §5.3） */
  fileLedger: FileLedger;
  /** worker 共享的 MCP 工具快照（docs/6 P2 路线 A，修订 docs/5 偏差 19：worker 带、
   *  协调者仍不带）：首个 runWorker 懒加载——连接挂本会话 rt.mcp（协调者会话该 manager
   *  闲置：D3 协调者不装配），apply 到一次性模板 registry 后拍快照；promise 缓存防并行
   *  首派双连（每 server 一个进程，全部 worker 共享）。null=无 MCP 配置/装配失败降级。 */
  workerMcp?: Promise<readonly Tool[] | null>;
  /** 活动子代理的控制句柄登记（W2-S，docs/18 起暂停/恢复退役、打断即终结）：runWorker 启动时
   *  登记、收尾注销。stop=打断当前任务（中止请求/工具/审批，任务随即结算）；瞬态不入档
   *  （worker 运行实例不跨重启存活；docs/17：可复用子代理重启后由 agent_followup 从过程存档
   *  自动唤醒）。 */
  activeSubagents: Map<number, ActiveSubagent>;
  /** 本会话观察到的提供方限流（docs/42，瞬态不入档）：子代理任务因速率限制/用量上限失败时
   *  记一笔——subagent_status 状态表与派发回执附注消费（提供方没有额度查询接口，限流发生后
   *  如实记录是对协调者可见的那一半）。 */
  subagentLimits?: Array<{ at: number; kind: ProviderLimitKind; message: string }>;
}

/** 会话列表载荷（GET /api/sessions 与 sessions 广播的形状）。 */
export interface SessionsPayload {
  current: string;
  viewSeq: number;
  running: string[];
  groups: ReturnType<SessionStore["listAllGrouped"]>;
  recycled: ReturnType<SessionStore["listRecycled"]>;
}

/**
 * web-* 模块可见的"宿主会话服务"最小集合（§4.10）：由 web 壳实现，
 * bootstrap 时挂到 ctx.sessionHost。方法而非裸属性——宿主在模块 setup 之后
 * 才完成装配，handler 只在请求期调用它们。
 */
export interface SessionHost {
  runtimes(): Map<string, SessionRuntime>;
  viewId(): string;
  viewRt(): SessionRuntime;
  busyIds(): string[];
  switchView(id: string): Promise<SessionRuntime | null>;
  /** 在指定工作区开新会话并切为当前视图；wsRoot=null 返回 null（无工作区可选）。
   *  kind="coordinator" 建协调者会话（docs/5 D9）；缺省 normal。 */
  newSessionForView(workspaceRoot: string | null, kind?: "normal" | "coordinator"): Promise<SessionRuntime | null>;
  /** 退出当前工作区时切到全新引导会话（/api/workspace/delete 的 wasCurrent 分支）。 */
  switchToBlankRuntime(): Promise<SessionRuntime>;
  bindWorkspace(rt: SessionRuntime, p: string): Promise<void>;
  /** images（docs/10 R3）：随 user 消息入历史的图片（有视觉能力的提供方直看）；缺省无图。 */
  startTurn(rt: SessionRuntime, text: string, images?: ChatImage[]): void;
  /** 手动压缩：opts.keepTokens 覆盖保留预算（/api/compact 传小预算立即显著变小；缺省按提供方比例）。 */
  compact(rt: SessionRuntime, opts?: { keepTokens?: number }): Promise<CompactOutcome>;
  persistSession(rt?: SessionRuntime): void;
  sweepEmptySessions(): void;
  /** 技能热重载（重扫 + 同步进系统提示），返回新清单。 */
  rescanSkills(rt: SessionRuntime): SkillInfo[];
  /** 会话切换到 cfg 提供方：重建 llm、回默认档位（save/activate/delete 共用的一句话语义）。 */
  applyProvider(rt: SessionRuntime, cfg: ProviderConfig): void;
  currentState(rt: SessionRuntime): unknown;
  sessionsPayload(): SessionsPayload;
  sessions(): SessionStore;
  providerFile(): ProviderFile;
  recentWorkspaces(): string[];
  setRecentWorkspaces(list: string[]): void;
  broadcast(event: SseEventName, data: unknown): void;
}
