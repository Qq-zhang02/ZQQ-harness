/**
 * OpenAI 兼容格式提供方（经 openai SDK，流式 + tool calling）。
 * 请求参数风格按 DeepSeek（thinking / reasoning_effort）；适用于 DeepSeek
 * 及其他 OpenAI 兼容端点（不识别思考参数的端点请自行评估兼容性）。
 */
import OpenAI from "openai";
import { isThinkingEffort, reasoningPassbackEnabled } from "../../../config.ts";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
  EffortSetting,
  LLMProvider,
  ToolCallRequest,
  ToolSchema,
  UsageInfo,
} from "../../../llm/provider.ts";

export interface OpenAICompatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 思考档位；"default"=不发送任何思考参数（由 API 自己决定，适配不支持思考档位的模型） */
  effort?: EffortSetting;
  /** 输出上限（max_tokens）；不传则用 API 默认（非思考 8K / 思考 64K / effort=max 128K） */
  maxTokens?: number;
}

function toSdkTool(tool: ToolSchema): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/**
 * 消息映射。passback=true 时（REASONING_PASSBACK 开关 + 思考模式，与 tokens 计数同源条件），
 * 带工具调用的助手消息把 thinking.text 作为 reasoning_content 回传（DeepSeek thinking 模式
 * 官方要求）；无工具调用的最终回答轮即使残留 thinking 也丢弃（API 反正忽略，省 token）。
 * user 消息带 images（docs/10 R3）时 content 转多模态数组（text + image_url data URI）；
 * 无图消息保持纯字符串（字节不变）。
 */
export function toSdkMessages(
  messages: ChatMessage[],
  passback: boolean,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const mapped = messages.map((m): Record<string, unknown> => {
    if (m.role === "assistant") {
      // 兜底：既无正文也无 tool_calls 的 assistant 消息会被 API 400 拒绝
      const hasCalls = m.toolCalls.length > 0;
      const content = hasCalls ? (m.content ?? null) : (m.content?.trim() ? m.content : "(空回复)");
      const msg: Record<string, unknown> = { role: "assistant", content };
      if (hasCalls) {
        msg.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        }));
        if (passback && m.thinking) msg.reasoning_content = m.thinking.text;
      }
      return msg;
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "user" && m.images && m.images.length > 0) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content },
          ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
  // 结构与 SDK 参数类型一致，此处一次受控断言收口
  return mapped as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}

/** DeepSeek：OpenAI 兼容格式（base_url https://api.deepseek.com），流式 + tool calling。 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  readonly model: string;
  private effort: EffortSetting;
  private maxTokens?: number;

  constructor(opts: OpenAICompatOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.model = opts.model;
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens;
  }

  /**
   * 逐消息回传判定（§4.6 能力声明）：与 toSdkMessages 的实际回传严格同源——
   * REASONING_PASSBACK 开关 + 思考模式 + 带工具调用的轮次 + 消息带 thinking。
   * agent 据此计数，计数口径与实际请求不再可能漂移。
   */
  thinkingPassback(m: ChatMessage, effort: EffortSetting): boolean {
    const on = reasoningPassbackEnabled() && isThinkingEffort(effort);
    return on && m.role === "assistant" && m.toolCalls.length > 0 && m.thinking !== undefined;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    // 会话档位优先，其次提供方配置档位；"default"=不发送任何思考参数（由 API 自己决定）
    const effort = params.effort ?? this.effort;
    // 思考回传：默认关（实测不回传也无 400，省 token）；开关打开且处于思考模式时合规回传
    const passback = reasoningPassbackEnabled() && isThinkingEffort(effort);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toSdkMessages(params.messages, passback),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools.map(toSdkTool) } : {}),
      ...(effort !== "default"
        ? {
            thinking: effort === "off" ? { type: "disabled" } : { type: "enabled" },
            ...(effort !== "off" ? { reasoning_effort: effort } : {}),
          }
        : {}),
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    const stream = await this.client.chat.completions.create(
      body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      params.signal ? { signal: params.signal } : undefined,
    );

    let content = "";
    let reasoning = "";
    let usage: UsageInfo | null = null;
    let finishReason: string | null = null;
    const toolAcc = new Map<number, ToolCallRequest>();

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      // reasoning_content 是 DeepSeek 扩展字段，SDK 类型里没有
      const rc = delta ? (delta as unknown as { reasoning_content?: string | null }).reasoning_content : undefined;
      if (rc) {
        reasoning += rc;
        params.onReasoningDelta?.(rc);
      }
      if (delta?.content) {
        content += delta.content;
        params.onTextDelta?.(delta.content);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        toolAcc.set(idx, cur);
      }
      if (chunk.usage) {
        // completion_tokens_details.reasoning_tokens 为思考消耗；SDK 类型里没有
        const details = (chunk.usage as unknown as {
          completion_tokens_details?: { reasoning_tokens?: number | null } | null;
        }).completion_tokens_details;
        const reasoningTokens = details?.reasoning_tokens ?? 0;
        const cacheHit = (chunk.usage as unknown as { prompt_cache_hit_tokens?: number | null })
          .prompt_cache_hit_tokens;
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          ...(cacheHit ? { cacheHitTokens: cacheHit } : {}),
          ...(reasoningTokens ? { reasoningTokens: reasoningTokens } : {}),
        };
      }
    }
    // 流式迭代器对流中 abort 是吞掉 AbortError 优雅结束（不抛错，带已累积的空/半截结果
    // 正常返回）——abort 后不能把残缺结果当正常完成上报，这里按中止抛错还原真相。上层
    // （Agent.chatInterruptible）据信号把它识别为暂停打断：本轮作废回闸门，而不是让
    // worker 以「空回复」结算任务（手动暂停一次却送达两条消息的真机 bug）。
    if (params.signal?.aborted) throw new Error("请求已被中止（输出未完成）");

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((t) => t.name.length > 0);

    return { content, reasoning, toolCalls, usage, finishReason };
  }
}
