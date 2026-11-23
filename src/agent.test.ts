import test from "node:test";
import assert from "node:assert/strict";
import { Agent, runSubagent, type AgentDeps, type AgentSettings, type AgentUi } from "./agent.ts";
import type { ChatImage, ChatMessage, ChatParams, ChatResult, EffortSetting, LLMProvider } from "./llm/provider.ts";
import { estTokens, messageTokens } from "./tokens.ts";
import { THRESHOLDS, initConfig, isThinkingEffort, reasoningPassbackEnabled } from "./config.ts";
import { ToolRegistry, type Tool } from "./tools/registry.ts";
import { createWorkspace } from "./workspace.ts";

class FakeProvider implements LLMProvider {
  readonly name: string;
  readonly model?: string;
  calls: ChatParams[] = [];
  private script: ChatResult[];
  private i = 0;
  private passback?: (m: ChatMessage, effort: EffortSetting) => boolean;

  constructor(
    script: ChatResult[],
    opts: { name?: string; model?: string; passback?: (m: ChatMessage, effort: EffortSetting) => boolean } = {},
  ) {
    this.script = script;
    this.name = opts.name ?? "fake";
    this.model = opts.model;
    this.passback = opts.passback;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    const r = this.script[this.i++] ?? { content: "(测试脚本耗尽)", toolCalls: [], usage: null };
    if (r.reasoning && params.onReasoningDelta) params.onReasoningDelta(r.reasoning);
    if (r.content && params.onTextDelta) params.onTextDelta(r.content);
    return r;
  }

  /** 能力声明（§4.6）：路线行为来自能力而非 name——测试桩按需显式提供。 */
  thinkingPassback(m: ChatMessage, effort: EffortSetting): boolean {
    return this.passback ? this.passback(m, effort) : false;
  }
}

/** 模拟 anthropic 路线的能力声明（与 modules/providers/anthropic 实现同规则；规则本身由 provider.test.ts 专项锁定） */
function anthropicPassback(model?: string) {
  return (m: ChatMessage, effort: EffortSetting): boolean =>
    m.role === "assistant" &&
    isThinkingEffort(effort) &&
    m.toolCalls.length > 0 &&
    m.thinking !== undefined &&
    m.thinking.model !== undefined &&
    m.thinking.model === model &&
    m.thinking.signature !== undefined;
}

/** 模拟 openai 路线的能力声明（与 modules/providers/openai 实现同规则） */
function openaiPassback(m: ChatMessage, effort: EffortSetting): boolean {
  const on = reasoningPassbackEnabled() && isThinkingEffort(effort);
  return on && m.role === "assistant" && m.toolCalls.length > 0 && m.thinking !== undefined;
}

const echoTool: Tool = {
  name: "echo_tool",
  description: "回声测试工具",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  execute: async (args) => `echo:${String(args.value)}`,
};

function stubUi(sink: string[]): AgentUi {
  return {
    printReasoningDelta: (t) => sink.push(`[think]${t}`),
    printTextDelta: (t) => sink.push(t),
    printToolCall: (n, p) => sink.push(`[tool]${n}:${p}`),
    printToolResult: (s) => sink.push(`[result]${s}`),
    printInfo: (m) => sink.push(`[info]${m}`),
    printUsage: () => sink.push("[usage]"),
  };
}

function makeAgent(
  script: ChatResult[],
  maxToolRounds: number | "live" = 5,
  settingsOver: Partial<AgentSettings> = {},
  providerOver: { name?: string; model?: string; passback?: (m: ChatMessage, effort: EffortSetting) => boolean } = {},
) {
  const provider = new FakeProvider(script, providerOver);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const sink: string[] = [];
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi(sink),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high", ...settingsOver },
    // "live" = 不传该字段：Agent 每轮 live 读 THRESHOLDS.maxToolRounds（主会话真实形态，docs/24）
    ...(maxToolRounds === "live" ? {} : { maxToolRounds }),
  });
  return { agent, provider, sink };
}

test("单轮工具往返：user → assistant(tool_call) → tool → assistant(最终回答)", async () => {
  const { agent, provider, sink } = makeAgent([
    { content: "", toolCalls: [{ id: "c1", name: "echo_tool", arguments: '{"value":"hi"}' }], usage: null },
    { content: "完成", toolCalls: [], usage: null },
  ]);
  await agent.run("打个招呼");

  assert.deepEqual(
    agent.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant"],
  );
  const toolMsg = agent.messages[3];
  assert.ok(toolMsg && toolMsg.role === "tool");
  if (toolMsg.role === "tool") assert.equal(toolMsg.content, "echo:hi");

  // 第一次调用带工具定义，最终回答通过 onTextDelta 流出
  assert.ok(provider.calls[0]?.tools?.some((t) => t.name === "echo_tool"));
  assert.ok(sink.includes("完成"));
});

test("达到轮次上限后强制收尾（不带工具）", async () => {
  const toolRound = (id: string): ChatResult => ({
    content: "",
    toolCalls: [{ id, name: "echo_tool", arguments: "{}" }],
    usage: null,
  });
  const { agent, provider } = makeAgent([toolRound("c1"), toolRound("c2"), { content: "收尾", toolCalls: [], usage: null }], 2);
  await agent.run("继续");

  assert.equal(provider.calls.length, 3);
  assert.equal(provider.calls[2]?.tools, undefined); // 强制收尾不提供工具
  const lastUser = [...agent.messages].reverse().find((m) => m.role === "user");
  assert.ok(lastUser && lastUser.role === "user" && lastUser.content.includes("上限"));
  const lastMsg = agent.messages[agent.messages.length - 1];
  assert.ok(lastMsg && lastMsg.role === "assistant" && lastMsg.content === "收尾");
});

test("maxToolRounds 缺省 = live 读 DEFAULTS：initConfig 热应用对已装配 Agent 即时生效（docs/24 修复回归）", async () => {
  try {
    // 主会话真实形态（不传 maxToolRounds）：上限跟随 DEFAULTS——设 1 后一次工具往返即强制收尾
    initConfig({ disabledModules: [], thresholds: { maxToolRounds: 1 } });
    const toolRound = (id: string): ChatResult => ({
      content: "",
      toolCalls: [{ id, name: "echo_tool", arguments: "{}" }],
      usage: null,
    });
    const { agent, provider, sink } = makeAgent([toolRound("c1"), { content: "收尾", toolCalls: [], usage: null }], "live");
    await agent.run("继续");
    assert.equal(provider.calls.length, 2, "上限 1：一轮工具往返 + 一次收尾请求");
    assert.equal(agent.messages.filter((m) => m.role === "tool").length, 1);
    assert.ok(sink.some((s) => s.includes("上限（1）")), "达上限文案显示热应用后的值 1");
    // 热改回 2：同一 Agent 下一 run 立即跟随（证明是每轮 live 读，非构造期快照）
    initConfig({ disabledModules: [], thresholds: { maxToolRounds: 2 } });
    const { agent: a2, provider: p2 } = makeAgent([toolRound("d1"), toolRound("d2"), { content: "收尾", toolCalls: [], usage: null }], "live");
    await a2.run("继续");
    assert.equal(p2.calls.length, 3, "上限 2：两轮工具往返 + 一次收尾请求");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} }); // 恢复纯缺省，不泄漏给同文件其他测试
  }
});

test("clear 重置为仅系统提示", async () => {
  const { agent } = makeAgent([{ content: "好", toolCalls: [], usage: null }]);
  await agent.run("hi");
  agent.clear();
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.messages[0]?.role, "system");
});

test("模型一次返回多个 tool_calls 时逐个回填", async () => {
  const { agent } = makeAgent([
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "echo_tool", arguments: '{"value":"a"}' },
        { id: "c2", name: "echo_tool", arguments: '{"value":"b"}' },
      ],
      usage: null,
    },
    { content: "done", toolCalls: [], usage: null },
  ]);
  await agent.run("两次");
  const toolContents = agent.messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.content : ""));
  assert.deepEqual(toolContents, ["echo:a", "echo:b"]);
});

