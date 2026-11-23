import test from "node:test";
import assert from "node:assert/strict";
import { Agent, type AgentUi, type CompactionDeps } from "./agent.ts";
import { chooseCutIndex, isTurnBoundary, isContextOverflowError } from "./compaction.ts";
import type { ChatMessage, ChatParams, ChatResult, LLMProvider } from "./llm/provider.ts";
import { ToolRegistry, type Tool } from "./tools/registry.ts";
import { createWorkspace } from "./workspace.ts";
import { messageTokens } from "./tokens.ts";

const tokenOf = (m: ChatMessage) => (typeof m.content === "string" ? Math.ceil(m.content.length / 10) : 1) + 1;

function turn(userText: string, assistantText: string, withTool = false): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "user", content: userText }];
  msgs.push({
    role: "assistant",
    content: withTool ? null : assistantText,
    toolCalls: withTool ? [{ id: "c-" + userText, name: "t", arguments: "{}" }] : [],
  });
  if (withTool) {
    msgs.push({ role: "tool", toolCallId: "c-" + userText, content: assistantText });
  }
  return msgs;
}

function sampleHistory(): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
  msgs.push(...turn("第一轮问题", "第一轮回答", true)); // 1..3
  msgs.push(...turn("第二轮问题", "第二轮回答")); // 4..5
  msgs.push(...turn("第三轮问题", "第三轮回答", true)); // 6..8
  msgs.push(...turn("第四轮问题", "第四轮回答")); // 9..10
  return msgs; // 长度 11（含 system）
}

test("isTurnBoundary：user 是安全切点；tool 结果前/中间不可切", () => {
  const h = sampleHistory();
  assert.equal(isTurnBoundary(h, 4), true); // user（第二轮）
  assert.equal(isTurnBoundary(h, 2), true); // assistant(toolCalls) 之前切：它与它的 tool 结果都留在保留区
  assert.equal(isTurnBoundary(h, 3), false); // assistant(toolCalls) 与 tool 结果之间——拆对，非法
  assert.equal(isTurnBoundary(h, 0), false); // system
  assert.equal(isTurnBoundary(h, h.length), true); // 末尾：无保留尾部，无配对可拆
  assert.equal(isTurnBoundary(h, h.length + 1), false);
});

test("chooseCutIndex：保留预算内尽量多的尾部完整轮次", () => {
  const h = sampleHistory();
  // 每条消息 token ≈ 内容长度/10 + 1，粗略给个预算：只装下最后两条（第四轮）略多
  const lastTwo = tokenOf(h[9]) + tokenOf(h[10]);
  const cut = chooseCutIndex(h, lastTwo + 1, tokenOf);
  // 切点必须落在第四轮的 user 上（i=9），保证 toolCall 组不被拆开
  assert.equal(cut, 9);
  assert.equal(h[cut]?.role, "user");
});

test("chooseCutIndex：toolCall 跨切点时切点被推后（配对平衡）", () => {
  const h = sampleHistory();
  // 预算只够最后一条消息：理论最优是 i=10，但 h[10] 前是 h[9]（user），10 是合法切点
  // 构造预算恰好会逼到 i=8（tool 结果处）：h[8] 是 tool，非法 → 应推后到 i=9
  const onlyLast = tokenOf(h[10]);
  const cut = chooseCutIndex(h, onlyLast, tokenOf);
  assert.notEqual(cut, 8); // 8 会在第三轮 tool 结果与第四轮 user 之间？—— h[8] 是 tool 不可作为起点
  assert.ok(h[cut]?.role === "user" || isTurnBoundary(h, cut));
});

test("chooseCutIndex：单轮超出预算时最大化压缩（i=n 全部摘要）", () => {
  const h: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "tiny" },
    { role: "assistant", content: "G".repeat(10_000), toolCalls: [] },
  ];
  const cut = chooseCutIndex(h, 10, tokenOf);
  // 巨型单轮塞不进任何预算：切点推到 i=n（末尾也是合法边界），全部历史进摘要
  assert.equal(cut, 3);
});

test("isContextOverflowError：识别输入超限错误，不误报普通错误", () => {
  assert.ok(isContextOverflowError(new Error("This model's maximum context length is 4096 tokens")));
  assert.ok(isContextOverflowError(new Error("prompt is too long: 250000 tokens > 200000 maximum")));
  assert.ok(isContextOverflowError(new Error("输入的上下文长度超过模型限制")));
  assert.ok(!isContextOverflowError(new Error("max_tokens must be at least 1")));
  assert.ok(!isContextOverflowError(new Error("连接超时")));
  assert.ok(!isContextOverflowError("random failure"));
});

