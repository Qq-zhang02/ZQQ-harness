import test from "node:test";
import assert from "node:assert/strict";
import {
  cacheHitRate,
  contextPressure,
  estTokens,
  estTokensHeuristic,
  estimateBreakdown,
  messageTokenCount,
  messageTokens,
  IMAGE_TOKEN_EST,
  withOther,
} from "./tokens.ts";
import type { ChatMessage, ToolSchema } from "./llm/provider.ts";
import { skillListText, type SkillInfo } from "./core/skills.ts";

test("cacheHitRate：命中率取整数百分比，无输入/无命中为 0，封顶 100", () => {
  assert.equal(cacheHitRate(11904, 15330), 78);
  assert.equal(cacheHitRate(0, 1000), 0);
  assert.equal(cacheHitRate(500, 0), 0);
  assert.equal(cacheHitRate(1000, 1000), 100);
  assert.equal(cacheHitRate(1200, 1000), 100);
});

test("estTokens：使用 DeepSeek v4 tokenizer 真实计数", () => {
  assert.equal(estTokens(""), 0);
  assert.equal(estTokens("Hello!"), 2); // Hello + !
  assert.equal(estTokens("你好"), 1); // 单 token
  assert.equal(estTokens("1234567"), 3); // \p{N}{1,3} 切分为 123|456|7
  assert.ok(estTokens("你好世界") >= 1);
  // 同串幂等（缓存一致性）
  const s = "中文与English混排 1234567";
  assert.equal(estTokens(s), estTokens(s));
  // 空白与多行也可计数
  assert.ok(estTokens("多行文本\n第二行\t制表符") >= 2);
});

test("estTokensHeuristic：tokenizer 资产缺失时的官方比例回退", () => {
  assert.equal(estTokensHeuristic(""), 0);
  assert.equal(estTokensHeuristic("abcd"), 2); // ceil(4 * 0.3)
  assert.equal(estTokensHeuristic("你好"), 2); // ceil(2 * 0.6)
  assert.ok(estTokensHeuristic("你好世界") > estTokensHeuristic("abcd"));
});

test("estimateBreakdown：system 归系统提示词，mcp__ 前缀工具归 MCP，其余工具与消息各自归类", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "系统提示词内容" },
    { role: "user", content: "hello" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "mcp__demo__t", arguments: '{"x":1}' }] },
  ];
  const tools: ToolSchema[] = [
    { name: "run_pwsh", description: "d", parameters: {} },
    { name: "mcp__demo__t", description: "d", parameters: {} },
  ];
  const bd = estimateBreakdown(messages, tools);
  assert.ok(bd.systemPrompt > 0);
  assert.ok(bd.systemTools > 0);
  assert.ok(bd.mcp > 0);
  assert.ok(bd.messages > 0);
  assert.equal(bd.skills, 0);
  // 系统消息不计入消息类
  const noSys = estimateBreakdown(
    [{ role: "user", content: "hi" }],
    [],
  );
  assert.equal(noSys.systemPrompt, 0);
});

test("estimateBreakdown：技能清单从系统提示中拆出单列", () => {
  const skills: SkillInfo[] = [
    { name: "commit-helper", description: "写提交信息的技能描述", path: "p", source: "global" },
  ];
  const sys = "基础系统提示词。\n\n" + (skillListText(skills) ?? "");
  const bd = estimateBreakdown([{ role: "system", content: sys }], [], skills);
  assert.ok(bd.skills > 0);
  assert.ok(bd.systemPrompt > 0);
  // 技能单列后，系统提示词 = 总量 − 技能
  assert.equal(bd.systemPrompt + bd.skills, estTokens(sys));
  const noSkills = estimateBreakdown([{ role: "system", content: sys }], []);
  assert.equal(noSkills.skills, 0);
  assert.ok(noSkills.systemPrompt > bd.systemPrompt);
});

test("estimateBreakdown：服务器 instructions 计入 MCP 分类", () => {
  const bd = estimateBreakdown([{ role: "system", content: "系统提示" }], [], [], "MCP 使用规则文本");
  assert.ok(bd.mcp >= estTokens("MCP 使用规则文本"));
  const without = estimateBreakdown([{ role: "system", content: "系统提示" }], []);
  assert.ok(bd.mcp > without.mcp);
});

test("withOther：余量归入 other，六类合计等于实际总量；估算偏高时 other 归 0", () => {
  const bd = { systemPrompt: 10, skills: 4, systemTools: 5, mcp: 3, messages: 7, other: 0 };
  const r = withOther({ promptTokens: 34 }, bd);
  assert.equal(r.other, 5);
  const sum = r.systemPrompt + r.skills + r.systemTools + r.mcp + r.messages + r.other;
  assert.equal(sum, 34);
  assert.equal(withOther({ promptTokens: 10 }, bd).other, 0);
});

