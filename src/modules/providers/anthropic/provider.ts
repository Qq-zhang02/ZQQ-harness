/**
 * Anthropic Messages API 提供方（/v1/messages，SSE 流式），零 SDK 依赖（node fetch）。
 * 适用于 Anthropic 官方及任何 Anthropic 格式的兼容端点。
 * 映射：system 消息 → system 参数；assistant.toolCalls → tool_use 块；
 * tool 消息（连续多条合并）→ user 消息的 tool_result 块；
 * 思考档位 → 扩展思考 budget_tokens（off 不思考）。
 * 思考回放：带 toolCalls 轮的 thinking 块带签名回放（置于 blocks 首位）；
 * 对齐规则——模型一致且签名存在才回放（签名逐字，含空签名），模型不一致静默省略
 * （签名跨模型不可移植，绝不伪造），签名缺失降级省略并回调 onDegrade 告警。
 * 思考关闭（off/default）的请求不回放 thinking 块。
 */
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
  EffortSetting,
  LLMProvider,
  ThinkingBlock,
  ToolCallRequest,
  ToolSchema,
  UsageInfo,
} from "../../../llm/provider.ts";
import { isThinkingEffort } from "../../../config.ts";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 思考档位；"default"=不发送任何思考参数；off=关闭扩展思考；low/high/max 映射 budget */
  effort?: EffortSetting;
  /** 输出上限；Anthropic 必填，缺省按思考预算自动抬高 */
  maxTokens?: number;
}

const API_VERSION = "2023-06-01";
// 思考档位 → budget_tokens（Anthropic 要求 budget ≥1024 且 < max_tokens）
const EFFORT_BUDGET: Partial<Record<string, number>> = { low: 4096, high: 16384, max: 32768 };
// 输出上限推导（docs/21 §2.4 提名）：无 budget 缺省 8192；有 budget = budget + 8192 余量；
// 1024 = 协议下限（max_tokens 须 > budget）与无 budget 时的输出下限。
const DEFAULT_OUTPUT_TOKENS = 8_192;
const OUTPUT_HEADROOM_TOKENS = 8_192;
const BUDGET_MIN_HEADROOM_TOKENS = 1_024;

interface SseEvent {
  type?: string;
  error?: { message?: string } | null;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null } | null;
  content_block?: { type?: string; id?: string; name?: string } | null;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  } | null;
  /** usage 事件形状：官方端点 message_delta 只带 output_tokens；GLM 等 Anthropic 兼容端点
   *  在 message_delta 携带最终 input_tokens / cache_read_input_tokens（真机实证：GLM 的
   *  message_start.usage.input_tokens 恒为 0 占位，实值只在 message_delta——docs/35）。
   *  DeepSeek 的 anthropic 兼容端另附 output_tokens_details.thinking_tokens（docs/37）。 */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
  } | null;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 思考回放参数：model 为当前请求模型（对齐判定），onDegrade 承接签名缺失降级告警。 */
export interface ReplayOptions {
  model: string;
  onDegrade?: (reason: string, source: ThinkingBlock) => void;
}

/**
 * 对齐判定（与 agent 的 token 计数判定保持同源规则）：
 * 模型一致且签名存在 → 回放（签名逐字，含空字符串）；
 * 模型一致但签名缺失 → 降级省略 + onDegrade；
 * 模型不一致或缺失 → 静默省略（不伪造签名，跨模型签名不可移植）。
 */
export function replayableThinking(th: ThinkingBlock, opts: ReplayOptions): { block: Record<string, unknown> } | { degrade: true } | null {
  if (th.model === undefined || th.model !== opts.model) return null;
  if (th.signature === undefined) return { degrade: true };
  return { block: { type: "thinking", thinking: th.text, signature: th.signature } };
}

/** docs/39：给最后一条消息的末块注入 cache_control 断点（官方缓存协议的启用开关；标记在
 *  「最新消息的末块」= 官方推荐的会话式断点位——缓存覆盖其全部前缀〔system+工具+历史〕，
 *  下一轮请求天然命中）。三家兼容端实测：MiMo 由「后端缓存但不报告」转为**命中可见**
 *  （input=62+read=1280）；DeepSeek 无副作用（自动缓存照旧）；GLM 忽略（不报错）。返回是否注入。 */
function injectCacheControl(messages: Array<{ role: "user" | "assistant"; content: unknown }>): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const blk = last.content[last.content.length - 1] as Record<string, unknown>;
    if (!blk.cache_control) {
      blk.cache_control = { type: "ephemeral" };
      return true;
    }
  }
  return false;
}

/** docs/39：去除全部 cache_control 标记（未知兼容端对标记报 400 时的去标重试路径）。 */
function stripCacheControl(messages: Array<{ content: unknown }>): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const blk of m.content as Array<Record<string, unknown>>) delete blk.cache_control;
    }
  }
}