test("思考流通过 ui 展示并入历史存档（显示用；不回传 API 由 llm 层限定）", async () => {
  const { agent, sink } = makeAgent([{ content: "答", reasoning: "先想想", toolCalls: [], usage: null }]);
  await agent.run("问");
  assert.ok(sink.includes("[think]先想想"));
  // 最终轮思考也入历史（切换/刷新后前端可显示）；回放/回传范围限定在带工具调用的轮次
  const last = agent.messages[agent.messages.length - 1];
  assert.ok(last && last.role === "assistant" && last.thinking);
  if (last.role === "assistant") assert.equal(last.thinking.text, "先想想");
});

test("思考档位按对话下传 provider", async () => {
  const off = makeAgent([{ content: "ok", toolCalls: [], usage: null }], 5, { effort: "off" });
  await off.agent.run("hi");
  assert.equal(off.provider.calls[0]?.effort, "off");
  const low = makeAgent([{ content: "ok", toolCalls: [], usage: null }], 5, { effort: "low" });
  await low.agent.run("hi");
  assert.equal(low.provider.calls[0]?.effort, "low");
  const def = makeAgent([{ content: "ok", toolCalls: [], usage: null }], 5, { effort: "default" });
  await def.agent.run("hi");
  assert.equal(def.provider.calls[0]?.effort, "default"); // 不添加思考参数
});

test("setWorkspace 更新系统提示且保留历史", async () => {
  const { agent } = makeAgent([{ content: "好", toolCalls: [], usage: null }]);
  await agent.run("hi");
  const len = agent.messages.length;
  agent.setWorkspace(createWorkspace("D:\\other"));
  assert.equal(agent.messages.length, len); // 历史保留
  const sys = agent.messages[0];
  assert.ok(sys && sys.role === "system" && sys.content.includes("D:\\other"));
});

test("空回复不入历史（避免毒化后续请求）", async () => {
  const { agent, sink } = makeAgent([{ content: "", toolCalls: [], usage: null }]);
  await agent.run("问");
  // 历史只有 system + user，没有 assistant
  assert.deepEqual(
    agent.messages.map((m) => m.role),
    ["system", "user"],
  );
  assert.ok(sink.some((s) => s.includes("空回复")));
  // 下一轮仍可正常进行（历史以 user 结尾再接 user）
  const provider2 = makeAgent([{ content: "正常了", toolCalls: [], usage: null }]);
  await provider2.agent.run("再问");
  assert.ok(provider2.agent.messages.some((m) => m.role === "assistant"));
});

test("restore 恢复历史并按当前工作区重建系统提示", async () => {
  const { agent } = makeAgent([{ content: "好", toolCalls: [], usage: null }]);
  await agent.run("hi");
  const msgs = agent.messages.slice(1);
  agent.clear();
  agent.setWorkspace(createWorkspace("D:\\ws2"));
  agent.restore(msgs);
  assert.equal(agent.messages.length, 1 + msgs.length);
  assert.ok(agent.messages[0]?.role === "system");
  assert.ok(String(agent.messages[0]?.content).includes("D:\\ws2"));
  assert.ok(agent.messages.some((m) => m.role === "user"));
});

test("AGENTS.md 注入系统提示并可随工作区更新", () => {
  const provider = new FakeProvider([]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
    agentsMd: "必须以【WS】开头回复",
  });
  assert.ok(String(agent.messages[0]?.content).includes("必须以【WS】开头回复"));
  // 换到无 AGENTS.md 的工作区：指令消失
  agent.setWorkspace(createWorkspace("D:\\x"), null);
  assert.ok(!String(agent.messages[0]?.content).includes("必须以【WS】开头回复"));
  // 换到有新指令的工作区：新指令生效
  agent.setWorkspace(createWorkspace("D:\\x"), "新规则ABC");
  assert.ok(String(agent.messages[0]?.content).includes("新规则ABC"));
});

test("全局与工作区 AGENTS.md 同时注入系统提示", () => {
  const provider = new FakeProvider([]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
    globalAgentsMd: "全局规则GLOBAL",
    agentsMd: "工作区规则WS",
  });
  const sys = String(agent.messages[0]?.content);
  assert.ok(sys.includes("全局规则GLOBAL"));
  assert.ok(sys.includes("工作区规则WS"));
  // 全局段在工作区段之前（更具体的工作区指令靠后、优先级更高）
  assert.ok(sys.indexOf("全局规则GLOBAL") < sys.indexOf("工作区规则WS"));
  // 换工作区时全局指令保留、工作区指令更新
  agent.setWorkspace(createWorkspace("D:\\y"), "工作区规则BBB");
  const sys2 = String(agent.messages[0]?.content);
  assert.ok(sys2.includes("全局规则GLOBAL"));
  assert.ok(!sys2.includes("工作区规则WS"));
  assert.ok(sys2.includes("工作区规则BBB"));
  // setWorkspace 第 5 参更新全局指令（传 null 移除）
  agent.setWorkspace(createWorkspace("D:\\y"), undefined, undefined, undefined, null);
  assert.ok(!String(agent.messages[0]?.content).includes("全局规则GLOBAL"));
  agent.setWorkspace(createWorkspace("D:\\y"), undefined, undefined, undefined, "全局规则GLOBAL2");
  assert.ok(String(agent.messages[0]?.content).includes("全局规则GLOBAL2"));
});

test("技能清单注入系统提示并可随工作区更新", () => {
  const provider = new FakeProvider([]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const skills = [{ name: "commit-helper", description: "写提交信息", path: "p", source: "global" as const }];
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
    skills,
  });
  const sys = () => String(agent.messages[0]?.content);
  assert.ok(sys().includes("# 可用技能"));
  assert.ok(sys().includes("- commit-helper：写提交信息"));
  // 传 undefined 保持不变；传新数组则整体替换
  agent.setWorkspace(createWorkspace("D:\\x"), undefined, []);
  assert.ok(!sys().includes("commit-helper"));
  agent.setWorkspace(createWorkspace("D:\\x"), undefined, skills);
  assert.ok(sys().includes("commit-helper"));
});

test("contextEstimate 反映当前会话上下文规模", async () => {
  const { agent } = makeAgent([{ content: "好", toolCalls: [], usage: null }]);
  const before = agent.contextEstimate();
  assert.ok(before.total > 0); // 至少有系统提示词 + echo_tool schema
  assert.ok(before.breakdown.systemTools > 0);
  await agent.run("这是一个用于增长上下文的测试输入");
  const after = agent.contextEstimate();
  assert.ok(after.total > before.total); // user+assistant 消息加入后增长
  assert.ok(after.breakdown.messages >= before.breakdown.messages);
});

test("contextEstimate 总量锚定 API 实测 usage：实测 + 锚点后新增消息估算，差额归 other", async () => {
  const { agent } = makeAgent([
    { content: "好的", toolCalls: [], usage: { promptTokens: 99_999, completionTokens: 3 } },
  ]);
  await agent.run("你好");
  const finalMsg = agent.messages[agent.messages.length - 1]!;
  const { total, breakdown } = agent.contextEstimate();
  // 锚点 = 本次请求实测输入（system+user）；请求后仅追加了最终回答这条助手消息
  assert.equal(total, 99_999 + messageTokens(finalMsg, estTokens, false));
  assert.ok(breakdown.other > 0); // 实测 − 本地估算的校准差额归 other，六类合计 = total
});

test("工具循环逐轮锚定最新实测（总量跟随最近一次请求的 usage）", async () => {
  const { agent } = makeAgent([
    { content: "", toolCalls: [{ id: "c1", name: "echo_tool", arguments: '{"value":"x"}' }], usage: { promptTokens: 20_000, completionTokens: 1 } },
    { content: "完成", toolCalls: [], usage: { promptTokens: 30_000, completionTokens: 1 } },
  ]);
  await agent.run("跑一下");
  const finalMsg = agent.messages[agent.messages.length - 1]!;
  const { total } = agent.contextEstimate();
  // 第二轮请求（system+user+assistant(tool)+tool）实测 30000；其后仅追加最终回答
  assert.equal(total, 30_000 + messageTokens(finalMsg, estTokens, false));
});

