/**
 * 内核扩展点类型（模块化架构重构 §3/§4）：core 只认识这些接口，不认识任何具体能力；
 * 各能力在 src/modules/* 实现 Definition 并注册进 HarnessContext 的对应 Registry。
 * MCP 传输（McpTransportDef/McpConnection）与路由（RouteDef/ServerRequest）已分别随
 * P5/P6 迁入；SessionHost 见 ./host.ts。
 */
import type { SkillInfo } from "./skills.ts";
import type { Tool } from "../tools/registry.ts";
import type { Workspace } from "../workspace.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.ts";
import type { SandboxMode } from "../sandbox/types.ts";
import type { SandboxRunner } from "../sandbox/runner.ts";
import type { ChatMessage, EffortSetting, LLMProvider, UsageInfo } from "../llm/provider.ts";
import type { ProviderConfig } from "../providers/store.ts";
import type { ServerRequest } from "./http.ts";
import type { SessionHost, SessionRuntime } from "./host.ts";
import type { HarnessContext } from "./context.ts";
import type { FileLedger } from "./file-tools.ts";

// ---------- 系统提示 section（§4.4） ----------

/** 系统提示的一段；buildSystemPrompt 按 order 升序渲染、null 跳过、\n\n 连接。 */
export interface PromptSection {
  name: string;
  /** 全局唯一序号（DSH SECTION_ORDERS 思路）：base=0, tools=10, skills=20, mcp=30, globalAgentsMd=40, workspaceAgentsMd=50 */
  order: number;
  /** 返回 null = 本段不注入 */
  render(sc: SectionContext): string | null;
}

/** section 渲染上下文：一次系统提示重建的全部输入。 */
export interface SectionContext {
  workspaceRoot: string;
  skills: SkillInfo[];
  mcpInstructions: string | null;
  globalAgentsMd: string | null;
  /** 工作区 AGENTS.md 内容（AgentDeps.agentsMd） */
  workspaceAgentsMd: string | null;
  /** 由系统工具清单生成：`${name} —— ${summary}`（不带 summary 的工具不入列，如 mcp__ 工具） */
  toolDocs: string[];
  /** 会话形态：normal=普通/子代理会话（缺省）；coordinator=协调者前台（无工具直用，base/skills/mcp 段按形态分支） */
  sessionKind?: "normal" | "coordinator";
  /** 会话提供方有视觉能力（docs/12 R2）：true=base 段注入图片直看指引（消息携带的图片
   *  直接看，优先自身视觉，不绕 view_image）；缺省/false 不注入（系统提示字节不变）。 */
  vision?: boolean;
}

// ---------- 系统工具（§4.5，P3 落地消费） ----------

export interface SystemToolDef {
  name: string;
  /** 系统提示工具段的一句话（生成"可用工具"行的来源） */
  summary: string;
  /** 工具面向的会话形态：worker=普通/子代理会话（缺省，现状不变）；coordinator=仅协调者会话注册；
   *  front=前台会话（普通+协调者，**不含子代理**，docs/32）——ask_user 用：子代理不确定时
   *  自行向协调者报告（写进报告的未决问题），不直接向用户提问。 */
  audience?: "worker" | "coordinator" | "front";
  /** 每会话实例化：load_skill 需要会话技能清单；pwsh 需要会话级升级额度 */
  create(deps: SystemToolDeps): Tool;
}