// ---- Agent.compact 集成 ----

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  calls: ChatParams[] = [];
  private script: ((p: ChatParams) => ChatResult | Promise<never>)[];
  constructor(script: ((p: ChatParams) => ChatResult | Promise<never>)[]) {
    this.script = script;
  }
  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    const step = this.script[this.calls.length - 1];
    if (!step) return { content: "(脚本耗尽)", toolCalls: [], usage: null };
    return await step(params);
  }
}

const echoTool: Tool = {
  name: "echo_tool",
  description: "回声",
  parameters: { type: "object", properties: { value: { type: "string" } } },
  execute: async (args) => `echo:${String(args.value)}`,
};

function stubUi(sink: string[]): AgentUi {
  return {
    printReasoningDelta: () => {},
    printTextDelta: (t) => sink.push(t),
    printToolCall: () => {},
    printToolResult: (s) => sink.push(`[result]${s}`),
    printInfo: (m) => sink.push(`[info]${m}`),
    printUsage: () => {},
  };
}

function makeCompactAgent(script: ((p: ChatParams) => ChatResult)[], compaction: Partial<CompactionDeps> = {}) {
  const provider = new ScriptedProvider(script);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const sink: string[] = [];
  const deps: CompactionDeps = {
    contextLength: () => 1, // 保留预算为 0：逼出最大化压缩（生产按提供方真实上下文长度计算）
    summarize: async () => "摘要：用户在验证压缩功能。",
    backup: () => {},
    ...compaction,
  };
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi(sink),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "default" },
    maxToolRounds: 5,
    compaction: deps,
  });
  return { agent, provider, sink };
}

// ---------- docs/42 修订：图像块随历史常驻；压缩时被摘要区间里的图随消息移除，保留尾部的图照常携带 ----------

test("compact：压缩前每次请求都携带图像块；压缩后被摘要区间里的图移除、保留尾部的图照常携带，摘要输入带图片路径", async () => {
  const IMG = { mime: "image/png" as const, data: "aGVsbG8=" };
  const toolCall = (id: string): ChatResult => ({ content: "", toolCalls: [{ id, name: "read_image", arguments: "{}" }], usage: null });
  const final = (text: string): ChatResult => ({ content: text, toolCalls: [], usage: null });
  const provider = new ScriptedProvider([() => toolCall("a"), () => final("第一轮完成"), () => toolCall("b"), () => final("第二轮完成")]);
  const registry = new ToolRegistry();
  registry.register({
    name: "read_image",
    description: "读图",
    parameters: { type: "object", properties: {} },
    execute: async () => "无图回退",
    executeImage: async () => ({ text: "[已读取图片 fig.png]", images: [IMG] }),
  });
  let summarized: ChatMessage[] = [];
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "default" },
    maxToolRounds: 5,
    vision: true,
    compaction: {
      contextLength: () => 1,
      summarize: async (ms) => {
        summarized = ms;
        return "摘要：用户在验证压缩功能。";
      },
    },
  });
  await agent.run("第一轮");
  await agent.run("第二轮");
  const isToolWithImage = (m: ChatMessage): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool" && !!m.images?.length;
  const imagesPerRequest = provider.calls.map((c) => c.messages.filter(isToolWithImage).length);
  assert.deepEqual(imagesPerRequest, [0, 1, 1, 2], "压缩前：图像块随其后的每次请求携带（不按次数退役）");
  assert.equal(agent.messages.filter(isToolWithImage).length, 2);
  // 保留预算 = 第二轮（user 起到末尾）的 token 量：第一轮（含图 a）进摘要区，第二轮（含图 b）留在尾部
  const secondUser = agent.messages.findIndex((m) => m.role === "user" && m.content === "第二轮");
  const tailTokens = agent.messages.slice(secondUser).reduce((s, m) => s + messageTokens(m), 0);
  const outcome = await agent.compact({ keepTokens: tailTokens + 16 });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  const withImages = agent.messages.filter(isToolWithImage);
  assert.equal(withImages.length, 1, "被摘要区间里的图随消息移除，保留尾部的图仍在");
  assert.equal((withImages[0] as { toolCallId: string }).toolCallId, "b");
  assert.equal(agent.messages[1]!.role, "user");
  assert.ok(String(agent.messages[1]!.content).startsWith("[历史摘要（系统压缩生成）]"));
  // 引用仍在：摘要输入带着 read_image 的结果文本（含图片路径），模型可按路径重读
  assert.ok(summarized.some((m) => m.role === "tool" && m.content.includes("[已读取图片 fig.png]")));
  assert.ok(!summarized.some((m) => (m as { toolCallId?: string }).toolCallId === "b"), "尾部不进摘要");
});

