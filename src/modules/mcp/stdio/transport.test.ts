/**
 * MCP stdio 传输测试（自 src/mcp/mcp.test.ts 拆分，P5）：走 stdioTransport.connect
 * 全链路（spawn demo 服务器 → 握手 → 工具列表 → 调用）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stdioTransport } from "./index.ts";

const DEMO = { command: process.execPath, args: [join(process.cwd(), "scripts", "demo-mcp-server.mjs")] };

test("MCP 传输：握手 + 工具列表", async () => {
  const c = await stdioTransport.connect("demo", DEMO);
  try {
    assert.equal(c.serverInfo.name, "demo-mcp");
    assert.deepEqual(
      c.listTools().map((t) => t.name).sort(),
      ["add", "echo"],
    );
    assert.ok(c.alive);
  } finally {
    c.stop();
  }
});

test("MCP 传输：调用工具返回文本（含中文）", async () => {
  const c = await stdioTransport.connect("demo", DEMO);
  try {
    assert.equal(await c.callTool("add", { a: 2, b: 3 }), "5");
    assert.equal(await c.callTool("echo", { text: "你好" }), "你好");
  } finally {
    c.stop();
  }
});