test("messageTokens：按消息对象身份缓存，重复调用只计数一次（注入假 tokenizer 断言次数）", () => {
  let calls = 0;
  const fake = (s: string) => {
    calls++;
    return s.length;
  };
  const m: ChatMessage = { role: "user", content: "hello" };
  const a = messageTokens(m, fake);
  const b = messageTokens(m, fake);
  assert.equal(a, b);
  assert.equal(calls, 1); // 第二次命中 WeakMap 缓存
  assert.ok(a >= 5); // 正文 + 框架开销
  // 新消息对象 = 新计数（push-only 历史里新增消息才真正分词）
  messageTokens({ role: "user", content: "hello" }, fake);
  assert.equal(calls, 2);
  // assistant 的工具调用参数也计入
  const cnt2 = (s: string) => s.length;
  const am: ChatMessage = { role: "assistant", content: null, toolCalls: [{ id: "c", name: "t", arguments: '{"x":1}' }] };
  assert.ok(messageTokens(am, cnt2) > messageTokens({ role: "user", content: "" }, cnt2));
});

test("messageTokenCount：与注入计数器一致，含消息框架开销", () => {
  const m: ChatMessage = { role: "user", content: "abcd" };
  assert.equal(messageTokenCount(m, (s) => s.length), 4 + 4); // 正文 4 + 框架 4
});

test("messageTokens：passback 口径计入思考文本，两种口径独立缓存互不污染", () => {
  const cnt = (s: string) => s.length;
  const m: ChatMessage = {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "c", name: "t", arguments: "{}" }],
    thinking: { text: "abcd" },
  };
  const plain = messageTokens(m, cnt);
  const pb = messageTokens(m, cnt, true);
  assert.equal(pb, plain + 4); // 思考文本按注入计数器为 4
  assert.equal(messageTokens(m, cnt), plain); // 再取 plain 口径仍是缓存旧值
  assert.equal(messageTokens(m, cnt, true), pb);
  // 无思考块的消息两种口径相同
  const noTh: ChatMessage = { role: "assistant", content: null, toolCalls: [] };
  assert.equal(messageTokens(noTh, cnt, true), messageTokens(noTh, cnt));
});

test("estimateBreakdown：回传判定为真才把 thinking.text 计入 messages 分类（六类和不变量）", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "系统" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "c", name: "t", arguments: "{}" }],
      thinking: { text: "abcd" },
    },
  ];
  const all = estimateBreakdown(msgs, [], [], null, () => true);
  const none = estimateBreakdown(msgs, [], [], null, () => false);
  assert.equal(all.messages, none.messages + estTokens("abcd")); // 差值恰为思考文本 token
  // 六类合计经 withOther 校准后恒等于实际总量（总量取估算合计，other 归 0）
  const total = all.systemPrompt + all.skills + all.systemTools + all.mcp + all.messages;
  const w = withOther({ promptTokens: total }, all);
  assert.equal(w.systemPrompt + w.skills + w.systemTools + w.mcp + w.messages + w.other, total);
});

test("contextPressure：total/contextLength 夹到 [0,1]，非法 contextLength 为 0", () => {
  assert.equal(contextPressure(500, 1000), 0.5);
  assert.equal(contextPressure(1500, 1000), 1);
  assert.equal(contextPressure(0, 1000), 0);
  assert.equal(contextPressure(-5, 1000), 0);
  assert.equal(contextPressure(100, 0), 0);
  assert.equal(contextPressure(100, -1), 0);
});

// ---------- docs/10 R3：图片 token 估算 ----------

test("messageTokenCount：user 消息带图片按 IMAGE_TOKEN_EST 计入（docs/10 R3）", () => {
  const base = { role: "user" as const, content: "hello world" };
  const withImg = { role: "user" as const, content: "hello world", images: [{ mime: "image/png" as const, data: "AAAA" }, { mime: "image/jpeg" as const, data: "BBBB" }] };
  const diff = messageTokenCount(withImg, () => 0) - messageTokenCount(base, () => 0);
  assert.equal(diff, 2 * IMAGE_TOKEN_EST);
  // 计数进 messages 分类（estimateBreakdown 六类合计不变量保持）
  const bd = estimateBreakdown([{ role: "system", content: "sys" }, withImg], []);
  assert.ok(bd.messages >= 2 * IMAGE_TOKEN_EST);
});

test("messageTokens：带图消息的对象身份缓存路径同样生效", () => {
  const m = { role: "user" as const, content: "x", images: [{ mime: "image/png" as const, data: "A" }] };
  const a = messageTokens(m);
  const b = messageTokens(m);
  assert.equal(a, b);
  assert.ok(a >= IMAGE_TOKEN_EST);
});