/** 映射 harness 消息：system 由调用方单独处理；tool 消息合并为 user 的 tool_result 块。 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  replay?: ReplayOptions,
): Array<{ role: "user" | "assistant"; content: unknown }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      // docs/10 R3：带图 user 消息转多模态 blocks（text + image base64 source）；
      // 无图保持纯字符串（字节不变）
      if (m.images && m.images.length > 0) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } })),
          ],
        });
      } else {
        out.push({ role: "user", content: m.content });
      }
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      // 回放范围=带工具调用的轮次（API 校验点）；最终回答轮的思考仅供前端显示，不回传
      if (replay && m.thinking && m.toolCalls.length > 0) {
        const r = replayableThinking(m.thinking, replay);
        if (r && "block" in r) blocks.push(r.block);
        else if (r) replay.onDegrade?.("思考签名缺失，已从历史省略该思考块（官方端点多轮工具可能报错）", m.thinking);
      }
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParseJson(tc.arguments) });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "(空回复)" }] });
      continue;
    }
    // docs/34：read_image 的图像投影——tool_result 官方支持 content 数组（text + image base64 块）
    const block =
      m.images && m.images.length > 0
        ? {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: [
              { type: "text", text: m.content },
              ...m.images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } })),
            ],
          }
        : { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
    const last = out[out.length - 1];
    const lastContent = last && last.role === "user" ? (last.content as Array<Record<string, unknown>>) : null;
    if (Array.isArray(lastContent) && (lastContent[0] as { type?: string } | undefined)?.type === "tool_result") {
      lastContent.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

function endpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
}
// docs/21 §2.4：裸 fetch 无 signal 时无超时上限——显式兜底（20min > 最长合法流：32k budget+余量
// 按 ~50 tok/s ≈ 12min）；外部中止信号经 AbortSignal.any 合并，语义不变。
const ANTHROPIC_FETCH_TIMEOUT_MS = 1_200_000;


export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private apiKey: string;
  private baseUrl: string;
  readonly model: string;
  private effort: EffortSetting;
  private maxTokens?: number;

  constructor(opts: AnthropicOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens;
  }

  /**
   * 逐消息回放判定（§4.6 能力声明）：与 toAnthropicMessages 的实际回放严格同源——
   * 规则复用 replayableThinking（模型一致 + 签名存在才回放，缺失降级省略），
   * 外层门槛与 chat() 一致：思考模式（budget 存在）+ 带工具调用的轮次。
   * agent 据此计数，计数口径与实际请求不再可能漂移。
   */
  thinkingPassback(m: ChatMessage, effort: EffortSetting): boolean {
    if (m.role !== "assistant" || !isThinkingEffort(effort)) return false;
    if (m.toolCalls.length === 0 || m.thinking === undefined) return false;
    const r = replayableThinking(m.thinking, { model: this.model });
    return r !== null && "block" in r;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    // 会话档位优先，其次提供方配置；"default"=不发送思考参数；off=显式关闭；low/high/max 映射 budget
    const effort = params.effort ?? this.effort;
    const budget = effort !== "default" ? EFFORT_BUDGET[effort] : undefined;
    const maxTokens = this.maxTokens ?? (budget ? budget + OUTPUT_HEADROOM_TOKENS : DEFAULT_OUTPUT_TOKENS);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: Math.max(maxTokens, budget ? budget + BUDGET_MIN_HEADROOM_TOKENS : BUDGET_MIN_HEADROOM_TOKENS),
      // 思考开启才回放 thinking 块（签名对齐/降级见 replayableThinking）；思考关闭保持纯净历史
      messages: toAnthropicMessages(params.messages, budget ? { model: this.model, onDegrade: params.onReplayDegrade } : undefined),
      stream: true,
    };
    const system = params.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    if (system) body.system = system;
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t: ToolSchema) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    // docs/37：off 档显式发 disabled——三家兼容端点（GLM/DeepSeek/MiMo）缺省=默认思考，
    // 不发参数关不掉（实测照样思考烧 token）；官方 Anthropic 只认 enabled（400）→ 下方
    // 去参重试兜底（官方缺省本就是关，语义不变）。
    const wantDisabled = effort === "off";
    if (wantDisabled) body.thinking = { type: "disabled" };
    // docs/39：默认注入 cache_control 断点（末消息末块）——MiMo 激活缓存+报告、DeepSeek
    // 无副作用、GLM 忽略；未知兼容端若对标记 400 → 下方去标重试兜底。
    const cacheMarked = injectCacheControl(body.messages as Array<{ role: "user" | "assistant"; content: unknown }>);

    const doFetch = (): Promise<Response> =>
      fetch(endpoint(this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
        signal: params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(ANTHROPIC_FETCH_TIMEOUT_MS)])
          : AbortSignal.timeout(ANTHROPIC_FETCH_TIMEOUT_MS),
      });
    let res = await doFetch();
    if (res.status === 400 && ((wantDisabled && body.thinking) || cacheMarked)) {
      // 官方 Anthropic 对 type:"disabled" 报 400（协议只认 enabled）：去掉显式关参数重试一次；
      // docs/39：未知兼容端对 cache_control 标记报 400 同路——去标后重试（退回该端原生缓存行为）
      if (wantDisabled) delete body.thinking;
      if (cacheMarked) stripCacheControl(body.messages as Array<{ content: unknown }>);
      res = await doFetch();
    }
    if (!res.ok || !res.body) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`Anthropic API ${res.status}：${detail || res.statusText}`);
    }

    let content = "";
    let reasoning = "";
    let signature = "";
    let finishReason: string | null = null;
    let usage: UsageInfo | null = null;
    const toolAcc = new Map<number, ToolCallRequest>();
    let toolIdx = -1;
    let buffer = "";
    const decoder = new TextDecoder();

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev: SseEvent;
        try {
          ev = JSON.parse(payload) as SseEvent;
        } catch {
          continue; // 非 JSON 行（服务器杂音）
        }
        switch (ev.type) {
          case "error":
            throw new Error(`Anthropic API 错误：${ev.error?.message ?? "未知错误"}`);
          case "message_start": {
            // 官方端点此处即实值；GLM 等兼容端点为 0 占位（实值在末尾 message_delta，见下）。
            // docs/38：官方语义 input_tokens 只算未命中部分——总输入 = input + cache_read +
            // cache_creation（DeepSeek 兼容端实测 R2：178+1024=1202；GLM/MiMo 的 cache 恒 0，
            // 加和 no-op，两种形状统一）。
            const su = ev.message?.usage;
            usage = {
              promptTokens: (su?.input_tokens ?? 0) + (su?.cache_read_input_tokens ?? 0) + (su?.cache_creation_input_tokens ?? 0),
              completionTokens: 0,
              ...(su?.cache_read_input_tokens ? { cacheHitTokens: su.cache_read_input_tokens } : {}),
            };
            break;
          }
          case "content_block_start":
            if (ev.content_block?.type === "tool_use") {
              toolIdx++;
              toolAcc.set(toolIdx, {
                id: ev.content_block.id ?? "",
                name: ev.content_block.name ?? "",
                arguments: "",
              });
            }
            break;
          case "content_block_delta": {
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text) {
              content += d.text;
              params.onTextDelta?.(d.text);
            } else if (d?.type === "thinking_delta" && d.thinking) {
              reasoning += d.thinking;
              params.onReasoningDelta?.(d.thinking);
            } else if (d?.type === "signature_delta" && d.signature) {
              signature += d.signature;
            } else if (d?.type === "input_json_delta" && d.partial_json) {
              const cur = toolAcc.get(toolIdx);
              if (cur) cur.arguments += d.partial_json;
            }
            break;
          }
          case "message_delta": {
            const reason = ev.delta?.stop_reason;
            finishReason =
              reason === "max_tokens"
                ? "length"
                : reason === "tool_use"
                  ? "tool_calls"
                  : reason === "end_turn"
                    ? "stop"
                    : (reason ?? null);
            // 用量兜底合并（docs/35 真机待办3）：官方端点 message_delta 只有 output_tokens；
            // GLM 等兼容端点的 input_tokens 实值（message_start 是 0 占位）与缓存命中都在这里——
            // 逐字段择新覆盖，两侧端点形状都齐。usage 缺席（无 message_start 的畸形流）就地补建。
            // docs/37：DeepSeek 兼容端在此附思考 token（output_tokens_details.thinking_tokens，
            // 官方协议无此字段）——读入后与 openai 路线的 reasoning_tokens 同口径（顶栏「其中思考」）。
            // docs/38：promptTokens 按官方公式取总输入（未命中 input + 命中读 cache_read + 命中写
            // cache_creation）——此前裸取 input_tokens 会漏掉命中部分（输入少算、命中率被钳到 100%）。
            const u = ev.usage;
            if (u) {
              usage ??= { promptTokens: 0, completionTokens: 0 };
              if (u.output_tokens) usage.completionTokens = u.output_tokens;
              const inTotal = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
              if (inTotal > 0) usage.promptTokens = inTotal;
              if (u.cache_read_input_tokens) usage.cacheHitTokens = u.cache_read_input_tokens;
              const think = u.output_tokens_details?.thinking_tokens;
              if (think) usage.reasoningTokens = think;
            }
            break;
          }
          default:
            break; // ping 等其他事件忽略
        }
      }
    }

    const toolCalls = [...toolAcc.values()].filter((t) => t.name.length > 0);
    return {
      content,
      reasoning,
      ...(signature ? { reasoningSignature: signature } : {}),
      toolCalls,
      usage,
      finishReason,
    };
  }
}
