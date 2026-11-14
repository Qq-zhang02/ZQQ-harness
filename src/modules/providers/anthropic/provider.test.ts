import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, replayableThinking, toAnthropicMessages } from "./provider.ts";
import type { ChatMessage, ThinkingBlock } from "../../../llm/provider.ts";

const th = (over: Partial<ThinkingBlock> = {}): ThinkingBlock => ({
  text: "想一想",
  signature: "sig-abc",
  model: "claude-x",
  ...over,
});

test("replayableThinking：模型一致且签名存在 → 回放（空签名也逐字）", () => {
  const ok = replayableThinking(th(), { model: "claude-x" });
  assert.ok(ok && "block" in ok);
  assert.deepEqual(ok.block, { type: "thinking", thinking: "想一想", signature: "sig-abc" });
  // 空签名是合法值：逐字回放，绝不补造
  const empty = replayableThinking(th({ signature: "" }), { model: "claude-x" });
  assert.ok(empty && "block" in empty && empty.block.signature === "");
});

test("replayableThinking：模型不一致 → 静默省略（跨模型签名不可移植）", () => {
  assert.equal(replayableThinking(th({ model: "claude-old" }), { model: "claude-x" }), null);
  // 缺 model 字段（异构来源）同样视为不对齐
  assert.equal(replayableThinking(th({ model: undefined }), { model: "claude-x" }), null);
});

test("replayableThinking：模型一致但签名缺失 → 降级", () => {
  const r = replayableThinking(th({ signature: undefined }), { model: "claude-x" });
  assert.ok(r && "degrade" in r);
});

test("toAnthropicMessages：thinking 块置于 assistant blocks 首位（先于 text/tool_use）", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "问" },
    {
      role: "assistant",
      content: "查一下",
      toolCalls: [{ id: "t1", name: "f", arguments: "{}" }],
      thinking: th(),
    },
  ];
  const out = toAnthropicMessages(msgs, { model: "claude-x" });
  const blocks = out[1].content as Array<Record<string, unknown>>;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["thinking", "text", "tool_use"],
  );
});

test("toAnthropicMessages：签名缺失 → 省略该块并回调 onDegrade（含 thinking 源对象）", () => {
  const degraded: ThinkingBlock[] = [];
  const thinking = th({ signature: undefined });
  const msgs: ChatMessage[] = [
    { role: "assistant", content: "查", toolCalls: [{ id: "t1", name: "f", arguments: "{}" }], thinking },
  ];
  const out = toAnthropicMessages(msgs, { model: "claude-x", onDegrade: (_r, src) => degraded.push(src) });
  const blocks = out[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0], thinking);
});

test("toAnthropicMessages：模型不一致 → 静默省略且不触发 onDegrade；无 replay 参数行为与旧版一致", () => {
  const msgs: ChatMessage[] = [
    { role: "assistant", content: null, toolCalls: [{ id: "t1", name: "f", arguments: "{}" }], thinking: th({ model: "other" }) },
  ];
  let degradeCalls = 0;
  const out = toAnthropicMessages(msgs, {
    model: "claude-x",
    onDegrade: () => {
      degradeCalls++;
    },
  });
  const blocks = out[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.map((b) => b.type), ["tool_use"]);
  assert.equal(degradeCalls, 0);
  // 不传 replay（思考关闭的请求）：完全不带 thinking 块
  const legacy = toAnthropicMessages(msgs);
  assert.deepEqual((legacy[0].content as Array<Record<string, unknown>>).map((b) => b.type), ["tool_use"]);
});

test("toAnthropicMessages：最终回答轮（无 toolCalls）的思考不回放——存档仅供前端显示", () => {
  const msgs: ChatMessage[] = [
    { role: "assistant", content: "最终答案", toolCalls: [], thinking: th({ signature: "s" }) },
  ];
  let degradeCalls = 0;
  const out = toAnthropicMessages(msgs, {
    model: "claude-x",
    onDegrade: () => {
      degradeCalls++;
    },
  });
  const blocks = out[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.map((b) => b.type), ["text"]);
  assert.equal(degradeCalls, 0);
});

// ---- provider.chat：SSE 签名捕获 + 请求体回放（stub fetch，无网络） ----

const enc = new TextEncoder();

function sseResponse(events: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MIN_EVENTS = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "推理中" } },
  { type: "content_block_delta", delta: { type: "signature_delta", signature: "sig-签名" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "答案" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
];

function withFetchStub(handler: (body: Record<string, unknown>) => Response): { bodies: Record<string, unknown>[]; restore: () => void } {
  const bodies: Record<string, unknown>[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return handler(bodies[bodies.length - 1]!);
  }) as typeof fetch;
  return { bodies, restore: () => (globalThis.fetch = orig) };
}

function makeProvider(effort: "off" | "high" = "high"): AnthropicProvider {
  return new AnthropicProvider({ apiKey: "k", baseUrl: "https://example.invalid", model: "claude-x", effort });
}

test("chat：signature_delta 聚合进 reasoningSignature，thinking/text 正常流出", async () => {
  const stub = withFetchStub(() => sseResponse(MIN_EVENTS));
  try {
    const r = await makeProvider().chat({ messages: [{ role: "user", content: "问" }] });
    assert.equal(r.reasoning, "推理中");
    assert.equal(r.reasoningSignature, "sig-签名");
    assert.equal(r.content, "答案");
    assert.equal(r.finishReason, "stop");
    assert.equal(r.usage?.promptTokens, 10);
    assert.equal(r.usage?.completionTokens, 5);
  } finally {
    stub.restore();
  }
});