test("工具执行期间：实测锚点 + 锚点后新增消息的本地估算（未实测部分）", async () => {
  let midTotal = -1;
  const probeTool: Tool = {
    name: "probe_ctx",
    description: "探测当前上下文估算",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      midTotal = agent.contextEstimate().total;
      return "ok";
    },
  };
  const provider = new FakeProvider([
    { content: "", toolCalls: [{ id: "c1", name: "probe_ctx", arguments: "{}" }], usage: { promptTokens: 20_000, completionTokens: 1 } },
    { content: "fin", toolCalls: [], usage: null },
  ]);
  const registry = new ToolRegistry();
  registry.register(probeTool);
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
  });
  await agent.run("go");
  // 首轮请求（system+user）实测 20000；工具执行时 history 追加了 assistant(toolCalls)（工具结果尚未回填）
  const assistantMsg = agent.messages[2]!;
  assert.equal(midTotal, 20_000 + messageTokens(assistantMsg, estTokens, false));
});

test("clear/restore/setProvider 后锚点失效，回退纯本地估算（other 归 0）", async () => {
  const mk = async () => {
    const { agent } = makeAgent([
      { content: "好的", toolCalls: [], usage: { promptTokens: 99_999, completionTokens: 3 } },
    ]);
    await agent.run("你好");
    assert.ok(agent.contextEstimate().breakdown.other > 0); // 前置：锚点已生效
    return agent;
  };
  {
    const a = await mk();
    a.clear();
    assert.equal(a.contextEstimate().breakdown.other, 0);
  }
  {
    const a = await mk();
    a.restore([{ role: "user", content: "恢复档没有实测数据" }]);
    assert.equal(a.contextEstimate().breakdown.other, 0);
  }
  {
    const a = await mk();
    a.setProvider(new FakeProvider([]));
    assert.equal(a.contextEstimate().breakdown.other, 0);
  }
});

test("setSkills 热更新系统提示里的技能清单（无需重建会话）", () => {
  const provider = new FakeProvider([]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
  });
  const sys = () => String(agent.messages[0]?.content);
  assert.ok(!sys().includes("commit-helper"));
  agent.setSkills([{ name: "commit-helper", description: "写提交信息", path: "p", source: "workspace" as const }]);
  assert.ok(sys().includes("- commit-helper：写提交信息"));
  agent.setSkills([]);
  assert.ok(!sys().includes("commit-helper"));
});

test("MCP instructions 注入系统提示并可随工作区更新", () => {
  const provider = new FakeProvider([]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
    mcpInstructions: "回答文献问题前必须先调用 search_literature",
  });
  const sys = () => String(agent.messages[0]?.content);
  assert.ok(sys().includes("# MCP 服务器使用说明"));
  assert.ok(sys().includes("必须先调用 search_literature"));
  // 传 null 清除；传新值替换
  agent.setWorkspace(createWorkspace("D:\\x"), undefined, undefined, null);
  assert.ok(!sys().includes("# MCP 服务器使用说明"));
  agent.setWorkspace(createWorkspace("D:\\x"), undefined, undefined, "新规则XYZ");
  assert.ok(sys().includes("新规则XYZ"));
});

test("用量事件带输入分类明细（breakdown）", async () => {
  const provider = new FakeProvider([
    { content: "好", toolCalls: [], usage: { promptTokens: 1000, completionTokens: 20 } },
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const usages: unknown[] = [];
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: { ...stubUi([]), printUsage: (u) => usages.push(u) },
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
  });
  await agent.run("hi");
  const u = usages[0] as {
    promptTokens: number;
    breakdown: Record<"systemPrompt" | "skills" | "systemTools" | "mcp" | "messages" | "other", number>;
  };
  assert.ok(u.breakdown);
  assert.ok(u.breakdown.systemPrompt > 0);
  assert.ok(u.breakdown.messages > 0); // user 消息
  assert.ok(u.breakdown.systemTools > 0); // echo_tool schema
  assert.equal(u.breakdown.skills, 0); // 未配置技能
  assert.ok(u.breakdown.other >= 0);
});

// ---- 思考内容入历史（DSH 条件规则：仅带工具调用的轮次存储）与回放对齐 ----

const toolRound = (reasoning?: string, signature?: string): ChatResult => ({
  content: "",
  ...(reasoning ? { reasoning } : {}),
  ...(signature ? { reasoningSignature: signature } : {}),
  toolCalls: [{ id: "c1", name: "echo_tool", arguments: '{"value":"x"}' }],
  usage: null,
});

test("思考块随助手消息存档（含签名与模型），最终回答轮也存（供前端显示）", async () => {
  const { agent } = makeAgent(
    [toolRound("工具前的思考", "sig1"), { content: "答", reasoning: "最终思考", toolCalls: [], usage: null }],
    5,
    {},
    { model: "deepseek-x" },
  );
  await agent.run("问");
  const toolTurn = agent.messages[2];
  assert.ok(toolTurn && toolTurn.role === "assistant" && toolTurn.thinking);
  if (toolTurn.role === "assistant") {
    assert.deepEqual(toolTurn.thinking, { text: "工具前的思考", signature: "sig1", model: "deepseek-x" });
  }
  const finalTurn = agent.messages[4];
  assert.ok(finalTurn && finalTurn.role === "assistant");
  if (finalTurn.role === "assistant") {
    assert.deepEqual(finalTurn.thinking, { text: "最终思考", model: "deepseek-x" }); // 存档供显示，不回传
  }
});

test("无签名的思考照存（缺省签名字段），签名字段绝不伪造", async () => {
  const { agent } = makeAgent([toolRound("想想"), { content: "答", toolCalls: [], usage: null }], 5, {}, { model: "m1" });
  await agent.run("问");
  const t = agent.messages[2];
  assert.ok(t && t.role === "assistant");
  if (t.role === "assistant") assert.deepEqual(t.thinking, { text: "想想", model: "m1" });
});

test("签名缺失降级：同一思考块在多轮工具循环中重发只告警一次", async () => {
  let round = 0;
  const sink: string[] = [];
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const agent = new Agent({
    // 模拟 anthropic provider 行为：历史里存在签名缺失的对齐思考块时触发 onReplayDegrade
    provider: {
      name: "anthropic",
      model: "m1",
      chat: async (params) => {
        const src = params.messages.find((m) => m.role === "assistant" && m.thinking);
        if (src && src.role === "assistant" && src.thinking) {
          params.onReplayDegrade?.("思考签名缺失，已从历史省略该思考块", src.thinking);
        }
        round++;
        return round < 3
          ? toolRound("想想")
          : { content: "done", toolCalls: [], usage: null };
      },
    },
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi(sink),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
  });
  await agent.run("问");
  assert.equal(round, 3);
  assert.equal(sink.filter((s) => s.includes("思考签名缺失")).length, 1); // 第 2、3 轮都触发降级，只告警一次
});

test("token 计数与回传条件对齐：anthropic 计入模型对齐的思考，换模型后不计", async () => {
  const THINK = "这是一段用于验证回传计数的思考文本";
  const { agent } = makeAgent([toolRound(THINK, "s"), { content: "答", toolCalls: [], usage: null }], 5, {}, {
    name: "anthropic",
    model: "m1",
    passback: anthropicPassback("m1"),
  });
  await agent.run("问");
  const aligned = agent.contextEstimate().breakdown.messages;
  // 同一份历史，换不同模型的 provider：thinking 不回放也不计数（差值恰为思考文本 token）
  agent.setProvider(new FakeProvider([], { name: "anthropic", model: "m2", passback: anthropicPassback("m2") }));
  const foreign = agent.contextEstimate().breakdown.messages;
  assert.equal(foreign, aligned - estTokens(THINK));
  // 非回传型 provider（测试桩）：不回传不计数，与不对齐时一致
  agent.setProvider(new FakeProvider([]));
  assert.equal(agent.contextEstimate().breakdown.messages, foreign);
});