export interface SystemToolDeps {
  ctx: HarnessContext;
  workspace(): Workspace;
  skills(): SkillInfo[];
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  alwaysConfirm(): boolean;
  sandboxMode(): SandboxMode;
  spillDir(): string | undefined;
  privateTempDir(): string | undefined;
  /** 本会话 MCP 连接状态行（/status 同源，只读） */
  mcpStatus(): string[];
  /** 重新加载 mcp.json（全局+工作区合并）并整体重连本会话，返回重连后的状态行（manage_mcp 写入后调用） */
  reloadMcp(): Promise<string[]>;
  /** 已读文件台账（会话级乐观锁）：write_file 覆写 / edit_file 编辑的前置凭据；
   *  协调者会话与其全部 worker 共享同一实例（docs/5 §5.3） */
  ledger: FileLedger;
  /** 子代理服务（协调者会话装配时注入；普通会话为 undefined）。agent_task(s) 工具经此派 worker，
   *  agent_followup 经 followup 向空闲待命的可复用子代理追加任务（docs/9） */
  subagent?: SubagentService;
  /** 子代理控制（协调者会话装配时注入；普通会话为 undefined）。pause/resume_subagent
   *  工具与 /api/subagent/control 路由经此施控（W2-S，docs/7 §2.3 轮边界挂起）；
   *  archive（docs/9）= 归档可复用子代理（空闲立即归档；执行/暂停中中止当前任务后归档） */
  subagentControl?: (target: { name?: string; subId?: number }, action: "stop" | "archive") => string;
  /** 子代理状态表（协调者会话装配时注入；普通会话为 undefined，docs/32）：subagent_status
   *  工具经此取活动子代理（run/idle）实时状态与可选历史记录的只读快照文案
   *  （web/subagents.ts subagentStatusText 装配）。 */
  subagentStatus?: (opts?: { all?: boolean }) => string;
  /** 视觉模型配置（docs/10 R3）：解析 providers.json 的 visionProvider 指向的提供方；
   *  未配置/指向的提供方已删 → null（view_image 据此报错指引配置）。 */
  vision?(): ProviderConfig | null;
  /** 会话自身提供方的视觉能力（docs/12 R2）：当前提供方勾了视觉 → 其配置，否则 null。
   *  view_image 优先用它（模型自己读盘上图片——视觉会话免配视觉模型即开即用）；
   *  无自身视觉时才回退 vision() 借用用户配置的视觉模型。 */
  selfVision?(): ProviderConfig | null;
  /** 工具内辅助 LLM 调用的用量上报（docs/10 R3 view_image）：计入会话合计（六类守恒），
   *  breakdown 全归 other（调用发生在工具内部，输入构成不属会话上下文分类——
   *  reportAggregated 先例）。 */
  reportAuxUsage?(u: UsageInfo): void;
  /** 存档解析接缝（docs/17；read_archive 工具经此取存档）：subId=本会话子代理过程存档
   *  （记录 → spill transcript），sessionId=主对话会话档。二选一；返回面向模型的标签行
   *  与原始 messages（JSON→可读文本的渲染在工具层）；失败附可用清单供自纠错。
   *  实现由 web/subagents.ts archiveSourceOf 提供（主会话与全部 worker 同一闭包）。 */
  archiveSource?(q: { subId?: number; sessionId?: string }): { ok: true; label: string; messages: ChatMessage[] } | { ok: false; error: string };
  /** 询问用户（前台会话装配；worker 不注入——docs/32 双层防线之二）：ask_user 工具经此
   *  弹卡并阻塞等待用户回答（点选选项或「其它」自由输入）。实现由 web/session-runtime.ts
   *  askUserFor 提供（SSE askUser 事件 + rt.pendingAskUsers 槽 + /api/ask-user 决议）；
   *  中止信号触发时以 {cancelled:true} 收场（工具层据此告知模型「未回答，勿假设答案」）。 */
  askUser?(q: { question: string; options: string[]; signal?: AbortSignal }): Promise<AskUserAnswer>;
}

/** ask_user 的一条用户回答（docs/32）：choice=点选的选项下标（0 起，工具层回读选项文本）；
 *  text=「其它」自由输入原文。二者互斥到达；cancelled=请求已中止/会话已停止（未回答）。 */
export interface AskUserAnswer {
  choice?: number;
  text?: string;
  cancelled?: true;
}

// ---------- 提供方格式（§4.6，P4 落地消费） ----------

export interface ProviderFormatDef {
  /** "openai" | "anthropic" | 未来值 */
  format: string;
  /** UI 显示名 */
  label: string;
  create(cfg: ProviderConfig): LLMProvider;
  /** 新会话/表单缺省思考档位（收敛 deepseek 特判） */
  defaultEffort(): EffortSetting;
  /** 保存表单时该格式是否要求 apiKey 之外的特殊校验（可选） */
  validate?(cfg: Partial<ProviderConfig>): string | null;
}

// ---------- 技能来源（§4.8，P5 落地消费） ----------

