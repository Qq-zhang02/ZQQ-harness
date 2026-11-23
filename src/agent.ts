import type { ChatImage, ChatMessage, ChatResult, EffortSetting, LLMProvider, ThinkingBlock, UsageBreakdown, UsageInfo } from "./llm/provider.ts";
import type { ToolContext, ToolRegistry } from "./tools/registry.ts";
import type { Workspace } from "./workspace.ts";
import type { SkillInfo } from "./core/skills.ts";
import { estTokens, estimateBreakdown, contextPressure as contextPressureOf, messageTokens, withOther } from "./tokens.ts";
import type { ApprovalDecision, ApprovalRequest } from "./approval/types.ts";
import type { SandboxMode } from "./sandbox/types.ts";
import { chooseCutIndex, isContextOverflowError, type CompactionRecord, type CompactOutcome } from "./compaction.ts";
import { THRESHOLDS } from "./config.ts";
import { assembleSystemPrompt, BUILTIN_PROMPT_SECTIONS, toolDocsOf } from "./core/sections.ts";
import type { Registry } from "./core/registry.ts";
import type { PromptSection, SectionContext, SubagentRequest, SubagentResult } from "./core/types.ts";

export interface AgentUi {
  /** 模型思考流（reasoning_content）增量，展示用，不进入历史 */
  printReasoningDelta(text: string): void;
  /** 助手回复的流式文本增量 */
  printTextDelta(text: string): void;
  /** callId=工具调用 id（可选）：UI 用它把结果精确配对到调用块（并行调用/切换重放时不串块）。
   *  args=完整参数 JSON 串（可选，docs/28 P2-2）：前端展开体渲染（write 内容/edit diff）需要
   *  全量 old_string/new_string/content——argsPreview 只截 160 字符不够。UI 侧自行截断广播。 */
  printToolCall(name: string, argsPreview: string, callId?: string, args?: string): void;
  /** 工具执行的完整输出（exit code + stdout/stderr），由各 UI 自行决定展示/摘要；
   *  meta.prunedChars = 入模型内容被修剪的字符数；meta.spilled = 超长全文落盘路径（仅入模型引用） */
  printToolResult(output: string, meta?: { prunedChars: number; spilled?: string }, callId?: string): void;
  printInfo(msg: string): void;
  printUsage(usage: UsageInfo): void;
  /** 压缩完成（可选）：UI 弹压缩卡片（已压缩 N 条消息，上下文 X→Y tokens） */
  onCompaction?(record: CompactionRecord): void;
  /** 运行中对话合并进历史（可选，W2-L2 docs/8 §1.3）：interim 缓冲（[user,assistant]×k）
   *  在本轮全部工具消息之后写回 history 时触发——UI 用 init 快照整体重渲染，把 interim
   *  回应块与后续轮次正确分段、ml 锚点一次性对齐。 */
  onInterimMerged?(): void;
}

/** 压缩依赖（capability seam）：由宿主注入 provider/存档能力，agent 只管 history 替换。 */
export interface CompactionDeps {
  /** 提供方上下文长度（压力与保留预算计算用） */
  contextLength(): number;
  /** 用当前 provider 生成历史摘要（不带工具的一次 chat）；失败/为空则放弃压缩 */
  summarize(messages: ChatMessage[]): Promise<string>;
  /** 压缩前备份原 messages（best-effort；重启后手动可救） */
  backup?(history: ChatMessage[]): void;
}

export interface AgentSettings {
  /** 逐条确认模式：所有命令都需人工批准 */
  alwaysConfirm: boolean;
  /** 当前对话的思考档位（按对话记录；default=不添加思考参数） */
  effort: EffortSetting;
}

export interface AgentDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  workspace: Workspace;
  ui: AgentUi;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  settings: AgentSettings;
  /** 工具调用轮次上限（可选）：**缺省不传 = 每轮循环 live 读 config.ts 的
   *  THRESHOLDS.maxToolRounds**（docs/24 热应用——initConfig 后对已装配的运行中会话也即时生效，
   *  正在执行的当轮不受影响）。显式传入 = 创建时快照（子代理 worker 传
   *  THRESHOLDS.subagentMaxToolRounds：worker 创建时读 live binding，按派发生效）。 */
  maxToolRounds?: number;
  /** 工作区 AGENTS.md 内容（可选），作为附加系统指令注入 */
  agentsMd?: string | null;
  /** 全局 AGENTS.md 内容（~/.ZQQ-harness/AGENTS.md，可选），对所有工作区生效；与工作区指令冲突时以工作区为准 */
  globalAgentsMd?: string | null;
  /** 可用技能清单（可选），注入系统提示的技能列表 */
  skills?: SkillInfo[];
  /** MCP 服务器 instructions（可选，来自握手），注入系统提示的 MCP 使用说明 */
  mcpInstructions?: string | null;
  /** 会话形态（可选，docs/5 SA2）：coordinator=协调者前台——base/skills/mcp 段按形态分支渲染；缺省 normal（字节不变） */
  sessionKind?: "normal" | "coordinator";
  /** 会话提供方有视觉能力（可选，docs/12 R2）：base 段注入图片直看指引——模型优先用自身
   *  视觉分析消息携带的图片，不绕 view_image。换提供方时经 setVision 热更（重建系统提示）。 */
  vision?: boolean;
  /** 子代理写入分区（可选，docs/5 §5.4）：相对工作区根的路径前缀，随工具上下文下发；
   *  由 web/subagents.ts 按 SubagentRequest.scope 注入（普通会话不设） */
  writeScope?: string[];
  /** 当前会话沙箱模式（可选，缺省 workspace-write），随工具上下文下发 */
  sandboxMode?: SandboxMode;
  /** 超长工具输出落盘目录（spill，按会话取值），随工具上下文下发 */
  spillDir?: () => string | undefined;
  /** 沙箱私有临时目录（按会话取值），随工具上下文下发 */
  privateTempDir?: () => string | undefined;
  /** 压缩服务（可选）：注入后 /compact、pressure 自动触发与 overflow 重试才可用 */
  compaction?: CompactionDeps;
  /** 系统提示 sections（可选；缺省用 core 内置六段）。宿主传入 ctx.promptSections 以支持扩展段。 */
  promptSections?: Registry<PromptSection, "name">;
  /** 只读会话（可选，docs/42 只读子代理）：随工具上下文下发——文件写入工具硬拒、run_pwsh 按只读
   *  沙箱执行且不可提权（「只报告不写文件」的结构性保证，不靠任务书文字约束）。 */
  readOnly?: boolean;
  /** 上下文预警线提示（可选，docs/42；子代理装配时注入）：占用越过 warnPct 的那一刻向历史注入
   *  一次系统提示，让模型在还来得及的时候收敛行为（少读图/大文件、先落盘进展再收尾）。 */
  contextWarn?: { contextLength(): number; warnPct: number };
}