test("最终轮思考仅供显示：不回放也不计数（anthropic 对齐模型）", async () => {
  const TOOL_THINK = "工具轮的思考文本";
  const FINAL_THINK = "最终回答轮的思考文本，应当存档但不计入回传";
  const { agent } = makeAgent(
    [toolRound(TOOL_THINK, "s"), { content: "答", reasoning: FINAL_THINK, toolCalls: [], usage: null }],
    5,
    {},
    { name: "anthropic", model: "m1", passback: anthropicPassback("m1") },
  );
  await agent.run("问");
  // 最终轮思考已存档（切换后前端可显示）
  const last = agent.messages[agent.messages.length - 1];
  assert.ok(last && last.role === "assistant" && last.thinking);
  if (last.role === "assistant") assert.equal(last.thinking.text, FINAL_THINK);
  // 计数只含工具轮思考：对齐口径 = 不计口径 + estTokens(TOOL_THINK)
  // （若最终轮也被计数，差值会多出 estTokens(FINAL_THINK)）
  const aligned = agent.contextEstimate().breakdown.messages;
  agent.setProvider(new FakeProvider([]));
  const plain = agent.contextEstimate().breakdown.messages;
  assert.equal(aligned, plain + estTokens(TOOL_THINK));
});

test("token 计数与回传条件对齐：openai 路线受 REASONING_PASSBACK 开关控制", async () => {
  const prev = process.env.REASONING_PASSBACK;
  const THINK = "openai 路线回传计数的验证文本";
  try {
    const { agent } = makeAgent([toolRound(THINK, undefined), { content: "答", toolCalls: [], usage: null }], 5, {}, {
      name: "openai",
      model: "deepseek-x",
      passback: openaiPassback,
    });
    await agent.run("问");
    // 默认关：不计
    delete process.env.REASONING_PASSBACK;
    const off = agent.contextEstimate().breakdown.messages;
    // 开关打开（思考档位 high）：计入思考文本
    process.env.REASONING_PASSBACK = "1";
    const on = agent.contextEstimate().breakdown.messages;
    assert.equal(on, off + estTokens(THINK));
    // 非思考档位（default）：开关开着也不计
    // （档位属于会话设置，运行中不切换；这里用新 agent 验证档位门）
    const d = makeAgent([toolRound(THINK), { content: "答", toolCalls: [], usage: null }], 5, { effort: "default" }, {
      name: "openai",
      model: "deepseek-x",
      passback: openaiPassback,
    });
    await d.agent.run("问");
    assert.equal(d.agent.contextEstimate().breakdown.messages, off);
  } finally {
    if (prev === undefined) delete process.env.REASONING_PASSBACK;
    else process.env.REASONING_PASSBACK = prev;
  }
});

// ---------- run() 返回值（docs/5 SA0：worker 取最终报告用） ----------

test("run() 返回最终回答与轮数：单轮直答 rounds=1；多轮工具循环计数含工具轮", async () => {
  const direct = makeAgent([{ content: "  答案  ", toolCalls: [], usage: null }]);
  const r1 = await direct.agent.run("问");
  assert.deepEqual(r1, { finalText: "答案", rounds: 1 });

  const looped = makeAgent([
    { content: "", toolCalls: [{ id: "c1", name: "echo_tool", arguments: "{}" }], usage: null },
    { content: "", toolCalls: [{ id: "c2", name: "echo_tool", arguments: "{}" }], usage: null },
    { content: "完成", toolCalls: [], usage: null },
  ]);
  const r2 = await looped.agent.run("做");
  assert.deepEqual(r2, { finalText: "完成", rounds: 3 }); // 两轮工具 + 一轮最终回答
});

test("run() 无最终回答时返回 null：空回复与用户中断路径", async () => {
  const empty = makeAgent([{ content: "", toolCalls: [], usage: null }]);
  assert.equal(await empty.agent.run("问"), null); // 空回复不入历史

  const ctl = new AbortController();
  const aborted = makeAgent([
    { content: "", toolCalls: [{ id: "c1", name: "echo_tool", arguments: "{}" }], usage: null },
  ]);
  const p = aborted.agent.run("问", ctl.signal);
  ctl.abort();
  const r = await p; // 工具执行后 signal 已中止 → 中断路径
  assert.equal(r, null);
});

// ---------- 子代理（P8 预留 seam 的运行机制） ----------

test("runSubagent：独立历史（system+task 两条消息）、effort 缺省 off、无工具、成功返回 trim 文本", async () => {
  const p = new FakeProvider([{ content: "  子结果文本  ", toolCalls: [], usage: null }]);
  const r = await runSubagent({ provider: p, systemPrompt: "SYS-PROMPT", req: { task: "做点事" } });
  assert.ok(r.ok);
  assert.equal(r.error, undefined);
  assert.equal(r.text, "子结果文本");
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].messages, [
    { role: "system", content: "SYS-PROMPT" },
    { role: "user", content: "做点事" },
  ]);
  assert.equal(p.calls[0].effort, "off");
  assert.equal(p.calls[0].tools, undefined);
});

test("runSubagent：effort 覆盖生效", async () => {
  const p = new FakeProvider([{ content: "x", toolCalls: [], usage: null }]);
  await runSubagent({ provider: p, systemPrompt: "s", req: { task: "t", effort: "high" } });
  assert.equal(p.calls[0].effort, "high");
});

test("runSubagent：空回复与提供方异常都归 ok:false（不抛错）", async () => {
  const empty = new FakeProvider([{ content: "   ", toolCalls: [], usage: null }]);
  const r1 = await runSubagent({ provider: empty, systemPrompt: "s", req: { task: "t" } });
  assert.equal(r1.ok, false);
  assert.equal(r1.text, "");
  assert.ok(r1.error);
  const boom: LLMProvider = {
    name: "boom",
    chat: async () => {
      throw new Error("网络炸了");
    },
  };
  const r2 = await runSubagent({ provider: boom, systemPrompt: "s", req: { task: "t" } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "网络炸了");
});

test("runSubagent：timeoutMs 经 signal 传给 provider，超时归 ok:false", async () => {
  const slow: LLMProvider = {
    name: "slow",
    chat: (p) =>
      new Promise<ChatResult>((_, reject) => {
        p.signal?.addEventListener("abort", () => reject(new Error("调用超时")));
      }),
  };
  const r = await runSubagent({ provider: slow, systemPrompt: "s", req: { task: "t", timeoutMs: 50 } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "调用超时");
});

// ---------- W2-L2（docs/8 §1.3）：运行中即时应答 interject ----------

/** 可控闸门工具：execute 挂起直到 release（模拟 agent_tasks 阻塞在工具等待窗口）。 */
function gatedTool(name: string): { tool: Tool; release: (result: string) => void } {
  let release!: (v: string) => void;
  const gate = new Promise<string>((res) => (release = res));
  const tool: Tool = {
    name,
    description: "闸门测试工具（W2-L2）",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => gate,
  };
  return { tool, release };
}

/** W2-L2 装配：脚本化 provider + 闸门工具 + 捕获 usage/合并钩子的 UI。 */
function makeInterimAgent(script: ChatResult[], tools: Tool[]) {
  const provider = new FakeProvider(script);
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const sink: string[] = [];
  const usages: Array<{ promptTokens: number; completionTokens: number; breakdown?: unknown }> = [];
  let merged = 0;
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: {
      ...stubUi(sink),
      printUsage: (u) => usages.push({ promptTokens: u.promptTokens, completionTokens: u.completionTokens, breakdown: u.breakdown }),
      onInterimMerged: () => merged++,
    },
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
  });
  return { agent, provider, sink, usages, mergedCount: () => merged };
}

