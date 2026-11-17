/**
 * MCP 管理器测试（自 src/mcp/mcp.test.ts 拆分，P5）：合并两级配置、
 * mcp__ 前缀注册、失败隔离、断开重连；manager 经 ctx.mcpTransports
 * 注册表选路（此处注册真实 stdio 传输）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, loadMcpConfig } from "./manager.ts";
import { Registry } from "../core/registry.ts";
import type { McpTransportDef } from "../core/types.ts";
import { stdioTransport } from "../modules/mcp/stdio/index.ts";
import { ToolRegistry } from "../tools/registry.ts";

function transports(): Registry<McpTransportDef, "type"> {
  const r = new Registry<McpTransportDef, "type">("type");
  r.register(stdioTransport);
  return r;
}

const DEMO = { command: process.execPath, args: [join(process.cwd(), "scripts", "demo-mcp-server.mjs")] };

test("MCP 管理器：工具以 mcp__服务器__工具 注册并可执行", async () => {
  const registry = new ToolRegistry();
  const mgr = new McpManager(transports());
  try {
    await mgr.apply({ mcpServers: { demo: DEMO } }, { mcpServers: {} }, registry);
    assert.equal(mgr.toolCount(), 2);
    assert.ok(registry.schemas().some((t) => t.name === "mcp__demo__add"));
    const out = await registry.execute("mcp__demo__add", '{"a":20,"b":22}', {
      workspace: { root: process.cwd() },
      requestApproval: async () => "rejected",
    });
    assert.equal(out, "42");
    assert.equal(mgr.status().length, 1);
  } finally {
    mgr.stop();
  }
});

test("MCP 管理器：单个服务器失败不影响其他", async () => {
  const registry = new ToolRegistry();
  const mgr = new McpManager(transports());
  try {
    await mgr.apply(
      { mcpServers: {} },
      {
        mcpServers: {
          bad: { command: "definitely-not-exist-cmd-xyz" },
          demo: DEMO,
        },
      },
      registry,
    );
    assert.equal(mgr.toolCount(), 2);
    assert.ok(mgr.status().some((s) => s.startsWith("bad（启动失败")));
  } finally {
    mgr.stop();
  }
});

test("MCP 管理器：apply 可重复调用（断开旧的、按新配置注册、工作区来源标注）", async () => {
  const registry = new ToolRegistry();
  const mgr = new McpManager(transports());
  try {
    await mgr.apply({ mcpServers: { demo: DEMO } }, { mcpServers: {} }, registry);
    assert.ok(registry.schemas().some((t) => t.name === "mcp__demo__add"));
    assert.ok(mgr.status().some((s) => s.includes("demo（全局")));

    // 切到"工作区配置"：旧的 demo 工具应被注销，新的 demo2 注册
    await mgr.apply({ mcpServers: {} }, { mcpServers: { demo2: DEMO } }, registry);
    const names = registry.schemas().map((t) => t.name);
    assert.ok(names.includes("mcp__demo2__add"));
    assert.ok(!names.includes("mcp__demo__add"));
    assert.ok(mgr.status().some((s) => s.includes("demo2（工作区")));
    assert.equal(mgr.toolCount(), 2);
  } finally {
    mgr.stop();
  }
});

test("loadMcpConfig：读取与缺省", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-mcp-"));
  try {
    const f = join(dir, "mcp.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { x: { command: "node" } } }), "utf8");
    const cfg = await loadMcpConfig([join(dir, "none.json"), f]);
    assert.ok(cfg.mcpServers.x);
    const empty = await loadMcpConfig([join(dir, "none.json")]);
    assert.deepEqual(empty.mcpServers, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/32：failedServers（失败重试判据）与 toolInventoryText（协调者能力清单兜底） ----------

test("MCP 管理器：failedServers 列启动失败项；toolInventoryText 按服务器分组列工具与截断描述", async () => {
  const registry = new ToolRegistry();
  const mgr = new McpManager(transports());
  try {
    assert.equal(mgr.toolInventoryText(), null, "无连接时清单为 null");
    assert.deepEqual(mgr.failedServers(), []);
    await mgr.apply(
      { mcpServers: {} },
      { mcpServers: { bad: { command: "definitely-not-exist-cmd-xyz" }, demo: DEMO } },
      registry,
    );
    const failed = mgr.failedServers();
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.name, "bad");
    assert.ok(failed[0]!.error.length > 0);
    const inv = mgr.toolInventoryText();
    assert.ok(inv, "有连接时清单非 null");
    assert.ok(inv!.includes("【demo（工作区，2 个工具）】"), inv!);
    assert.ok(inv!.includes("mcp__demo__add"), inv!);
  } finally {
    mgr.stop();
  }
  // 重连后失败清单随 stopAll 清空
  const mgr2 = new McpManager(transports());
  try {
    await mgr2.apply({ mcpServers: {} }, { mcpServers: { bad: { command: "definitely-not-exist-cmd-xyz" } } }, new ToolRegistry());
    assert.equal(mgr2.failedServers().length, 1);
    await mgr2.apply({ mcpServers: {} }, { mcpServers: { demo: DEMO } }, new ToolRegistry());
    assert.deepEqual(mgr2.failedServers(), [], "重连成功后失败清单清空");
    assert.notEqual(mgr2.toolInventoryText(), null);
  } finally {
    mgr2.stop();
  }
});
