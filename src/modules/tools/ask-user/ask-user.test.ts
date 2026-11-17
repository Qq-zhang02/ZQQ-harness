/**
 * tools.ask-user 模块测试（docs/32 前台询问用户）：参数校验（question 必填/长度上限、
 * options 2~4 个非空短选项）、回答格式化（choice/text/cancelled/无效回答四态）、
 * 接缝缺失的子代理防御文案、接缝参数透传。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFileLedger } from "../../../core/file-tools.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { Tool, ToolContext } from "../../../tools/registry.ts";
import { createAskUserTool, formatAskUserAnswer, parseAskUserArgs } from "./ask-user.ts";

const tctx: ToolContext = { workspace: { root: "F:\\ws" }, requestApproval: async () => "allowed-once" };

test("parseAskUserArgs：question 必填与长度上限；options 2~4 个、非空、单项 ≤200 字符", () => {
  assert.ok("error" in parseAskUserArgs({}), "缺 question 报错");
  assert.ok("error" in parseAskUserArgs({ question: "  " }), "空白 question 报错");
  assert.ok("error" in parseAskUserArgs({ question: "q".repeat(2001), options: ["a", "b"] }), "question 超长报错");
  assert.ok("error" in parseAskUserArgs({ question: "q" }), "缺 options 报错");
  assert.ok("error" in parseAskUserArgs({ question: "q", options: ["a"] }), "单选项报错");
  assert.ok("error" in parseAskUserArgs({ question: "q", options: ["a", "b", "c", "d", "e"] }), "5 选项报错");
  assert.ok("error" in parseAskUserArgs({ question: "q", options: ["a", ""] }), "空选项报错");
  assert.ok("error" in parseAskUserArgs({ question: "q", options: ["a", "x".repeat(201)] }), "选项超长报错");
  const ok = parseAskUserArgs({ question: " 用哪个方案？ ", options: [" 方案A ", "方案B", 3] });
  assert.ok(!("error" in ok));
  if (!("error" in ok)) {
    assert.equal(ok.question, "用哪个方案？");
    assert.deepEqual(ok.options, ["方案A", "方案B", "3"]);
  }
});

test("formatAskUserAnswer：choice/text/cancelled/无效四态", () => {
  const options = ["方案A", "方案B"];
  assert.equal(formatAskUserAnswer({ choice: 1 }, options), "用户选择了：方案B");
  assert.equal(formatAskUserAnswer({ text: " 都不要，自定义走法 " }, options), "用户没有选给定选项，自行输入：都不要，自定义走法");
  assert.ok(formatAskUserAnswer({ cancelled: true }, options).includes("不要假设答案"));
  assert.ok(formatAskUserAnswer({}, options).includes("不要假设答案"), "空回答归无效");
  assert.ok(formatAskUserAnswer({ choice: 9 }, options).includes("不要假设答案"), "越界下标归无效");
});

test("ask_user：接缝缺失（子代理防线文案）与参数透传、回答格式化", async () => {
  // 接缝缺失：worker 双层防线之二（registry 三值过滤是第一层）
  const bare = createAskUserTool({ ledger: createFileLedger() } as unknown as SystemToolDeps);
  const miss = await bare.execute({ question: "q", options: ["a", "b"] }, tctx);
  assert.ok(miss.includes("子代理不能直接向用户提问"), miss);
  // 参数错误直接返回校验文案，不打扰接缝
  const bad = await bare.execute({ question: "q", options: ["a"] }, tctx);
  assert.ok(bad.includes("2~4 个选项"), bad);

  let seen: { question: string; options: string[] } | undefined;
  const deps = {
    ledger: createFileLedger(),
    askUser: async (q: { question: string; options: string[] }) => {
      seen = q;
      return { choice: 0 };
    },
  } as unknown as SystemToolDeps;
  const t: Tool = createAskUserTool(deps);
  assert.ok(t.name === "ask_user");
  const out = await t.execute({ question: "用哪个方案？", options: ["方案A", "方案B"] }, tctx);
  assert.equal(out, "用户选择了：方案A");
  assert.deepEqual(seen, { question: "用哪个方案？", options: ["方案A", "方案B"] });
});