/** 等到 provider 收到第 n 次 chat（主轮/interim 调用先后到达的时序对齐）。 */
async function waitCalls(provider: FakeProvider, n: number) {
  for (let i = 0; i < 100 && provider.calls.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(provider.calls.length, n, "脚本时序不对：期望指定次数的 chat");
}

test("W2-L2 interject：请求形状（全历史+状态占位+新 user、不带 tools）+ 流式回应 + history 不动 + usage 守恒 + 轮末合并", async () => {
  const { tool, release } = gatedTool("gate_tool");
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "gate_tool", arguments: "{}" }], usage: null },
    { content: "任务还在跑，请稍候", toolCalls: [], usage: { promptTokens: 100, completionTokens: 7 } },
    { content: "全部完成", toolCalls: [], usage: null },
  ];
  const { agent, provider, sink, usages, mergedCount } = makeInterimAgent(script, [tool]);
  const runP = agent.run("派个任务");
  await waitCalls(provider, 1);

  const histLen = agent.messages.length;
  const r = await agent.interject("现在进度如何");
  assert.equal(r, "ok");
  await waitCalls(provider, 2);

  // 回应流式（onTextDelta 直通）+ history 未动（只读快照 + interimQueue 缓冲）
  assert.ok(sink.includes("任务还在跑，请稍候"), "interim 回应流式给 UI");
  assert.equal(agent.messages.length, histLen, "interject 不写 history");
  assert.equal(mergedCount(), 0, "未到合并点");

  // 请求形状：[system, user, assistant(tool_calls), tool(状态占位), user(新消息)]，不带 tools
  const req = provider.calls[1]!;
  assert.equal(req.tools, undefined, "interim 请求不带 tools（收尾轮先例）");
  assert.deepEqual(
    req.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "user"],
  );
  const placeholder = req.messages[3];
  assert.ok(placeholder && placeholder.role === "tool" && placeholder.content.startsWith("[子代理已派发、正在后台执行"), "悬空调用的状态占位");
  if (placeholder.role === "tool") assert.equal(placeholder.toolCallId, "c1");
  assert.equal(req.messages[4]?.content, "现在进度如何");

  // usage 走 printUsage 且带 withOther 分类（六类守恒）
  assert.ok(usages.some((u) => u.promptTokens === 100 && u.breakdown), "interim usage 经 printUsage 计入");

  // 放行 → 工具回填 → 合并点：[tool(结果), user(interim), assistant(interim 回应)] → 下一轮 → assistant(最终)
  release("gate ok");
  const out = await runP;
  assert.equal(out?.finalText, "全部完成");
  assert.equal(mergedCount(), 1, "合并点触发 onInterimMerged");
  const roles = agent.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-5), ["assistant", "tool", "user", "assistant", "assistant"], "interim 对合并进历史且不隔断 tool 消息");
  const mergedUser = agent.messages[agent.messages.length - 3];
  assert.ok(mergedUser && mergedUser.role === "user" && mergedUser.content === "现在进度如何");
  const mergedAsst = agent.messages[agent.messages.length - 2];
  assert.ok(mergedAsst && mergedAsst.role === "assistant" && mergedAsst.content === "任务还在跑，请稍候");
  // 下一轮主请求自然携带合并后的历史（协调者记得运行中对话）
  const nextReq = provider.calls[2]!;
  assert.ok(nextReq.messages.some((m) => m.role === "user" && m.content === "现在进度如何"), "下一轮请求含 interim 对");
});

// ---------- interim 控制工具（协调者运行中插话：打断/归档即时真实执行） ----------

test("interim 控制工具：请求携带控制工具（docs/18 起两件），模型调用即真实执行（运行中打断不再装模作样）", async () => {
  const { tool, release } = gatedTool("gate_tool");
  let stoppedViaTool = false;
  const stopTool: Tool = {
    name: "stop_subagent",
    description: "打断一个运行中子代理的当前任务（测试桩）",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    execute: async () => {
      stoppedViaTool = true;
      return "已打断子代理：tester#1。任务立即中止（没有恢复，继续工作需发新任务书）。";
    },
  };
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "gate_tool", arguments: "{}" }], usage: null },
    { content: "", toolCalls: [{ id: "i1", name: "stop_subagent", arguments: '{"name":"tester"}' }], usage: null },
    { content: "已按要求打断 tester。", toolCalls: [], usage: null },
    { content: "全部完成", toolCalls: [], usage: null },
  ];
  const { agent, provider, sink } = makeInterimAgent(script, [tool, stopTool]);
  const runP = agent.run("派个任务");
  await waitCalls(provider, 1);

  const r = await agent.interject("打断 tester");
  assert.equal(r, "ok");
  await waitCalls(provider, 3); // interim 两段 chat：带控制工具 → 真实执行 → 不带工具的收尾应答
  assert.equal(stoppedViaTool, true, "stop_subagent 被真实执行（不是文字冒充）");

  // 第一段 interim 请求只带控制工具（gate_tool 等其余工具不进即时应答）
  const req = provider.calls[1]!;
  assert.deepEqual(req.tools?.map((t) => t.name), ["stop_subagent"]);
  // 收尾请求：不带工具，尾部 = [user, assistant(控制调用), tool(执行结果)]
  const req2 = provider.calls[2]!;
  assert.equal(req2.tools, undefined);
  assert.deepEqual(req2.messages.slice(-3).map((m) => m.role), ["user", "assistant", "tool"]);
  assert.ok(sink.includes("已按要求打断 tester。"), "收尾应答流式给 UI");

  release("gate ok");
  const out = await runP;
  assert.equal(out?.finalText, "全部完成");
  // 合并形状：[..., tool(gate 结果), user, assistant(stop 调用), tool(stop 结果), assistant(回应), assistant(最终)]
  const roles = agent.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-5), ["user", "assistant", "tool", "assistant", "assistant"]);
  const stopMsg = agent.messages[agent.messages.length - 4];
  assert.ok(stopMsg && stopMsg.role === "assistant" && stopMsg.toolCalls[0]?.name === "stop_subagent");
  const toolMsg = agent.messages[agent.messages.length - 3];
  assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.includes("已打断"), "控制工具的真实结果入历史");
});

test("interim 控制白名单：幻觉出的派发类工具调用不执行（错误文本回填，绝不阻塞即时应答）", async () => {
  const { tool, release } = gatedTool("gate_tool");
  let agentTaskEntered = false;
  const agentTaskStub: Tool = {
    name: "agent_task",
    description: "派出一个子代理（测试桩——绝不应在 interim 中被执行）",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      agentTaskEntered = true;
      return "不该执行";
    },
  };
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "gate_tool", arguments: "{}" }], usage: null },
    { content: "", toolCalls: [{ id: "i1", name: "agent_task", arguments: '{"description":"x","task":"y"}' }], usage: null },
    { content: "当前无法派发新任务，等本轮结束后再说。", toolCalls: [], usage: null },
    { content: "全部完成", toolCalls: [], usage: null },
  ];
  const { agent, provider, sink } = makeInterimAgent(script, [tool, agentTaskStub]);
  const runP = agent.run("派个任务");
  await waitCalls(provider, 1);
  const r = await agent.interject("再派个任务");
  assert.equal(r, "ok");
  await waitCalls(provider, 3);
  assert.equal(agentTaskEntered, false, "白名单外的工具绝不执行（防 interim 内嵌套阻塞派发）");
  assert.ok(sink.some((t) => t.includes("当前无法派发新任务")), "收尾应答正常给出");
  // 白名单外的调用以错误文本作为工具结果回填（第二段请求可见，模型据实答复）
  const req2 = provider.calls[2]!;
  const toolMsg = req2.messages[req2.messages.length - 1];
  assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.includes("错误"), "错误文本回填工具结果");
  release("gate ok");
  await runP;
});

test("W2-L2：一轮多 toolCalls 部分回填时占位只补悬空调用；合并位于全部 tool 消息之后", async () => {
  const { tool: t1, release: r1 } = gatedTool("g1");
  const { tool: t2, release: r2 } = gatedTool("g2");
  const script: ChatResult[] = [
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "g1", arguments: "{}" },
        { id: "c2", name: "g2", arguments: "{}" },
      ],
      usage: null,
    },
    { content: "两个任务都在跑", toolCalls: [], usage: null },
    { content: "收工", toolCalls: [], usage: null },
  ];
  const { agent, provider } = makeInterimAgent(script, [t1, t2]);
  const runP = agent.run("并行任务");
  await waitCalls(provider, 1);
  // c1 先回填（部分回填窗口），interim 请求只为悬空的 c2 合成占位
  r1("one");
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(await agent.interject("进度?"), "ok");
  await waitCalls(provider, 2);
  const req = provider.calls[1]!;
  const toolsInReq = req.messages.filter((m) => m.role === "tool");
  assert.equal(toolsInReq.length, 2, "已回填的 c1 结果 + 悬空 c2 的状态占位");
  assert.ok(toolsInReq.some((m) => m.role === "tool" && m.content === "one"), "真实结果照带");
  const placeholders = toolsInReq.filter((m) => m.role === "tool" && m.content.startsWith("[子代理已派发、正在后台执行"));
  assert.equal(placeholders.length, 1, "只补悬空的 c2");
  if (placeholders[0]?.role === "tool") assert.equal(placeholders[0].toolCallId, "c2");

  r2("two");
  await runP;
  const roles = agent.messages.map((m) => m.role);
  assert.deepEqual(
    roles.slice(-5),
    ["tool", "tool", "user", "assistant", "assistant"],
    "user 在全部（2 条）tool 消息之后，不隔断",
  );
});

