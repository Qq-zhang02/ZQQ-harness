import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, type Tool, type ToolContext } from "./registry.ts";
import { createWorkspace } from "../workspace.ts";

const echoTool: Tool = {
  name: "echo_tool",
  description: "回声测试工具",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  execute: async (args) => `echo:${String(args.value)}`,
};

function makeCtx(): ToolContext {
  return { workspace: createWorkspace(process.cwd()), requestApproval: async () => "rejected" };
}

test("未知工具返回错误字符串而非抛异常", async () => {
  const r = new ToolRegistry();
  const out = await r.execute("nope", "{}", makeCtx());
  assert.ok(out.includes("未知工具"));
});

test("非法 JSON 参数返回错误字符串", async () => {
  const r = new ToolRegistry();
  r.register(echoTool);
  const out = await r.execute("echo_tool", "{bad json", makeCtx());
  assert.ok(out.includes("不是合法 JSON"));
});

test("工具抛错被捕获为字符串", async () => {
  const r = new ToolRegistry();
  r.register({
    ...echoTool,
    name: "boom",
    execute: async () => {
      throw new Error("炸了");
    },
  });
  const out = await r.execute("boom", "{}", makeCtx());
  assert.ok(out.includes("工具执行出错") && out.includes("炸了"));
});

test("正常执行并解析参数", async () => {
  const r = new ToolRegistry();
  r.register(echoTool);
  const out = await r.execute("echo_tool", '{"value":"hi"}', makeCtx());
  assert.equal(out, "echo:hi");
});

test("schemas 输出可交给 LLM 的工具定义", () => {
  const r = new ToolRegistry();
  r.register(echoTool);
  const s = r.schemas();
  assert.equal(s.length, 1);
  assert.equal(s[0].name, "echo_tool");
  assert.ok((s[0].parameters as { properties?: unknown }).properties);
});

// ---- docs/40 阶段二：resultBudget 挂钩——工具声明的预算优先于 ctx/DEFAULTS ----

test("executeWithMeta：resultBudget 声明优先于 ctx.toolResultMaxChars 与 DEFAULTS（阅读类独立预算）", async () => {
  const big = "A".repeat(30_000) + "B".repeat(30_000);
  const r = new ToolRegistry();
  r.register({
    name: "reader",
    description: "声明大预算的阅读类工具",
    parameters: { type: "object", properties: {} },
    execute: async () => big,
    resultBudget: () => 100_000,
  });
  r.register({
    name: "plain",
    description: "无声明的普通工具",
    parameters: { type: "object", properties: {} },
    execute: async () => big,
  });
  // reader：声明预算 100k > 输出 40k → 不修剪；plain：走缺省（DEFAULTS.toolResultMaxChars=48k）→ 修剪
  const resReader = await r.executeWithMeta("reader", "{}", makeCtx());
  assert.equal(resReader.prunedChars, 0, "声明预算内不修剪");
  const resPlain = await r.executeWithMeta("plain", "{}", makeCtx());
  assert.ok(resPlain.prunedChars > 0, "无声明走缺省预算被修剪");
  // ctx 显式传入的预算 reader 仍以声明优先
  const resReader2 = await r.executeWithMeta("reader", "{}", { ...makeCtx(), toolResultMaxChars: 100 });
  assert.equal(resReader2.prunedChars, 0, "工具声明 > ctx 传入");
  const resPlain2 = await r.executeWithMeta("plain", "{}", { ...makeCtx(), toolResultMaxChars: 100 });
  assert.ok(resPlain2.prunedChars > 0, "ctx 传入对无声明工具生效");
});