function previewArgs(raw: string): string {
  const s = raw.replace(/\s+/g, " ");
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

/** interim 请求中未完成工具调用的状态占位（合成 tool 消息的内容，W2-L2 docs/8 §1.3）：
 *  让模型看到「自己已派发、任务在跑」——不带未完成结果（用户语义），且防重复派发。
 *  docs/16：派发已非阻塞，本占位只出现在派发/控制调用瞬间被插话的窄窗口。 */
const INTERIM_TASK_STATUS =
  "[子代理已派发、正在后台执行，报告完成后会自动送达（那才是最终结果）——这是运行期间的状态注入，不是最终结果；请勿重复派发同样的任务]";

/** interim 即时应答可真实执行的工具白名单（协调者注册表才有的工具，docs/18 起暂停/恢复
 *  退役、打断即终结；docs/32 起补 subagent_status 只读查询——运行中插话追问进度可当场
 *  真执行）：协调者在工具等待窗口内（docs/16 后窗口很窄——派发/控制类调用都立即返回）
 *  收到用户要求打断/归档/报进度时必须当场真正执行——否则模型只能在文字里"装作执行"骗
 *  用户。按注册表过滤：普通会话恒为空 → interim 不带工具，行为与历史版本逐字节一致。
 *  白名单外的调用（幻觉出的 agent_task、阻塞型的 ask_user 等）不执行、以错误文本回填——
 *  interim 不派发新任务、不发起阻塞提问。 */
const INTERIM_CONTROL_TOOLS = new Set(["stop_subagent", "archive_subagent", "subagent_status"]);

/** 图片预算移出后追加在所在消息文本尾部的说明（docs/42 修订；被移的图永久移除、不再随请求发送）。 */
const imageOffloadedNote = (count: number): string =>
  `[图片已移出上下文（${count} 张）：会话内图片超过预算上限，这是最早的一批，已永久移除、不再随请求发送。` +
  "工具读取的图可按原路径重新 read_image；若预算仍被占满，重读的图还会被移出——需要看新图请让用户调大会话内图片预算]";

/** 越过预算后一次移到预算的该比例以下（成批移出——每次移出都让前缀缓存从被移的那条起整段失效）。 */
const IMAGE_BUDGET_TARGET = 0.75;

/** base64 串对应的解码字节数（预算按解码后字节计，与 IMAGE_RULES 单张上限同口径；不计末尾填充，误差可忽略）。 */
const decodedImageBytes = (b64: string): number => Math.floor((b64.length * 3) / 4);

/** 预算字节的人类可读写法（UI 提示用）：≥1 MiB 用 MiB（一位小数），否则 KB。 */
const fmtBudgetBytes = (b: number): string => (b >= 1024 * 1024 ? `${Math.round((b / 1024 / 1024) * 10) / 10} MiB` : `${Math.round(b / 1024)} KB`);

/**
 * Agent 循环：用户输入 → LLM →（有 tool_calls 则执行并回填）→ LLM → … → 最终回答。
 * 会话历史保存在内存中（MVP 不做持久化）。
 */
export class Agent {
  private history: ChatMessage[] = [];
  private deps: AgentDeps;
  /** 已告警过"签名缺失"的思考块（同一块每次请求重建都会再触发降级，只告警一次） */
  private replayDegradeWarned = new WeakSet<ThinkingBlock>();
  // ---- W2-L2（docs/8 §1.3）：运行中即时应答（interim）状态 ----
  /** 工具循环执行中 = 唯一接受 interject 的窗口（agent_task 等阻塞点；docs/15 起协调者同轮多调用并行） */
  private toolPending = false;
  /** 待合并的运行中对话 [user,assistant] 对（按到达序；run 的合并点一次性写回 history） */
  private interimQueue: ChatMessage[] = [];
  /** 在飞的 interim 调用（undefined=空闲）。同步段守卫 + 合并点 await（等它完成再合并） */
  private interimFlight?: Promise<"ok" | "failed">;
  /** run() 入口捕获的中止信号：interim 旁路调用挂同一信号（中止时 failed → 落 inbox 兜底） */
  private runSignal?: AbortSignal;
  // ---- 上下文总量校准：API 实测锚点 ----
  /** 最近一次 API 实测锚点（run 内 chat 返回 usage 时记录）：promptTokens=该次请求的
   *  实际输入 token（API 返回，比本地估算准——chat 模板包装、分词差异全被实测吸收）；
   *  len/lastMsg=请求时刻的 history 形状（O(1) 结构有效性判定：push-only 语义下 lastMsg
   *  仍在原位即前缀未被替换）；fixed=该次请求固定部分（system+技能+工具 schema+MCP）的
   *  本地估算（固定部分变化时做差量校正）。history 被整体替换（compact/restore/clear）
   *  或换提供方（各家计量口径不同）时置 null，回退纯估算，下次请求重建。 */
  private usageAnchor: { promptTokens: number; len: number; lastMsg: ChatMessage; fixed: number } | null = null;
  // ---- 图片预算（docs/42 修订） ----
  /** 历史中模型已经「看到」的前缀长度（= 最近一次成功请求时的历史长度）：其后新增的带图消息
   *  是模型还没看过的新图，预算移出时不先动它们。 */
  private seenLen = 0;
  /** 上下文预警线提示已发过（每个 Agent 生命周期至多一次；clear/restore 后随新历史复位语义自然解除） */
  private contextWarned = false;
  // ---- 修剪观测性（docs/40 阶段二） ----
  /** 会话累计工具结果修剪统计：工具循环结算时经 notePrune 累加，state 载荷经
   *  pruneStats() 透出（前端 Token 面板一行展示）——调参时能看见截断发生。 */
  private prune = { count: 0, chars: 0, spills: 0 };

  /** 会话累计工具结果修剪统计：触发次数 / 被剪字符总数 / spill 全文落盘份数。 */
  pruneStats(): { count: number; chars: number; spills: number } {
    return { ...this.prune };
  }

  private notePrune(r: { prunedChars: number; spilled?: string }): void {
    if (r.prunedChars <= 0 && !r.spilled) return;
    this.prune.count++;
    this.prune.chars += r.prunedChars;
    if (r.spilled) this.prune.spills++;
  }

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.history.push({ role: "system", content: this.buildSystemPrompt() });
  }

  /** 轮次上限：显式 deps 值优先；否则 live 读 THRESHOLDS.maxToolRounds（每轮循环与达上限文案都经此——单一取值点） */
  private get maxToolRounds(): number {
    return this.deps.maxToolRounds ?? THRESHOLDS.maxToolRounds;
  }

  private buildSystemPrompt(): string {
    const sc: SectionContext = {
      workspaceRoot: this.deps.workspace.root,
      skills: this.deps.skills ?? [],
      mcpInstructions: this.deps.mcpInstructions ?? null,
      globalAgentsMd: this.deps.globalAgentsMd ?? null,
      workspaceAgentsMd: this.deps.agentsMd ?? null,
      toolDocs: toolDocsOf(this.deps.registry),
      ...(this.deps.sessionKind ? { sessionKind: this.deps.sessionKind } : {}),
      ...(this.deps.vision ? { vision: true } : {}), // docs/12 R2：视觉会话注入图片直看指引
    };
    return assembleSystemPrompt(this.deps.promptSections?.all() ?? BUILTIN_PROMPT_SECTIONS, sc);
  }

  /** 按当前 deps 重建系统提示（保留历史） */
  private rebuildSystemPrompt(): void {
    if (this.history[0]?.role === "system") {
      this.history[0] = { role: "system", content: this.buildSystemPrompt() };
    }
  }

  /** 热更新技能清单并重建系统提示（保留历史）；无需重启即可加载新增/修改的技能 */
  setSkills(skills: SkillInfo[]): void {
    this.deps = { ...this.deps, skills };
    this.rebuildSystemPrompt();
  }

  /** 热更新 MCP 使用说明并重建系统提示（保留历史）；manage_mcp 重连后调用 */
  setMcpInstructions(text: string | null): void {
    this.deps = { ...this.deps, mcpInstructions: text };
    this.rebuildSystemPrompt();
  }

  /** 按当前状态重建系统提示（保留历史）。deps 之外的输入变化时由宿主触发——docs/20：
   *  协调者的 worker MCP 首次连接后刷新「子代理（worker）系统提示词说明」段（该段 render
   *  惰性读会话状态，不经过 set* 家族）。 */
  refreshSystemPrompt(): void {
    this.rebuildSystemPrompt();
  }

  /** 更换 LLM 提供方（保留历史与系统提示）；任务运行中不要调用。实测锚点随之失效——
   *  各提供方的计量口径不同，旧家的 promptTokens 不能校准新家的请求。 */
  setProvider(p: LLMProvider): void {
    this.deps = { ...this.deps, provider: p };
    this.usageAnchor = null;
  }

  /** 热更提供方视觉能力并重建系统提示（保留历史）；applyProvider 换提供方时随 setProvider
   *  一起调用（docs/12 R2：视觉指引行随提供方能力进出系统提示）。 */
  setVision(vision: boolean): void {
    this.deps = { ...this.deps, vision: vision || undefined };
    this.rebuildSystemPrompt();
  }

  /** 更新会话沙箱模式（随工具上下文下发；任务运行中不要调用） */
  setSandboxMode(mode: SandboxMode): void {
    this.deps = { ...this.deps, sandboxMode: mode };
  }

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  /** 记录 API 实测锚点：reqLen/fixed 取自请求派发时刻（payload = this.history 前 reqLen 条；
   *  chat await 期间 history 不会被并发改动——interject 只在工具执行窗口受理，防御性按
   *  请求时刻形状记录）。history 为空时置 null（无 payload 可锚）。 */
  private anchorUsage(promptTokens: number, reqLen: number, fixed: number): void {
    const lastMsg = this.history[reqLen - 1];
    this.usageAnchor = lastMsg ? { promptTokens, len: reqLen, lastMsg, fixed } : null;
  }

  /** 当前上下文（下次请求将发送的 system+工具 schema+消息）的 token 总量与分类构成。
   *  总量优先锚定 API 实测：最近一次请求返回的 usage.promptTokens +（其后新增消息的
   *  本地估算 + 固定部分变化的差量）——本地估算的系统性偏差（chat 模板包装、分词差异）
   *  由实测值吸收，主对话与子代理同口径。无锚点（新会话/恢复档/压缩/换提供方后）回退
   *  纯本地估算；实测与估算的差额计入 other，六类合计恒等于返回的 total（估算偏高时
   *  other 归 0、总量取估算——宁高勿低，压力闸保守触发）。 */
  contextEstimate(): { total: number; breakdown: UsageBreakdown } {
    const passback = this.thinkingPassbackOf();
    const omit = this.imagesOmitted();
    const breakdown = estimateBreakdown(
      this.history,
      this.deps.registry.schemas(),
      this.deps.skills ?? [],
      this.deps.mcpInstructions ?? null,
      passback,
      omit,
    );
    const fixed = breakdown.systemPrompt + breakdown.skills + breakdown.systemTools + breakdown.mcp;
    const est = fixed + breakdown.messages; // 纯本地估算口径（回退值）
    let total = est;
    const a = this.usageAnchor;
    if (a && this.history.length >= a.len && this.history[a.len - 1] === a.lastMsg) {
      // 锚点结构有效（前缀未被替换）：实测总量 + 锚点后新增消息估算 + 固定部分变化差量
      let appended = 0;
      for (let i = a.len; i < this.history.length; i++) {
        const m = this.history[i]!;
        appended += messageTokens(m, estTokens, passback(m), omit);
      }
      total = Math.max(0, a.promptTokens + appended + fixed - a.fixed);
    }
    breakdown.other = Math.max(0, total - est);
    return { total: est + breakdown.other, breakdown };
  }

  /**
   * 思考回传判定（逐消息，供 token 计数用）：委托 provider 的能力声明（§4.6）——
   * 判定规则由各格式路线实现并与其实际回传/回放逻辑同源，计数口径与请求同源。
   * 未实现该能力的 provider（测试桩等）：不回传不计数。
   */
  private thinkingPassbackOf(): (m: ChatMessage) => boolean {
    const passback = this.deps.provider.thinkingPassback?.bind(this.deps.provider);
    const effort = this.deps.settings.effort;
    return (m) => (passback ? passback(m, effort) : false);
  }

  /** 当前上下文压力（0-1）：上下文总量（优先 API 实测锚定）/ 提供方上下文长度。 */
  contextPressure(contextLength: number): number {
    return contextPressureOf(this.contextEstimate().total, contextLength);
  }

  clear(): void {
    this.history = [{ role: "system", content: this.buildSystemPrompt() }];
    this.usageAnchor = null;
    this.contextWarned = false;
    this.seenLen = 0;
  }

  /** 本次请求是否省略图像（docs/42 修订）：会话模型无视觉能力（deps.vision 未置）= 文本模型——
   *  带图消息只发文本 + 省略说明（提供方投影 ChatParams.omitImages），历史不动；token 估算
   *  同步不计图像块（计数口径与实际请求同源）。 */
  private imagesOmitted(): boolean {
    return !this.deps.vision;
  }

  /**
   * 图片预算（docs/42 修订，DSH 口径）：图像块随历史常驻——模型可随时回看，前缀缓存不因读图
   * 失效；只有同时留在上下文里的图片超出预算（张数 imageContextMaxCount / 总字节
   * imageContextMaxBytes，任一超限）才把最早的移出：所在消息换成新对象（留下的图照带、内容
   * 追加移出说明），被移的图永久生效、不再随请求发送。每次请求前调用；纯文本会话不发图——
   * 不移出，换回视觉模型时原样恢复。一张图 = 一个移出单位（同一条消息里的图可以只移出一部分
   * ——用户一次贴多张时不至于整条丢失）。移出顺序：
   *   ① 已看过的工具读图（可按原路径重新 read_image）——一次移到预算的 IMAGE_BUDGET_TARGET
   *      以下：被移的是最早的图，前缀缓存从它所在那条起整段失效，成批移出比每读一张移一张省；
   *   ② 模型还没看过的工具读图、③ 用户贴图——仅当移完前一档仍超硬预算才动，且只移到硬预算
   *      （用户贴图不能按路径重读，排在最后；用户贴图占满预算时新读的工具图会被移出）。
   * 必须新建对象而非原地删字段：tokens 的逐对象计数缓存与 usageAnchor 的身份比对都按对象走。
   */
  private enforceImageBudget(): void {
    if (!this.deps.vision) return;
    const maxCount = THRESHOLDS.imageContextMaxCount;
    const maxBytes = THRESHOLDS.imageContextMaxBytes;
    const units: Array<{ i: number; j: number; kind: "tool" | "user"; seen: boolean; bytes: number; drop: boolean }> = [];
    let count = 0;
    let bytes = 0;
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i]!;
      if ((m.role !== "tool" && m.role !== "user") || !m.images?.length) continue;
      m.images.forEach((img, j) => {
        const b = decodedImageBytes(img.data);
        units.push({ i, j, kind: m.role, seen: i < this.seenLen, bytes: b, drop: false });
        count++;
        bytes += b;
      });
    }
    const over = (c: number, b: number): boolean => count > c || bytes > b;
    if (!over(maxCount, maxBytes)) return;
    const targetCount = Math.floor(maxCount * IMAGE_BUDGET_TARGET);
    const targetBytes = Math.floor(maxBytes * IMAGE_BUDGET_TARGET);
    const drop = (u: (typeof units)[number]): void => {
      u.drop = true;
      count--;
      bytes -= u.bytes;
    };
    // units 按历史顺序排列（同一条消息内按图序）——逐档从头扫即「最早的先移」
    for (const u of units) if (u.seen && u.kind === "tool" && over(targetCount, targetBytes)) drop(u);
    for (const u of units) if (!u.seen && u.kind === "tool" && over(maxCount, maxBytes)) drop(u);
    for (const u of units) if (u.seen && u.kind === "user" && over(maxCount, maxBytes)) drop(u);
    for (const u of units) if (!u.seen && u.kind === "user" && over(maxCount, maxBytes)) drop(u);
    const dropped = units.filter((u) => u.drop);
    if (dropped.length === 0) return;
    // 逐消息重建：只动真的被移了图的消息。消息下标 → 被移出的图在该消息 images 里的下标
    const byMsg = new Map<number, number[]>();
    for (const u of dropped) byMsg.set(u.i, [...(byMsg.get(u.i) ?? []), u.j]);
    for (const [i, js] of byMsg) {
      const m = this.history[i]!;
      const imgs = m.role === "tool" || m.role === "user" ? (m.images ?? []) : [];
      const kept = imgs.filter((_, j) => !js.includes(j));
      const content = `${m.content}\n${imageOffloadedNote(js.length)}`;
      const base = m.role === "tool" ? { role: "tool" as const, toolCallId: m.toolCallId } : { role: "user" as const };
      this.history[i] = { ...base, content, ...(kept.length > 0 ? { images: kept } : {}) };
    }
    this.usageAnchor = null; // 历史前缀里的消息被替换——锚点的「前缀未变」前提不再成立，下次请求重建
    this.deps.ui.printInfo(
      `[图片预算] 会话内图片超过上限（${maxCount} 张 / ${fmtBudgetBytes(maxBytes)}），已把最早的 ${dropped.length} 张图片移出上下文（工具读取的图可按路径重新读取）`,
    );
  }

  /**
   * 上下文预警线提示（docs/42）：占用（API 实测锚定口径）越过 warnPct 时向历史注入一次系统提示
   * ——与轮次上限的收尾提示同形（user 角色的括号提示），模型在还来得及收敛的时候收到：少读图/
   * 大文件、先把进展落盘再收尾。每个 Agent 生命周期至多一次（后续任务不重复打扰）。调用点在
   * 本轮 tool 消息全部入档之后——tool 消息后接 user 消息是合法序列（interim 合并点同款形状）。
   */
  private maybeWarnContext(): void {
    const w = this.deps.contextWarn;
    if (!w || this.contextWarned) return;
    const pct = Math.round(this.contextPressure(w.contextLength()) * 100);
    if (pct <= w.warnPct) return;
    this.contextWarned = true;
    this.deps.ui.printInfo(`[上下文 ${pct}% 已越过预警线 ${w.warnPct}%] 已提示模型精简操作并尽快收尾`);
    this.history.push({
      role: "user",
      content:
        `（系统提示：你的上下文占用已达 ${pct}%，超过预警线 ${w.warnPct}%。请立即精简操作：` +
        "停止非必要的读图与大文件读取，把当前进展、关键结论与下一步先用文字写进产出文件，然后尽快收尾交报告；" +
        "未完成的部分在报告里列清楚，留给后续任务接续。）",
    });
  }

  /** 切换工作区：更新系统提示（含 AGENTS.md、技能清单与 MCP 说明），保留会话历史（任务运行中不要调用）。传 undefined 保持不变。 */
  setWorkspace(
    w: Workspace,
    agentsMd?: string | null,
    skills?: SkillInfo[],
    mcpInstructions?: string | null,
    globalAgentsMd?: string | null,
  ): void {
    this.deps = {
      ...this.deps,
      workspace: w,
      ...(agentsMd !== undefined ? { agentsMd } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(mcpInstructions !== undefined ? { mcpInstructions } : {}),
      ...(globalAgentsMd !== undefined ? { globalAgentsMd } : {}),
    };
    this.rebuildSystemPrompt();
  }

  /** 从持久化数据恢复会话：系统提示按当前工作区重建，其余历史原样接回。
   *  恢复档没有 API 实测数据，锚点失效回退本地估算，首轮请求后重建。 */
  restore(messages: ChatMessage[]): void {
    const sys =
      this.history[0]?.role === "system"
        ? this.history[0]
        : { role: "system" as const, content: this.buildSystemPrompt() };
    this.history = [sys, ...messages];
    this.usageAnchor = null;
    this.contextWarned = false;
    this.seenLen = this.history.length; // 恢复档里的图都是此前会话发过的——预算移出时按「已看过」处理
  }

  /**
   * 压缩：system + [历史摘要] + 近期尾部完整轮次。物理替换、不可逆（压缩前先备份）。
   * fail-safe：摘要调用失败/超时/返回空 → 放弃压缩，history 原样保留。
   * opts.keepTokens 可覆盖保留预算：手动 /compact 传小预算（立即显著变小），
   * 缺省按提供方上下文的 THRESHOLDS.compactionKeepRatio（自动触发/溢出兜底语义）。
   * 图像块（docs/42 修订）：落在被摘要替换区间里的图随消息移除、不再进请求（read_image 的
   * 结果文本带路径，摘要按路径可重读）；保留尾部里的图照常携带。
   */
  async compact(opts?: { keepTokens?: number }): Promise<CompactOutcome> {
    const compaction = this.deps.compaction;
    if (!compaction) return { ok: false, reason: "压缩服务不可用" };
    const history = this.history;
    const tokensBefore = this.contextEstimate().total;
    const keepTokens = opts?.keepTokens ?? Math.round(compaction.contextLength() * THRESHOLDS.compactionKeepRatio);
    const passback = this.thinkingPassbackOf();
    const cut = chooseCutIndex(history, keepTokens, (m) => messageTokens(m, estTokens, passback(m), this.imagesOmitted()));
    if (cut < 2) return { ok: false, reason: "没有可压缩的历史（找不到安全的轮边界切点）" };
    const toSummarize = history.slice(1, cut);
    if (toSummarize.length === 0) return { ok: false, reason: "没有可压缩的历史" };
    try {
      compaction.backup?.([...history]); // 压缩前备份原 history（best-effort）
      const summary = (await compaction.summarize(toSummarize)).trim();
      if (!summary) return { ok: false, reason: "摘要生成为空，放弃压缩" };
      // 前缀保证摘要消息永远不可能是"空消息"（避开已知的空回复 400 坑）
      const summaryMsg: ChatMessage = {
        role: "user",
        content: "[历史摘要（系统压缩生成）]\n" + summary,
      };
      this.history = [history[0], summaryMsg, ...history.slice(cut)];
      this.usageAnchor = null; // history 整体替换，实测锚点失效（tokensAfter 为估算口径，下次请求重建）
      this.seenLen = this.history.length; // 保留尾部里的图都是模型看过的
      const record: CompactionRecord = {
        at: new Date().toISOString(),
        cutIndex: cut,
        summary,
        tokensBefore,
        tokensAfter: this.contextEstimate().total,
        removedMessages: cut - 1,
      };
      this.deps.ui.onCompaction?.(record);
      return { ok: true, record };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** interim 回应的助手消息拼装：思考存档口径同收尾轮（有 reasoning 就存，带签名与模型）。 */
  private interimAssistantOf(r: ChatResult, provider: LLMProvider): ChatMessage {
    return {
      role: "assistant",
      content: r.content || null,
      toolCalls: r.toolCalls,
      ...(r.reasoning
        ? {
            thinking: {
              text: r.reasoning,
              ...(r.reasoningSignature !== undefined ? { signature: r.reasoningSignature } : {}),
              ...(provider.model ? { model: provider.model } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * 运行中即时应答（W2-L2，docs/8 §1.3）：工具等待窗口内的新消息立即发起一次旁路 LLM
   * 调用——全历史 + 未完成调用的状态占位（合成 tool 消息）+ 本窗口先前已回应的 interim
   * 对 + 新消息，回应流式给 UI、缓冲进 interimQueue，由 run 的合并点在本轮全部工具消息
   * 之后写回 history。本方法不写 this.history（坑清单 §1.4-2）；usage 走 printUsage +
   * withOther（六类守恒）。
   * 控制工具（协调者）：注册表里有 stop/archive_subagent 时随请求下发，模型调用
   * 则**当场真实执行**（注册表层，非阻塞）再补一次不带工具的收尾应答——协调者阻塞在
   * agent_task 等待窗口时，用户"打断子代理"的要求即时生效，不再只在文字里装作执行。
   * 白名单外的工具调用不执行（错误文本回填），interim 绝不派发阻塞型任务。
   * 返回："ok"=已缓冲待合并；"busy"=已有 interim 在飞（调用方决定排队或落 inbox）；
   * "not-pending"=不在工具等待窗口（走 inbox 兜底）；"failed"=调用失败/中止/空回复
   * （已流出的半截文本由合并 init/轮末状态自然收敛，消息同样走 inbox 兜底）。
   */
  async interject(text: string): Promise<"ok" | "busy" | "not-pending" | "failed"> {
    if (!this.toolPending) return "not-pending";
    if (this.interimFlight) return "busy";
    const { ui, provider, registry, settings } = this.deps;
    const messages: ChatMessage[] = [
      ...this.history,
      ...this.danglingToolCallIds().map((id) => ({ role: "tool" as const, toolCallId: id, content: INTERIM_TASK_STATUS })),
      ...this.interimQueue, // 本窗口内先前已回应的运行中对话（保持连贯）
      { role: "user", content: text },
    ];
    const controlTools = registry.schemas().filter((t) => INTERIM_CONTROL_TOOLS.has(t.name)); // 普通会话恒空 → 行为不变
    const omit = this.imagesOmitted();
    const breakdown = estimateBreakdown(
      messages, controlTools, this.deps.skills ?? [], this.deps.mcpInstructions ?? null, this.thinkingPassbackOf(), omit,
    );
    const p = (async (): Promise<"ok" | "failed"> => {
      try {
        const r = await provider.chat({
          messages,
          ...(controlTools.length > 0 ? { tools: controlTools } : {}), // 无控制工具时不带 tools（收尾轮先例，字节不变）
          effort: settings.effort,
          ...(omit ? { omitImages: true } : {}),
          onReasoningDelta: (t) => ui.printReasoningDelta(t),
          onTextDelta: (t) => ui.printTextDelta(t),
          signal: this.runSignal,
        });
        if (r.usage) ui.printUsage({ ...r.usage, breakdown: withOther(r.usage, breakdown) });
        const content = r.content.trim();
        if (r.toolCalls.length === 0) {
          if (!content) return "failed"; // 空回复不入缓冲（与 run 同口径：assistant 空消息会毒化后续请求）
          this.interimQueue.push({ role: "user", content: text }, this.interimAssistantOf(r, provider));
          return "ok";
        }
        // 控制类工具调用：真实执行（白名单外不执行，错误文本回填），UI 同步可见
        const seq: ChatMessage[] = [{ role: "user", content: text }, this.interimAssistantOf(r, provider)];
        const ctx: ToolContext = {
          workspace: this.deps.workspace,
          requestApproval: this.deps.requestApproval,
          alwaysConfirm: settings.alwaysConfirm,
          ...(this.deps.readOnly ? { readOnly: true } : {}),
          signal: this.runSignal ?? undefined,
        };
        for (const call of r.toolCalls) {
          ui.printToolCall(call.name, previewArgs(call.arguments), call.id, call.arguments);
          const res = INTERIM_CONTROL_TOOLS.has(call.name)
            ? await registry.executeWithMeta(call.name, call.arguments, ctx)
            : { text: `错误：即时应答窗口只能执行 stop_subagent / archive_subagent / subagent_status（${call.name} 不在其中）——其余工具请等当前任务结束后调用。`, full: "", prunedChars: 0 };
          this.notePrune(res);
          ui.printToolResult(res.full || res.text, { prunedChars: res.prunedChars }, call.id);
          seq.push({ role: "tool", toolCallId: call.id, content: res.text });
        }
        // 收尾应答（不带工具）：让模型基于控制结果组织给用户的回复
        const messages2: ChatMessage[] = [...messages, ...seq];
        const breakdown2 = estimateBreakdown(
          messages2, [], this.deps.skills ?? [], this.deps.mcpInstructions ?? null, this.thinkingPassbackOf(), omit,
        );
        const r2 = await provider.chat({
          messages: messages2,
          effort: settings.effort,
          ...(omit ? { omitImages: true } : {}),
          onReasoningDelta: (t) => ui.printReasoningDelta(t),
          onTextDelta: (t) => ui.printTextDelta(t),
          signal: this.runSignal,
        });
        if (r2.usage) ui.printUsage({ ...r2.usage, breakdown: withOther(r2.usage, breakdown2) });
        if (!r2.content.trim()) return "failed"; // 控制已生效但不入缓冲；用户消息轮末 inbox 兜底重答
        this.interimQueue.push(...seq, this.interimAssistantOf(r2, provider));
        return "ok";
      } catch {
        return "failed"; // 中止（挂 runSignal）/网络错误：半截流式文本由 UI 自然收敛，消息由调用方落 inbox
      }
    })();
    this.interimFlight = p.finally(() => {
      this.interimFlight = undefined;
    });
    return p;
  }

  /** 尾部尚未回填的 tool 调用 id（interim 请求为其合成状态占位消息）：只有最后一条
   *  assistant(tool_calls) 可能悬空——更早轮次必然已回填（run 的工具循环逐个 push）。 */
  private danglingToolCallIds(): string[] {
    const answered = new Set<string>();
    let i = this.history.length - 1;
    while (i >= 0 && this.history[i]!.role === "tool") {
      answered.add((this.history[i] as { toolCallId: string }).toolCallId);
      i--;
    }
    const last = i >= 0 ? this.history[i] : undefined;
    if (!last || last.role !== "assistant" || last.toolCalls.length === 0) return [];
    return last.toolCalls.map((c) => c.id).filter((id) => !answered.has(id));
  }

  /** interim 缓冲写回 history（队列非空才动）：只在「本轮全部工具消息已 push」的形状下
   *  调用（合并点/run 退出兜底），tool 消息后追加 [user,assistant]×k 是合法序列。 */
  private mergeInterimQueue(): void {
    if (this.interimQueue.length === 0) return;
    this.history.push(...this.interimQueue);
    this.interimQueue = [];
    this.deps.ui.onInterimMerged?.();
  }

  /**
   * 跑一轮对话：user → LLM →（工具调用则执行回填）→ … → 最终回答。
   * 返回 { finalText, rounds }（finalText=最终回答 trim 后文本，rounds=本次 run 消耗的
   * LLM 请求轮数，含强制收尾轮）；null = 没有产生最终回答（空回复/被中断/收尾轮空回复）。
   * 子代理（worker）据此取最终报告；startTurn 等旧调用方忽略返回值，行为不变。
   * images（docs/10 R3）：随 user 消息入历史的图片（有视觉能力的模型直看）；不传或空数组
   * 时与历史行为逐字节一致。
   */
  async run(userInput: string, signal?: AbortSignal, images?: ChatImage[]): Promise<{ finalText: string; rounds: number } | null> {
    const { ui, provider, registry, workspace, requestApproval, settings } = this.deps;
    this.runSignal = signal; // W2-L2：interim 旁路调用挂同一中止信号
    this.interimQueue = []; // 防御性复位：上次 run 异常中断的遗留缓冲无法安全合并（形状未知），丢弃
    this.toolPending = false;
    this.history.push({ role: "user", content: userInput, ...(images && images.length > 0 ? { images } : {}) });
    let overflowCompacted = false; // overflow 兼顾：每轮 run 最多自动压缩+重试一次
    let rounds = 0; // 入档的助手消息数 = 实际请求轮数（供子代理报告 rounds）

    for (let round = 0; round < this.maxToolRounds; round++) {
      this.enforceImageBudget(); // docs/42 修订：图片预算——超限才把最早的移出（每轮请求前统一执行）
      // 每轮重取工具 schema：manage_mcp 热重载后新 MCP 工具下一轮即可调用（token 估算随之间源）
      const tools = registry.schemas();
      // 输入 token 分类估算：按本次实际请求的消息、工具 schema、技能与 MCP 说明计算
      const passback = this.thinkingPassbackOf();
      const omit = this.imagesOmitted();
      const breakdown = estimateBreakdown(
        this.history,
        tools,
        this.deps.skills ?? [],
        this.deps.mcpInstructions ?? null,
        passback,
        omit,
      );
      const reqLen = this.history.length; // 请求 payload 形状（实测锚点用；chat 期间 history 不变）
      let result;
      try {
        result = await provider.chat({
          messages: [...this.history],
          tools,
          effort: settings.effort,
          ...(omit ? { omitImages: true } : {}),
          onReasoningDelta: (t) => ui.printReasoningDelta(t),
          onReplayDegrade: (reason, src) => {
            // 同一思考块在多轮工具循环中反复发送，签名缺失只告警一次
            if (!this.replayDegradeWarned.has(src)) {
              this.replayDegradeWarned.add(src);
              ui.printInfo(reason);
            }
          },
          onTextDelta: (t) => ui.printTextDelta(t),
          signal,
        });
      } catch (e) {
        // 输入放不下（provider 400）：与 finishReason=length 的输出截断不同。
        // 自动压缩一次并重试该轮；压缩失败或重试再失败则原错误上抛。
        if (!overflowCompacted && !signal?.aborted && isContextOverflowError(e) && this.deps.compaction) {
          overflowCompacted = true;
          ui.printInfo("[上下文超限] 输入超过模型上下文窗口，自动压缩历史后重试…");
          const outcome = await this.compact();
          if (outcome.ok) {
            round--; // 重试当前轮
            continue;
          }
          ui.printInfo("[压缩失败] " + outcome.reason);
        }
        throw e;
      }
      this.seenLen = reqLen; // docs/42 修订：请求成功 = 这段历史模型已看过（其后新增的图是未看过的新图）
      if (result.usage) {
        // API 实测锚点：contextEstimate 的总量以此为准（本地估算只补锚点后的新增部分）
        this.anchorUsage(
          result.usage.promptTokens,
          reqLen,
          breakdown.systemPrompt + breakdown.skills + breakdown.systemTools + breakdown.mcp,
        );
      }
      if (result.finishReason === "length") {
        ui.printInfo("[警告] 模型输出因达到 max_tokens 上限被截断（finish_reason=length）");
      }
      if (result.toolCalls.length === 0 && !result.content.trim()) {
        // 空回复（无正文、无工具调用，偶发于思考型模型）：不能写入历史，
        // 否则该消息既无 content 也无 tool_calls，后续所有请求都会被 API 400 拒绝
        ui.printInfo("[模型返回了空回复，本轮已跳过，请重试]");
        return null;
      }
      // 思考块随助手消息存档：带工具调用的轮次供 API 回放（anthropic 合规），
      // 最终回答轮仅供前端显示（回放与回传范围都限定在带工具调用的轮次，模型输入不受影响）
      this.history.push({
        role: "assistant",
        content: result.content || null,
        toolCalls: result.toolCalls,
        ...(result.reasoning
          ? {
              thinking: {
                text: result.reasoning,
                ...(result.reasoningSignature !== undefined ? { signature: result.reasoningSignature } : {}),
                ...(provider.model ? { model: provider.model } : {}),
              },
            }
          : {}),
      });
      if (result.usage) ui.printUsage({ ...result.usage, breakdown: withOther(result.usage, breakdown) });
      rounds++;

      if (result.toolCalls.length === 0) return { finalText: result.content.trim(), rounds }; // 最终回答已流式打印

      const ctx = {
        workspace,
        requestApproval,
        alwaysConfirm: settings.alwaysConfirm,
        sandboxMode: this.deps.sandboxMode,
        spillDir: this.deps.spillDir?.(),
        privateTempDir: this.deps.privateTempDir?.(),
        ...(this.deps.writeScope ? { writeScope: this.deps.writeScope } : {}),
        ...(this.deps.readOnly ? { readOnly: true } : {}),
        signal,
      };
      // W2-L2：工具循环 = 唯一接受 interim 的窗口（agent_task 等阻塞在 executeWithMeta）。
      // try/finally 对称置位/复位 toolPending——任何意外退出都不泄漏窗口（坑清单 §1.4-3）。
      // docs/15：协调者同轮多个工具调用**并行执行**（agent_tasks 退役，并行派发 = 同轮
      // 多个 agent_task 调用；注册表全是派发/控制类，无顺序依赖）。普通会话保持顺序——
      // 文件工具有先后语义（写后读等）。并行版 UI：调用块按启动序先打、结果各自完成时报，
      // 消息等全部完成后统一回填（mergeInterimQueue 的「本轮 tool 消息已 push」形状不变）。
      this.toolPending = true;
      try {
        const calls = result.toolCalls;
        if (this.deps.sessionKind === "coordinator" && calls.length > 1) {
          for (const call of calls) ui.printToolCall(call.name, previewArgs(call.arguments), call.id, call.arguments);
          const done = await Promise.all(
            calls.map(async (call) => {
              const r = await registry.executeWithMeta(call.name, call.arguments, ctx);
              this.notePrune(r);
              ui.printToolResult(r.full, { prunedChars: r.prunedChars, ...(r.spilled ? { spilled: r.spilled } : {}) }, call.id);
              return { call, r };
            }),
          );
          // docs/34：工具返回图像（read_image）挂到 tool 消息——提供方投影成路由对应形态
          for (const { call, r } of done)
            this.history.push({ role: "tool", toolCallId: call.id, content: r.text, ...(r.images?.length ? { images: r.images } : {}) });
        } else {
          for (const call of calls) {
            ui.printToolCall(call.name, previewArgs(call.arguments), call.id, call.arguments);
            const r = await registry.executeWithMeta(call.name, call.arguments, ctx);
            this.notePrune(r);
            // UI 拿完整输出（spill 只影响入模型内容）；元数据带修剪信息供前端展示
            ui.printToolResult(r.full, { prunedChars: r.prunedChars, ...(r.spilled ? { spilled: r.spilled } : {}) }, call.id);
            this.history.push({ role: "tool", toolCallId: call.id, content: r.text, ...(r.images?.length ? { images: r.images } : {}) });
          }
        }
      } finally {
        this.toolPending = false; // 关窗：drain 与后续路径的新消息不再走 interim（落 inbox，窗口有界）
      }
      // W2-L2 合并点：本轮全部 tool 消息已 push（executeWithMeta 不抛错、中止也回错误文本，
      // tool 消息必然齐全）→ 此处合并 interim 缓冲 [user,assistant]×k，序列合法；中止路径
      // 同样经过这里（缓冲不丢）。必须等在飞的 interim 完成，否则那对消息错过本轮合并。
      await this.interimFlight?.catch(() => {});
      this.mergeInterimQueue();
      this.maybeWarnContext(); // docs/42：越过预警线一次性提示（tool 消息后的 user 消息是合法形状）
      if (signal?.aborted) {
        ui.printInfo("[本轮已被用户中断]");
        return null;
      }
    }

    // 达到轮次上限：注入提示，让模型不带工具直接收尾
    ui.printInfo(`已达工具调用轮次上限（${this.maxToolRounds}），要求模型直接总结。`);
    this.history.push({
      role: "user",
      content: "（系统提示：工具调用轮次已达上限，请不要再调用工具，直接基于已获得的信息给出最终回答。）",
    });
    this.enforceImageBudget(); // docs/42 修订：收尾请求前同样过一遍预算
    const omit = this.imagesOmitted();
    const finalBreakdown = estimateBreakdown(this.history, [], this.deps.skills ?? [], this.deps.mcpInstructions ?? null, this.thinkingPassbackOf(), omit); // 收尾请求不带工具
    const finalReqLen = this.history.length; // 实测锚点用（收尾请求 payload 形状）
    const final = await provider.chat({
      messages: [...this.history],
      effort: settings.effort,
      ...(omit ? { omitImages: true } : {}),
      onReasoningDelta: (t) => ui.printReasoningDelta(t),
      onReplayDegrade: (reason, src) => {
        if (!this.replayDegradeWarned.has(src)) {
          this.replayDegradeWarned.add(src);
          ui.printInfo(reason);
        }
      },
      onTextDelta: (t) => ui.printTextDelta(t),
      signal,
    });
    this.seenLen = finalReqLen;
    if (final.usage) {
      // 实测锚点（fixed 不含工具 schema——收尾请求没带；下次请求重新带上时由差量校正补回）
      this.anchorUsage(
        final.usage.promptTokens,
        finalReqLen,
        finalBreakdown.systemPrompt + finalBreakdown.skills + finalBreakdown.systemTools + finalBreakdown.mcp,
      );
    }
    if (final.finishReason === "length") {
      ui.printInfo("[警告] 模型输出因达到 max_tokens 上限被截断（finish_reason=length）");
    }
    if (!final.content.trim()) return null; // 空回复同样不入历史
    this.history.push({
      role: "assistant",
      content: final.content,
      toolCalls: [],
      ...(final.reasoning
        ? {
            thinking: {
              text: final.reasoning,
              ...(final.reasoningSignature !== undefined ? { signature: final.reasoningSignature } : {}),
              ...(provider.model ? { model: provider.model } : {}),
            },
          }
        : {}),
    });
    if (final.usage) ui.printUsage({ ...final.usage, breakdown: withOther(final.usage, finalBreakdown) });
    rounds++;
    return { finalText: final.content.trim(), rounds };
  }
}

// ---------- 子代理（P8 预留 seam 的运行机制） ----------

export interface SubagentRunDeps {
  provider: LLMProvider;
  /** 已装配的系统提示（宿主用 assembleSystemPrompt 生成：含工作区规则/技能/两级 AGENTS.md） */
  systemPrompt: string;
  req: SubagentRequest;
}

/**
 * 子代理：一次性的嵌套 agent 运行——独立历史（system + task 两条消息）、无工具、
 * 无 UI 推流、不写父会话历史。失败一律 ok:false 返回（不抛错），由调用方决定呈现。
 * 工具执行与多轮循环是将来出现真实消费者时的扩展点（当前 seam 只验证接线）。
 */
export async function runSubagent(deps: SubagentRunDeps): Promise<SubagentResult> {
  try {
    const r = await deps.provider.chat({
      messages: [
        { role: "system", content: deps.systemPrompt },
        { role: "user", content: deps.req.task },
      ],
      effort: deps.req.effort ?? "off",
      signal: deps.req.timeoutMs !== undefined ? AbortSignal.timeout(deps.req.timeoutMs) : undefined,
    });
    const text = r.content.trim();
    if (!text) return { ok: false, text: "", error: "子代理返回了空回复" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: "", error: e instanceof Error ? e.message : String(e) };
  }
}