test("W2-L2 窗口守卫：非工具窗口 not-pending（LLM 请求期/轮外）；run 结束后不泄漏窗口", async () => {
  const { tool, release } = gatedTool("g1");
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "g1", arguments: "{}" }], usage: null },
    { content: "好的", toolCalls: [], usage: null },
  ];
  const { agent, provider } = makeInterimAgent(script, [tool]);
  assert.equal(await agent.interject("太早"), "not-pending", "run 之前不在窗口");
  const runP = agent.run("任务");
  await waitCalls(provider, 1);
  release("done");
  await runP;
  assert.equal(await agent.interject("太晚"), "not-pending", "run 结束后窗口已关（泄漏哨兵：正常完成路径）");
});

test("W2-L2 中止场景：缓冲在 abort return 之前合并（不丢）；结束后窗口复位", async () => {
  const { tool, release } = gatedTool("g1");
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "g1", arguments: "{}" }], usage: null },
    { content: "中止前的回应", toolCalls: [], usage: null },
  ];
  const { agent, provider, mergedCount } = makeInterimAgent(script, [tool]);
  const ctl = new AbortController();
  const runP = agent.run("任务", ctl.signal);
  await waitCalls(provider, 1);
  assert.equal(await agent.interject("进度?"), "ok");
  await waitCalls(provider, 2);
  ctl.abort(); // 工具挂着时中止：工具跑完 → 合并点 → aborted return null
  release("done");
  assert.equal(await runP, null);
  assert.equal(mergedCount(), 1, "中止路径同样经过合并点（缓冲不丢）");
  assert.ok(
    agent.messages.some((m) => m.role === "user" && m.content === "进度?") &&
      agent.messages.some((m) => m.role === "assistant" && m.content === "中止前的回应"),
    "interim 对已进历史",
  );
  assert.equal(await agent.interject("再插"), "not-pending", "中止路径窗口复位（泄漏哨兵）");
});

test("W2-L2：interim 调用失败/空回复归 failed（不进缓冲）；主流程不受影响", async () => {
  const { tool, release } = gatedTool("g1");
  // 第二次 chat（interim 请求）返回空回复
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "g1", arguments: "{}" }], usage: null },
    { content: "  ", toolCalls: [], usage: null },
    { content: "完成", toolCalls: [], usage: null },
  ];
  const { agent, provider, mergedCount } = makeInterimAgent(script, [tool]);
  const runP = agent.run("任务");
  await waitCalls(provider, 1);
  assert.equal(await agent.interject("进度?"), "failed", "空回复不入缓冲");
  release("done");
  const out = await runP;
  assert.equal(out?.finalText, "完成");
  assert.equal(mergedCount(), 0, "无缓冲可合并");
  assert.ok(!agent.messages.some((m) => m.role === "user" && m.content === "进度?"), "失败消息不进历史（由调用方落 inbox）");
});

test("W2-L2：provider 异常上抛路径窗口复位（泄漏哨兵：抛错路径）", async () => {
  const { tool } = gatedTool("g1");
  const boom: LLMProvider = {
    name: "boom",
    chat: () => {
      throw new Error("网络炸了");
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const agent = new Agent({
    provider: boom,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 3,
  });
  await assert.rejects(agent.run("任务"), /网络炸了/);
  assert.equal(await agent.interject("插话"), "not-pending", "抛错路径窗口复位");
});

test("W2-L2：interim 在飞时返回 busy（一次只跑一个）；后续 interim 请求携带先前对（保持连贯）", async () => {
  const { tool, release } = gatedTool("g1");
  const calls: ChatParams[] = [];
  let releaseInterim!: () => void;
  const interimGate = new Promise<void>((res) => (releaseInterim = res));
  let i = 0;
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "g1", arguments: "{}" }], usage: null },
    { content: "第一个回应", toolCalls: [], usage: null },
    { content: "第二个回应", toolCalls: [], usage: null },
    { content: "完成", toolCalls: [], usage: null },
  ];
  const provider: LLMProvider = {
    name: "serial",
    async chat(p) {
      calls.push(p);
      const idx = i++;
      if (idx === 1) await interimGate; // 第一次 interim 请求挂起（在飞窗口）
      return script[idx] ?? { content: "done", toolCalls: [], usage: null };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi([]),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 5,
  });
  const runP = agent.run("任务");
  for (let k = 0; k < 100 && calls.length < 1; k++) await new Promise((r) => setTimeout(r, 5)); // 主轮 chat + 工具挂起
  await new Promise((r) => setTimeout(r, 5)); // chat 已同步调用：等 run 循环的微任务推进到工具窗口（toolPending 置位）
  const first = agent.interject("第一问");
  await new Promise((r) => setTimeout(r, 20)); // 第一次 interim 进入在飞
  assert.equal(await agent.interject("第二问"), "busy", "在飞时返回 busy（串行守卫）");
  releaseInterim();
  assert.equal(await first, "ok");
  // 第二次 interject：请求应含先前的 [user,assistant] 对（保持连贯）
  const second = agent.interject("第二问");
  await new Promise((r) => setTimeout(r, 20));
  release("done"); // 放行主工具
  assert.equal(await second, "ok");
  const req2 = calls.filter((c) => c.messages.some((m) => m.role === "user" && m.content === "第二问")).pop()!;
  const roles = req2.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-4), ["tool", "user", "assistant", "user"], "先前 interim 对在新请求内连贯携带");
  const out = await runP;
  assert.equal(out?.finalText, "完成");
});

// ---------- docs/15：agent_tasks 退役——协调者同轮多工具调用并行执行（并行派发新通道） ----------

test("docs/15：协调者同轮多个工具调用并行执行（w2 无需等 w1 完成）；普通会话保持顺序执行", async () => {
  const mkTools = () => {
    let w1Release!: (v: string) => void;
    const w1Gate = new Promise<string>((res) => (w1Release = res));
    let w2Entered = 0;
    const w1: Tool = { name: "w1", description: "挂起工具", parameters: { type: "object", properties: {}, required: [] }, execute: () => w1Gate };
    const w2: Tool = { name: "w2", description: "记录工具", parameters: { type: "object", properties: {}, required: [] }, execute: async () => { w2Entered++; return "r2"; } };
    return { w1, w2, w1Release, entered: () => w2Entered };
  };
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "c1", name: "w1", arguments: "{}" }, { id: "c2", name: "w2", arguments: "{}" }], usage: null },
    { content: "完成", toolCalls: [], usage: null },
  ];
  const mkAgent = (tools: Tool[], sessionKind?: "coordinator") => {
    const provider = new FakeProvider(script);
    const registry = new ToolRegistry();
    for (const t of tools) registry.register(t);
    const sink: string[] = [];
    const agent = new Agent({
      provider, registry, workspace: createWorkspace(process.cwd()), ui: stubUi(sink),
      requestApproval: async () => "allowed-once",
      settings: { alwaysConfirm: false, effort: "high" }, maxToolRounds: 5,
      ...(sessionKind ? { sessionKind } : {}),
    });
    return { agent, provider };
  };
  // 协调者：w1 挂起期间 w2 已执行（同轮并行——agent_tasks 退役后的并行派发通道）
  {
    const t = mkTools();
    const { agent, provider } = mkAgent([t.w1, t.w2], "coordinator");
    const p = agent.run("并行派两个");
    for (let i = 0; i < 100 && t.entered() < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.entered(), 1, "协调者同轮第二个工具不等第一个完成（并行执行）");
    t.w1Release("r1");
    const r = await p;
    assert.equal(r?.finalText, "完成");
    assert.deepEqual(
      agent.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId),
      ["c1", "c2"],
      "并行回填按调用序（配对靠 callId）",
    );
    assert.equal(provider.calls.length, 2, "两轮 chat（工具轮 + 收尾轮）");
  }
  // 普通会话：w1 挂起期间 w2 不执行（顺序——文件工具有先后语义）
  {
    const t = mkTools();
    const { agent } = mkAgent([t.w1, t.w2]);
    const p = agent.run("顺序执行两个");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.entered(), 0, "普通会话同轮工具顺序执行");
    t.w1Release("r1");
    const r = await p;
    assert.equal(r?.finalText, "完成");
    assert.equal(t.entered(), 1, "w1 完成后 w2 才执行");
  }
});