test("chat：思考开启时回放对齐的 thinking 块（带签名），思考关闭不回放也不发思考参数", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "问" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "t1", name: "f", arguments: "{}" }],
      thinking: { text: "想一想", signature: "s", model: "claude-x" },
    },
    { role: "tool", toolCallId: "t1", content: "果" },
  ];
  const stub = withFetchStub(() => sseResponse(MIN_EVENTS));
  try {
    // 思考开启（effort=high → budget）：thinking 块以原生格式回放
    const on = await makeProvider("high").chat({ messages: history });
    assert.equal(on.reasoning, "推理中");
    const bodyOn = stub.bodies[0]!;
    const blocks = (bodyOn.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]!.content;
    assert.equal(blocks[0].type, "thinking");
    assert.deepEqual(blocks[0], { type: "thinking", thinking: "想一想", signature: "s" });
    assert.deepEqual(bodyOn.thinking, { type: "enabled", budget_tokens: 16384 });

    // 思考关闭（effort=off）：不发 thinking 参数，也不回放 thinking 块
    stub.bodies.length = 0;
    await makeProvider("off").chat({ messages: history });
    const bodyOff = stub.bodies[0]!;
    assert.equal(bodyOff.thinking, undefined);
    const blocksOff = (bodyOff.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]!.content;
    assert.deepEqual(blocksOff.map((b) => b.type), ["tool_use"]);
  } finally {
    stub.restore();
  }
});

test("chat：换模型后历史思考不回放（签名不跨模型）", async () => {
  const history: ChatMessage[] = [
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "t1", name: "f", arguments: "{}" }],
      thinking: { text: "想一想", signature: "s", model: "claude-old" },
    },
  ];
  const stub = withFetchStub(() => sseResponse(MIN_EVENTS));
  try {
    await makeProvider("high").chat({ messages: history });
    const blocks = (stub.bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    assert.deepEqual(blocks.map((b) => b.type), ["tool_use"]);
  } finally {
    stub.restore();
  }
});

test("专项：thinkingPassback 与 toAnthropicMessages 实际回放同源（token 计数口径对齐，§4.6）", () => {
  const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "http://x", model: "claude-x" });
  const okMsg: ChatMessage = {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "t1", name: "f", arguments: "{}" }],
    thinking: th(),
  };
  const noSig: ChatMessage = { ...okMsg, thinking: th({ signature: undefined }) };
  const crossModel: ChatMessage = { ...okMsg, thinking: th({ model: "claude-old" }) };
  const finalThink: ChatMessage = { role: "assistant", content: "完", toolCalls: [], thinking: th() };
  const plain: ChatMessage = { role: "user", content: "问" };
  for (const effort of ["high", "low", "max", "off", "default"] as const) {
    const roundMsgs: ChatMessage[] = [okMsg, noSig, crossModel, finalThink, plain];
    for (const m of roundMsgs) {
      const pb: boolean = provider.thinkingPassback?.(m, effort) ?? false;
      // 以判定结果决定 replay（与 chat() 的 budget 门槛同构）：回放与否必须与判定一一对应
      const mapped = toAnthropicMessages([m], pb ? { model: "claude-x" } : undefined);
      const blocks = mapped[0].content as Array<Record<string, unknown>>;
      const hasThink = Array.isArray(blocks) && blocks.some((b) => b.type === "thinking");
      assert.equal(hasThink, pb, `effort=${effort} kind=${(m as { thinking?: { model?: string } }).thinking?.model ?? "none"}`);
      if (pb) assert.deepEqual((blocks[0] as { thinking: string }).thinking, th().text);
    }
  }
  // 补充：带 replay 映射（chat 实际路径）下，降级/跨模型也不产生 thinking 块——与判定恒等
  for (const m of [noSig, crossModel]) {
    assert.equal(provider.thinkingPassback?.(m, "high"), false);
    const blocks = toAnthropicMessages([m], { model: "claude-x" })[0].content as Array<Record<string, unknown>>;
    assert.ok(!blocks.some((b) => b.type === "thinking"));
  }
});

// ---------- docs/10 R3：图片消息 → Anthropic 多模态 blocks ----------

test("toAnthropicMessages：user 带 images 转 [text, image(base64 source)]；无图保持纯字符串", () => {
  const img: ChatMessage = {
    role: "user",
    content: "看图",
    images: [{ mime: "image/png", data: "QUJD" }],
  };
  const out = toAnthropicMessages([{ role: "system", content: "sys" }, img]);
  assert.equal(out.length, 1, "system 单独处理不进 messages");
  const content = out[0]!.content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]!.type, "text");
  assert.equal(content[0]!.text, "看图");
  assert.equal(content[1]!.type, "image");
  assert.equal(content[1]!.source!.type, "base64");
  assert.equal(content[1]!.source!.media_type, "image/png");
  assert.equal(content[1]!.source!.data, "QUJD");
  const plain = toAnthropicMessages([{ role: "user", content: "问" }]);
  assert.equal(plain[0]!.content, "问", "无图消息字节不变");
});
