/** 与具体厂商无关的 LLM 抽象：为后续接入更多 provider 预留。 */

export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON Schema 参数的原始 JSON 字符串（OpenAI 格式约定） */
  arguments: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object */
  parameters: Record<string, unknown>;
}

/**
 * 输入 token 的分类构成（估算值）：API 的 usage 只返回整次请求的总量，
 * 各分类由 Agent 按请求内容用内置 tokenizer 真实计数（资产缺失时回退字符换算），
 * 估算误差与框架开销并入 other；总量优先取 usage 实际返回——单次请求经
 * withOther 校准，Agent 的上下文总量以最近一次实测锚定、估算只补新增。
 */
export interface UsageBreakdown {
  /** 系统提示词（含 AGENTS.md，不含技能清单） */
  systemPrompt: number;
  /** 技能清单（system 提示中的可用技能列表，不含 load_skill 加载的全文） */
  skills: number;
  /** 内置工具的 schema（如 run_pwsh、load_skill） */
  systemTools: number;
  /** MCP 工具的 schema（mcp__ 前缀） */
  mcp: number;
  /** 对话消息（含工具调用参数与工具结果） */
  messages: number;
  /** 实际总量 − 估算合计：分词差异、角色标记、JSON 包装等 */
  other: number;
}

/** 思考档位：off=关闭思考；low/high/max 对应 DeepSeek 官方 reasoning_effort 档位（默认 high）。 */
export type ThinkingEffort = "off" | "low" | "high" | "max";
/** 提供方级思考设置：default=不发送任何思考参数（由 API 自己决定，适配不支持思考档位的模型）。 */
export type EffortSetting = ThinkingEffort | "default";

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中的输入 token（DeepSeek 扩展字段，未返回时为 0/缺省） */
  cacheHitTokens?: number;
  /** 思考消耗的输出 token（completion_tokens_details.reasoning_tokens，未返回时缺省） */
  reasoningTokens?: number;
  /** 输入 token 分类估算（由 Agent 在每次请求前按实际内容计算） */
  breakdown?: UsageBreakdown;
}

export interface ChatResult {
  /** 本次回复的文本内容（流式已聚合） */
  content: string;
  /** 思考内容（reasoning_content，聚合）；展示用，带工具调用时由 agent 存入历史（thinking） */
  reasoning?: string;
  /** 思考签名（anthropic 路线 signature_delta 聚合；openai 路线无此概念） */
  reasoningSignature?: string;
  toolCalls: ToolCallRequest[];
  usage: UsageInfo | null;
  /** 本轮流结束的原因（stop/length/tool_calls 等）；length 表示输出被 max_tokens 截断 */
  finishReason?: string | null;
}

/**
 * 助手消息携带的思考块（仅存于带 toolCalls 的助手消息，最终回答轮不存）。
 * 签名是 Anthropic 官方端点回放 thinking 块的凭证；model 用于回放对齐——
 * 换模型后历史思考不回放（签名跨模型不可移植，绝不伪造）。
 */
export interface ThinkingBlock {
  text: string;
  signature?: string;
  model?: string;
}

/** user 消息携带的图片（docs/10 R3 视觉支持）：data 为裸 base64（无 data: 前缀）；
 *  mime 限定四种常见格式（OpenAI/Anthropic 双端点都支持的集合）。随会话历史存档。 */
export interface ChatImage {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
}

/** 文本模型省略图像时留在请求里的占位说明（docs/42 修订；两条提供方路线共用同一文案）。
 *  只改请求投影、不动历史消息——换回有视觉能力的模型后图像块原样恢复（已被图片预算移出的除外）。 */
export function imageOmittedNote(count: number): string {
  return `[图片未随请求发送（${count} 张）：当前模型不支持视觉，本次只发文字；图片仍保留在对话历史里，换回有视觉能力的模型后恢复显示]`;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ChatImage[] }
  | { role: "assistant"; content: string | null; toolCalls: ToolCallRequest[]; thinking?: ThinkingBlock }
  | { role: "tool"; toolCallId: string; content: string;
      /** 图像块（docs/34 read_image）：提供方投影成路由对应的图像形态（anthropic=tool_result
       *  内图像块；openai 兼容=紧随合成 user 多模态消息） */ images?: ChatImage[] };

export interface ChatParams {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** 流式文本增量回调，用于 CLI 逐字打印 */
  onTextDelta?: (text: string) => void;
  /** 思考流（reasoning_content）增量回调，用于展示思考过程 */
  onReasoningDelta?: (text: string) => void;
  /** 回放降级诊断：历史思考块因签名缺失被从请求中省略时调用（source 为该 thinking 对象，调用方可据此去重告警） */
  onReplayDegrade?: (reason: string, source: ThinkingBlock) => void;
  /** 当前对话的思考档位；不传用提供方配置档位 */
  effort?: EffortSetting;
  /** 图像省略（docs/42 修订，DSH 口径）：true=本次请求的模型不支持视觉——带图消息只发文本，
   *  图像块在请求内换成省略说明（imageOmittedNote）。缺省=照常投递图像。 */
  omitImages?: boolean;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  /** 主模型名（思考块回放对齐判定用；测试桩可不提供） */
  readonly model?: string;
  chat(params: ChatParams): Promise<ChatResult>;
  /**
   * 能力声明（模块化架构重构 §4.6）：该助手消息的思考文本是否会随本次请求回传/回放。
   * 这是"token 计数口径与实际请求同源"的唯一出处——各格式路线按自身回放规则实现
   * （agent 据此计数，不再自行按 provider.name 判定）；不实现 = 永不回传（测试桩等）。
   * effort = 当前会话思考档位（与 chat 收到的 effort 同值）。
   */
  thinkingPassback?(m: ChatMessage, effort: EffortSetting): boolean;
}