// ---------- docs/42：图片常驻与图片预算（修订：「看过即退役」已撤销）/ 纯文本模型省略图像 / 上下文预警线提示 / readOnly ----------

const IMG = { mime: "image/png" as const, data: "aGVsbG8=" };

/** 带图工具：executeImage 返回 images（read_image 的最小替身，缺省一张小图）；ctxSink 捕获工具上下文。 */
function imageTool(ctxSink: Array<Record<string, unknown>>, images: ChatImage[] = [IMG]): Tool {
  return {
    name: "read_image",
    description: "读图测试工具",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "[已读取图片] 回退文本",
    executeImage: async (_args, ctx) => {
      const { requestApproval, ...rest } = ctx as unknown as { requestApproval: unknown } & Record<string, unknown>;
      ctxSink.push(rest);
      return { text: "[已读取图片 fig.png]", images };
    },
  };
}

function makeImageAgent(script: ChatResult[], extra: Partial<AgentDeps> = {}, images: ChatImage[] = [IMG]) {
  const provider = new FakeProvider(script);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const ctxSink: Array<Record<string, unknown>> = [];
  registry.register(imageTool(ctxSink, images));
  const sink: string[] = [];
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(process.cwd()),
    ui: stubUi(sink),
    requestApproval: async () => "allowed-once",
    settings: { alwaysConfirm: false, effort: "high" },
    maxToolRounds: 8,
    ...extra,
  });
  return { agent, provider, sink, ctxSink };
}

const tcall = (id: string, name: string, args = "{}"): ChatResult => ({ content: "", toolCalls: [{ id, name, arguments: args }], usage: null });

/** 一段历史里仍保留的图像块总数（tool + user 消息）。 */
const imagesIn = (ms: readonly ChatMessage[]): number =>
  ms.reduce((s, m) => s + ((m.role === "tool" || m.role === "user") ? (m.images?.length ?? 0) : 0), 0);

/** 第 i 次请求携带的图像块总数。 */
const imgCountOf = (calls: ChatParams[], i: number): number => imagesIn(calls[i]!.messages);

type ToolMsg = Extract<ChatMessage, { role: "tool" }>;
const isToolWithId = (id: string) => (m: ChatMessage): m is ToolMsg => m.role === "tool" && m.toolCallId === id;

test("docs/42 修订 图像常驻：tool 消息的图像块随其后的每次请求携带（不再按次数退役），历史对象与文本不动；用户贴图同样常驻", async () => {
  const { agent, provider } = makeImageAgent([
    tcall("a", "read_image"),
    tcall("b", "echo_tool", '{"value":"x"}'),
    tcall("c", "echo_tool", '{"value":"y"}'),
    { content: "结论：图没问题", toolCalls: [], usage: null },
  ], { vision: true });
  await agent.run("看图");
  assert.equal(provider.calls.length, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => imgCountOf(provider.calls, i)), [0, 1, 1, 1], "读图之后的每次请求都携带图像块（模型可随时回看）");
  const kept = agent.messages.find((m) => m.role === "tool" && m.content.includes("已读取图片"));
  assert.ok(kept && kept.role === "tool" && kept.images?.length === 1, "历史里的 tool 消息仍带 images");
  assert.equal(kept!.content, "[已读取图片 fig.png]", "未超预算：不移出、不改文本");
  assert.ok(provider.calls.every((c) => c.omitImages === undefined), "视觉会话的请求不带 omitImages 字段（字节不变）");
  // 用户贴图是用户内容：同样常驻
  const { agent: a2, provider: p2 } = makeImageAgent([{ content: "ok", toolCalls: [], usage: null }], { vision: true });
  await a2.run("看这张", undefined, [IMG]);
  assert.ok(p2.calls[0]!.messages.some((m) => m.role === "user" && m.images?.length === 1));
  assert.ok(a2.messages.some((m) => m.role === "user" && m.images?.length === 1), "用户图仍在历史");
});

test("docs/42 修订 图片预算·张数：超过 imageContextMaxCount 后把最早的已看过的工具读图成批移出到 75%（新建对象、追加移出说明、UI 提示）；历史对象不复用", async () => {
  initConfig({ disabledModules: [], thresholds: { imageContextMaxCount: 4, imageContextMaxBytes: 1024 * 1024 } });
  try {
    // 每轮读一张、共 6 张：maxCount=4 → 第 5 张入场后（请求前）移出最早的 2 张到 ≤3（4×0.75），
    // 之后第 6 张入场不再触发（4 ≤ 4）——成批移出，缓存只失效一次
    const script: ChatResult[] = [];
    for (let k = 0; k < 6; k++) script.push(tcall(`c${k}`, "read_image"));
    script.push({ content: "完成", toolCalls: [], usage: null });
    const { agent, provider, sink } = makeImageAgent(script, { vision: true, maxToolRounds: 20 });
    await agent.run("逐张看图");
    assert.equal(provider.calls.length, 7);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => imgCountOf(provider.calls, i)), [0, 1, 2, 3, 4, 3, 4]);
    const toolMsgs = agent.messages.filter((m) => m.role === "tool");
    const evicted = toolMsgs.filter((m) => m.content.includes("图片已移出上下文"));
    assert.deepEqual(evicted.map((m) => m.toolCallId), ["c0", "c1"], "最早的已看过的两张被移出");
    assert.ok(evicted.every((m) => !m.images), "被移出的消息不再带 images");
    assert.ok(evicted[0]!.content.startsWith("[已读取图片 fig.png]\n[图片已移出上下文（1 张）"), evicted[0]!.content);
    assert.ok(evicted.every((m) => m.content.includes("可按原路径重新 read_image")), "移出说明指引按路径重读");
    assert.deepEqual(toolMsgs.filter((m) => m.images?.length).map((m) => m.toolCallId), ["c2", "c3", "c4", "c5"], "其余的图照常保留");
    // 新建对象：第 4 次请求（移出前）携带的 c0 消息对象 ≠ 现在历史里同位置的对象
    const before = provider.calls[4]!.messages.find(isToolWithId("c0"));
    const after = agent.messages.find(isToolWithId("c0"));
    assert.ok(before !== after && before!.images?.length === 1 && !after!.images, "移出 = 换成不带 images 的新对象（逐对象缓存按身份失效）");
    assert.ok(sink.some((x) => x.includes("[图片预算]") && x.includes("4 张 / 1 MiB") && x.includes("2 张图片")), "UI 提示预算上限与移出张数");
    // 实测锚点随前缀替换失效：移出后总量回退纯估算口径（不再按旧锚点外推）
    assert.equal(agent.contextEstimate().breakdown.other, 0);
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
  }
});

test("docs/42 修订 图片预算·字节：imageContextMaxBytes 独立生效（大图场景兜住单次请求的图片载荷），同样成批移到 75%", async () => {
  initConfig({ disabledModules: [], thresholds: { imageContextMaxCount: 100, imageContextMaxBytes: 10_000 } });
  try {
    // 每张 base64 4000 字符 = 解码 3000 字节：第 4 张入场后 12000 > 10000 → 移出最早的 2 张（余 6000 ≤ 7500）
    const big = { mime: "image/png" as const, data: "A".repeat(4000) };
    const script: ChatResult[] = [0, 1, 2, 3].map((k) => tcall(`c${k}`, "read_image"));
    script.push({ content: "完成", toolCalls: [], usage: null });
    const { agent, provider, sink } = makeImageAgent(script, { vision: true }, [big]);
    await agent.run("看大图");
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => imgCountOf(provider.calls, i)), [0, 1, 2, 3, 2]);
    assert.deepEqual(
      agent.messages.filter((m): m is ToolMsg => m.role === "tool" && !m.images).map((m) => m.toolCallId),
      ["c0", "c1"],
    );
    assert.ok(sink.some((x) => x.includes("100 张 / 10 KB") && x.includes("2 张图片")), "UI 提示按 KB 显示字节上限");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
  }
});