test("compact：压缩后 contextEstimate 下降且 system 保留，摘要消息入历史", async () => {
  const { agent } = makeCompactAgent([]);
  await agent.run("第一轮");
  await agent.run("第二轮，补充更多内容让历史变长一些");
  const before = agent.contextEstimate().total;
  const outcome = await agent.compact();
  assert.ok(outcome.ok);
  const roles = agent.messages.map((m) => m.role);
  assert.equal(roles[0], "system"); // system 保留
  assert.equal(roles[1], "user");
  assert.ok(agent.messages[1] && agent.messages[1].role === "user");
  assert.ok(String(agent.messages[1].content).startsWith("[历史摘要（系统压缩生成）]")); // 防空消息前缀
  const after = agent.contextEstimate().total;
  assert.ok(after < before, `压缩后应下降：${before} -> ${after}`);
  assert.ok(outcome.record.tokensAfter < outcome.record.tokensBefore);
  assert.ok(outcome.record.removedMessages > 0);
  // UI 收到压缩事件（stubUi 未实现 onCompaction，不抛错即可）
});

test("compact：压缩后 API 实测锚点失效，总量回退纯估算口径（other 归 0）", async () => {
  const { agent } = makeCompactAgent([
    () => ({ content: "回答", toolCalls: [], usage: { promptTokens: 999_999, completionTokens: 1 } }),
    () => ({ content: "摘要", toolCalls: [], usage: null }),
  ]);
  await agent.run("第一轮");
  const before = agent.contextEstimate();
  assert.ok(before.breakdown.other > 0); // 前置：锚定实测，校准差额归 other
  const outcome = await agent.compact();
  assert.ok(outcome.ok);
  const after = agent.contextEstimate();
  assert.equal(after.breakdown.other, 0); // history 整体替换 → 锚点失效 → 纯本地估算
  assert.equal(
    after.total,
    after.breakdown.systemPrompt + after.breakdown.skills + after.breakdown.systemTools + after.breakdown.mcp + after.breakdown.messages,
  );
});

test("compact：摘要调用失败 → 放弃压缩，history 原样保留（fail-safe）", async () => {
  const { agent } = makeCompactAgent([], {
    summarize: async () => {
      throw new Error("provider 炸了");
    },
  });
  await agent.run("第一轮");
  const snapshot = JSON.stringify(agent.messages);
  const outcome = await agent.compact();
  assert.equal(outcome.ok, false);
  assert.ok(JSON.stringify(agent.messages) === snapshot); // 未被破坏
});

test("compact：摘要为空 → 放弃压缩，history 原样保留", async () => {
  const { agent } = makeCompactAgent([], { summarize: async () => "   " });
  await agent.run("第一轮");
  const snapshot = JSON.stringify(agent.messages);
  const outcome = await agent.compact();
  assert.equal(outcome.ok, false);
  assert.ok(JSON.stringify(agent.messages) === snapshot);
});

test("compact：未注入压缩服务时明确不可用", async () => {
  const provider = new ScriptedProvider([]);
  const agent = new Agent({
    provider,
    registry: new ToolRegistry(),
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "default" },
    maxToolRounds: 5,
  });
  await agent.run("hi");
  const outcome = await agent.compact();
  assert.equal(outcome.ok, false);
  assert.ok(outcome.reason.includes("不可用"));
});

test("overflow：识别 provider 超限错误 → 自动压缩并重试该轮一次", async () => {
  const overflow = (): never => {
    throw new Error("Error 400: This model's maximum context length is 8 tokens, however messages is 100 tokens");
  };
  const { agent, provider } = makeCompactAgent([
    overflow, // 第一次：超限
    () => ({ content: "压缩后已恢复", toolCalls: [], usage: null }), // 重试成功
  ]);
  await agent.run("请回答");
  assert.equal(provider.calls.length, 2); // 原请求 + 重试一次
  const roles = agent.messages.map((m) => m.role);
  // 超限时刚提的问题也一并进摘要（摘要里包含"当前进行到哪"），保留尾部为空
  assert.deepEqual(roles, ["system", "user", "assistant"]);
  assert.ok(String(agent.messages[1]?.content).includes("历史摘要"));
});

test("overflow：压缩后重试仍超限 → 原错误上抛（只重试一次）", async () => {
  const overflow = (): never => {
    throw new Error("Error 400: This model's maximum context length is 8 tokens");
  };
  const { agent, provider } = makeCompactAgent([overflow, overflow]);
  await assert.rejects(() => agent.run("请回答"), /maximum context length/);
  assert.equal(provider.calls.length, 2); // 只多试了一次
});