export interface SkillSourceDef {
  /** "global" | "workspace" | 未来值 */
  name: string;
  /** 该来源的扫描目录；不适用（如无工作区）返回 null */
  dir(workspaceRoot: string | null): string | null;
}

// ---------- 沙箱后端（§4.9，P5 落地消费） ----------

export interface SandboxBackendDef {
  /** "windows-acl" | "fail-closed" | 未来值 */
  id: string;
  /** 平台/依赖探测；不可用返回 false（选型时跳过） */
  available(): boolean;
  create(): SandboxRunner;
}

// ---------- MCP 传输（§4.7，P5 落地消费） ----------

/** MCP 工具名前缀（tokens.ts 分类与 mcp/manager.ts 注册的共享约定，两处引用同一常量）。 */
export const MCP_TOOL_PREFIX = "mcp__";

export interface McpServerConfig {
  /** 传输类型；缺省 "stdio"（未来 "http" 等） */
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 一条已握手的 MCP 连接（传输无关）。 */
export interface McpConnection {
  /** 服务器在 initialize 握手时提供的 instructions（使用说明，注入系统提示用）；未提供为 null */
  instructions: string | null;
  serverInfo: { name?: string; version?: string };
  listTools(): McpToolInfo[];
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string>;
  readonly alive: boolean;
  stop(): void;
}

export interface McpTransportDef {
  /** "stdio"（未来 "http" 等） */
  type: string;
  /** 建立连接并完成握手（含拉取工具列表）；失败抛错由调用方（manager）记录并继续 */
  connect(serverName: string, cfg: McpServerConfig): Promise<McpConnection>;
}

// ---------- 路由（§4.10，P6 落地消费） ----------

/** 一条 API 端点：web-* 模块在 setup 里注册，server 瘦壳只做查表分发。 */
export interface RouteDef {
  method: "GET" | "POST";
  /** 本服务内 path 全局唯一（GET/POST 不共用同一路径），Registry 以此为键 */
  path: string;
  handler(r: ServerRequest): Promise<void> | void;
}

// ---------- 子代理（P8 预留 seam；v2 演进为 worker 运行机制，见 docs/5） ----------

/** 一次子代理（worker）运行的请求：独立历史与工具循环，不写父会话历史。 */
export interface SubagentRequest {
  /** 任务指令（作为 user 消息开启子代理历史；任务书必须自包含——worker 看不到父会话历史） */
  task: string;
  /** 短名（审计/事件/审批标注用，如 "impl-auth"）；缺省自动编号 sub-1/sub-2 */
  name?: string;
  /** 一句话摘要（审批卡与 SSE 事件展示） */
  description?: string;
  /** 角色指令：追加为独立系统提示 section（order 5，位于 base 之后、tools 之前） */
  system?: string;
  /** 思考档位覆盖；缺省继承父会话当前档位（worker 干实事；v1 的缺省 off 语义已废弃） */
  effort?: EffortSetting;
  /** 超时毫秒；缺省不限时 */
  timeoutMs?: number;
  /** 允许写入的范围（相对工作区根的路径前缀，如 ["src/auth"]）；缺省=整个工作区 */
  scope?: string[];
  /** 可复用子代理（docs/9）：任务完成后驻留待命（完整上下文延续），可经 followup 追加任务、
   *  archive 归档；缺省/显式 false = 一次性（任务结束即自动归档，现状语义）。 */
  reusable?: boolean;
}

/** 向空闲待命的可复用子代理追加的任务（docs/9）：task 作为新 user 消息接在既有历史上
 *  （任务书可引用该子代理之前的进展）；scope/effort/system 沿用首次派发（Agent 构造期固定）。 */
export interface SubagentFollowup {
  task: string;
  /** 一句话摘要（SSE 事件与抽屉展示；建议填） */
  description?: string;
  /** 本任务的超时毫秒；缺省不限时 */
  timeoutMs?: number;
}

export interface SubagentResult {
  ok: boolean;
  /** 最终报告文本（trim 后，已按 subagentResultMaxChars 预算修剪）；失败时为空串 */
  text: string;
  /** 失败原因（ok=false 时有值；中止/超时也归入此路径） */
  error?: string;
  /** worker 全程用量汇总（一次性计入父会话 totals） */
  usage?: { prompt: number; completion: number; reasoning?: number; cacheHit?: number };
  /** 实际执行的轮次（LLM 请求轮数，含收尾轮） */
  rounds?: number;
  /** 派发序号（docs/6 P3 方案 A）：与 SubagentRecord.subId 同源，报告标注「过程档案」入口用 */
  subId?: number;
  /** 全程过程存档相对路径（docs/6 P3 方案 A）：落盘成功时携带；报告尾部追加查看入口标记 */
  transcript?: string;
  /** worker 名字（followup 路径回填，工具层结果标注用；run 路径沿用调用方已知名） */
  name?: string;
  /** 本任务是该子代理的第几次任务（docs/9 可复用；>1 时结果标注「第 N 次任务」） */
  taskNo?: number;
  /** 本结果来自可复用子代理（docs/9）：任务结束后它驻留待命，工具层据此追加待命提示 */
  reusable?: boolean;
  /** 任务收尾时该子代理的上下文占用百分比（docs/10 R1：估算输入 ÷ 提供方上下文长度，
   *  与主对话 contextEstimate 同口径；协调者据此判断是否继续使用该实例） */
  contextPct?: number;
  /** 因上下文超过 subagentArchiveContextPct 被强制归档（docs/10 R1）：true 时它不再待命，
   *  工具层把待命提示替换为强制归档说明 */
  forceArchived?: boolean;
  /** 本次任务用时（毫秒；工具层 stats 行显示「用时」） */
  elapsedMs?: number;
  /** 任务收尾时该子代理已被归档的原因（docs/11 W1）："request"=归档请求中止（手动归档）、
   *  "context"=上下文超线强制归档（同 forceArchived=true）——工具层据此输出归档说明而非
   *  「已保留待命」提示（防误导协调者向已归档实例追加任务）。 */
  /** 本任务是因用户打断而结算（docs/18）：协调者侧的送达跳过——界面打断已有状态通知、
   *  工具路径已有返回文案，再送失败报告即一次操作两条消息；记录/事件/用量照常。 */
  stopped?: true;
  archived?: "request" | "context";
}

/**
 * 派发受理回执（docs/16 非阻塞派发）：ok=true 表示已受理并启动（subId/name 供后续
 * stop/archive 与报告对应）；ok=false 为配额/寻址/状态校验未过（error 是面向
 * 协调者的完整文案，工具层原样返回）。任务的真实结果不由本回执携带——结算（完成/失败/
 * 暂停后恢复完成/归档中止）后一律由服务层经 deliverToCoordinator 自动送达协调者收件箱。
 */
export type SubagentDispatch = { ok: true; subId: number; name: string } | { ok: false; error: string };

/**
 * 子代理服务（按会话实例化：provider/工作区/技能/AGENTS.md 随会话）。
 * v1（单次 chat、无工具）由 agent.ts runSubagent 保留；宿主的正式实现走
 * web/subagents.ts（完整工具循环），协调者经 agent_task/agent_followup 工具消费。
 * docs/16：派发完全非阻塞——两方法都同步返回受理回执，任务异步执行、报告自动送达；
 * 协调者对子代理没有任何阻塞等待。
 */
export interface SubagentService {
  /** 派发一个子代理执行任务：同步完成配额裁决并启动（spawn 已开始），立即返回回执。 */
  dispatch(req: SubagentRequest, signal?: AbortSignal): SubagentDispatch;
  /** 向空闲待命的可复用子代理追加任务（docs/9；docs/17 修订重启语义）：按 subId（优先）
   *  或 name（存活可复用中必须唯一）寻址；目标不存在/已归档/非空闲/超任务上限一律
   *  ok:false 回执（不抛错）；「待命记录在、实例不在线（服务重启过）且有过程存档」时
   *  自动唤醒——从存档回读历史重装实例（同 subId），再执行追加任务。校验通过即后台
   *  启动，报告自动送达；中止信号透传。 */
  followup(target: { name?: string; subId?: number }, req: SubagentFollowup, signal?: AbortSignal): SubagentDispatch;
}

/** 宿主实现的子代理接缝：按会话取服务（bootstrap 赋值 ctx.subagent，同 sessionHost 模式）。 */
export type SubagentSeam = (rt: SessionRuntime) => SubagentService;
