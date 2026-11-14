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