test("docs/42 修订 图片预算·移出顺序：工具读图先于用户贴图（贴图不能按路径重读）；贴图自身超预算时只移最早的几张（按张，不整条丢）", async () => {
  initConfig({ disabledModules: [], thresholds: { imageContextMaxCount: 2, imageContextMaxBytes: 1024 * 1024 } });
  try {
    // 用户贴 2 张占满预算 → 模型再读 1 张工具图：新读的图被移出，用户贴图保留
    const { agent, sink } = makeImageAgent([tcall("a", "read_image"), { content: "完成", toolCalls: [], usage: null }], { vision: true });
    await agent.run("看这两张", undefined, [IMG, IMG]);
    const pasted = agent.messages.find((m) => m.role === "user" && m.content === "看这两张");
    assert.ok(pasted?.role === "user" && pasted.images?.length === 2, "用户贴图保留");
    const toolMsg = agent.messages.find((m) => m.role === "tool" && m.toolCallId === "a");
    assert.ok(toolMsg?.role === "tool" && !toolMsg.images, "预算被贴图占满：模型还没看过的新工具图被移出");
    assert.ok(toolMsg!.content.includes("若预算仍被占满，重读的图还会被移出"), "说明里讲清预算状况，避免反复重读");
    assert.ok(sink.some((x) => x.includes("[图片预算]")));
    // 用户一次贴 4 张、预算 2 张：只移最早的 2 张，后 2 张照常发送（按张移出，不整条丢失）
    const { agent: a2, provider: p2 } = makeImageAgent([{ content: "ok", toolCalls: [], usage: null }], { vision: true });
    await a2.run("贴四张", undefined, [IMG, IMG, IMG, IMG]);
    const userMsg = a2.messages.find((m) => m.role === "user" && m.content.startsWith("贴四张"));
    assert.ok(userMsg?.role === "user" && userMsg.images?.length === 2, "同一条消息里只移出最早的 2 张");
    assert.ok(userMsg!.content.includes("[图片已移出上下文（2 张）"));
    assert.equal(imgCountOf(p2.calls, 0), 2, "首次请求就按预算发送");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
  }
});

test("docs/42 修订 纯文本模型：请求标记 omitImages（提供方投影省略图像），历史里的图原样保留、换回视觉模型即恢复；token 估算同步不计图像；不发图就不移出", async () => {
  initConfig({ disabledModules: [], thresholds: {} });
  try {
    const { agent, provider } = makeImageAgent(
      [tcall("a", "read_image"), tcall("b", "read_image"), tcall("c", "read_image"), { content: "完成", toolCalls: [], usage: null }],
      { vision: true, maxToolRounds: 20 },
    );
    await agent.run("看图");
    assert.ok(provider.calls.every((c) => c.omitImages === undefined), "视觉会话：不带 omitImages");
    assert.equal(imagesIn(agent.messages), 3, "前置：缺省预算下 3 张图都在");
    const withImages = agent.contextEstimate().total;
    // 切到纯文本模型并把预算收紧到 1 张：历史里的图一张也不移出（不发图就没有超预算可言）
    initConfig({ disabledModules: [], thresholds: { imageContextMaxCount: 1, imageContextMaxBytes: 1024 } });
    agent.setVision(false);
    await agent.run("换成纯文本模型后继续");
    assert.equal(provider.calls.at(-1)!.omitImages, true, "请求标记省略图像");
    assert.equal(imagesIn(agent.messages), 3, "历史里的 3 张图原样保留");
    const omitted = agent.contextEstimate().total;
    assert.ok(omitted < withImages, `省略口径不计图像 token：${withImages} → ${omitted}`);
    // 预算恢复缺省后换回视觉模型：图像块恢复携带（被预算移出的除外——本例没有被移出）
    initConfig({ disabledModules: [], thresholds: {} });
    agent.setVision(true);
    await agent.run("换回视觉模型再看");
    assert.equal(provider.calls.at(-1)!.omitImages, undefined);
    assert.equal(imgCountOf(provider.calls, provider.calls.length - 1), 3, "换回即恢复显示");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
  }
});

test("docs/42 修订 图片预算·恢复档：restore 的图按「已看过」处理——历史本身超预算时下一次请求前即移出最早的", async () => {
  initConfig({ disabledModules: [], thresholds: { imageContextMaxCount: 2, imageContextMaxBytes: 1024 * 1024 } });
  try {
    const { agent, provider } = makeImageAgent([{ content: "ok", toolCalls: [], usage: null }], { vision: true });
    const img = (id: string): ChatMessage => ({ role: "tool", toolCallId: id, content: `[已读取图片 ${id}.png]`, images: [IMG] });
    agent.restore([
      { role: "user", content: "旧任务" },
      { role: "assistant", content: null, toolCalls: ["a", "b", "c"].map((id) => ({ id, name: "read_image", arguments: "{}" })) },
      img("a"),
      img("b"),
      img("c"),
      { role: "assistant", content: "旧任务完成", toolCalls: [] },
    ]);
    await agent.run("继续");
    // maxCount=2 → 目标 ≤1（2×0.75）：a、b 移出，c 留下
    const toolMsgs = provider.calls[0]!.messages.filter((m) => m.role === "tool");
    assert.deepEqual(toolMsgs.map((m) => m.toolCallId), ["a", "b", "c"]);
    assert.deepEqual(toolMsgs.map((m) => m.images?.length ?? 0), [0, 0, 1]);
    assert.equal(imagesIn(agent.messages), 1);
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
  }
});

test("docs/42 上下文预警线提示：占用越过 warnPct 时向历史注入一次系统提示（tool 消息之后的 user 消息），后续 run 不重复", async () => {
  const script: ChatResult[] = [
    tcall("a", "echo_tool", '{"value":"1"}'),
    { content: "完成一", toolCalls: [], usage: null },
    tcall("b", "echo_tool", '{"value":"2"}'),
    { content: "完成二", toolCalls: [], usage: null },
  ];
  const { agent, provider, sink } = makeImageAgent(script, {
    contextWarn: { contextLength: () => 50, warnPct: 25 }, // 窗口给得很小：首轮之后占用必然越过预警线
  });
  await agent.run("任务一");
  const nudges = agent.messages.filter((m) => m.role === "user" && m.content.includes("系统提示：你的上下文占用已达"));
  assert.equal(nudges.length, 1, "一次 Agent 生命周期只提示一次");
  const at = agent.messages.indexOf(nudges[0]!);
  assert.equal(agent.messages[at - 1]!.role, "tool", "插在本轮 tool 消息之后（合法形状：tool → user）");
  assert.ok(sink.some((x) => x.includes("已越过预警线 25%")), "UI 信息行同步可见");
  assert.ok(provider.calls[1]!.messages.some((m) => m.role === "user" && m.content.includes("请立即精简操作")), "下一次请求携带该提示（模型收得到）");
  await agent.run("任务二");
  assert.equal(agent.messages.filter((m) => m.role === "user" && m.content.includes("系统提示：你的上下文占用已达")).length, 1, "后续任务不重复提示");
  // 未装配 contextWarn 的 Agent：零影响
  const plain = makeImageAgent(script);
  await plain.agent.run("任务一");
  assert.equal(plain.agent.messages.filter((m) => m.role === "user" && m.content.includes("系统提示：你的上下文占用已达")).length, 0);
});

test("docs/42 readOnly：deps.readOnly 随工具上下文下发（缺省不下发字段）", async () => {
  const { agent, ctxSink } = makeImageAgent([tcall("a", "read_image"), { content: "ok", toolCalls: [], usage: null }], { readOnly: true });
  await agent.run("t");
  assert.equal(ctxSink[0]!.readOnly, true);
  const plain = makeImageAgent([tcall("a", "read_image"), { content: "ok", toolCalls: [], usage: null }]);
  await plain.agent.run("t");
  assert.equal("readOnly" in plain.ctxSink[0]!, false, "缺省不带字段（普通会话字节不变）");
});
