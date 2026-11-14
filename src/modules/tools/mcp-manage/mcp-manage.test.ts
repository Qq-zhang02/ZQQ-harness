/**
 * tools.mcp-manage 模块测试：add/list/remove 全流程、损坏文件 fail-closed（字节不变）、
 * 条目校验拒绝、更新覆盖、全局/工作区双 scope、重连状态回传解释。
 * deps 用真实 buildContext（类型安全），reloadMcp/mcpStatus 打桩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolMcpManage } from "./index.ts";
import { buildContext } from "../../../core/context.ts";
import { createFileLedger } from "../../../core/file-tools.ts";
import { loadConfig } from "../../../config.ts";
import type { McpTransportDef, SystemToolDeps } from "../../../core/types.ts";

const FAKE_STATUS = ["demo（全局，2 个工具）"];
const FAKE_RELOAD = ["demo（全局，2 个工具）", "smoke（工作区，1 个工具）"];
const FAIL_RELOAD = ["smoke（工作区，启动失败：命令不存在）"];

function makeHarness(opts?: { reload?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "mm-"));
  const globalFile = join(dir, "global-mcp.json");
  const wsRoot = join(dir, "ws");
  let reloads = 0;
  const ctx = buildContext(
    { userDir: dir, globalSkillsDir: dir, globalMcpFile: globalFile, workspacesFile: join(dir, "w.json"), sessionsDir: join(dir, "s") },
    loadConfig(),
  );
  ctx.mcpTransports.register({ type: "stdio", connect: async () => { throw new Error("测试桩不连接"); } });
  const deps: SystemToolDeps = {
    ctx,
    workspace: () => ({ root: wsRoot }),
    skills: () => [],
    requestApproval: async () => "allowed-once",
    alwaysConfirm: () => false,
    sandboxMode: () => "workspace-write",
    spillDir: () => undefined,
    privateTempDir: () => undefined,
    mcpStatus: () => FAKE_STATUS,
    reloadMcp: async () => {
      reloads++;
      return opts?.reload ?? FAKE_RELOAD;
    },
    ledger: createFileLedger(),
  };
  toolMcpManage.setup(ctx);
  const tool = ctx.tools.require("manage_mcp").create(deps);
  const NO_CTX = {} as Parameters<typeof tool.execute>[1];
  return { tool, NO_CTX, globalFile, wsRoot, reloadCount: () => reloads, dir };
}

test("manage_mcp add：全局写入、reload 触发、成功文案带工具前缀与生效说明", async () => {
  const h = makeHarness();
  const out = await h.tool.execute(
    { action: "add", name: "smoke", command: "node", args: ["srv.js"], env: { K: "V" }, scope: "global" },
    h.NO_CTX,
  );
  const file = JSON.parse(readFileSync(h.globalFile, "utf8"));
  assert.deepEqual(file.mcpServers.smoke, { command: "node", args: ["srv.js"], env: { K: "V" } });
  assert.equal(h.reloadCount(), 1);
  assert.ok(out.includes("已写入 全局配置"));
  assert.ok(out.includes("mcp__smoke__<工具名>"));
  assert.ok(out.includes("1 个工具"));
  rmSync(h.dir, { recursive: true, force: true });
});

test("manage_mcp add：非法条目拒绝且文件不动；未知 type 拒绝", async () => {
  const h = makeHarness();
  await h.tool.execute({ action: "add", name: "keep", command: "node" }, h.NO_CTX);
  const before = readFileSync(h.globalFile, "utf8");

  const badArgs = await h.tool.execute(
    { action: "add", name: "x", command: "node", args: "not-array" },
    h.NO_CTX,
  );
  assert.ok(badArgs.startsWith("错误"));
  const badName = await h.tool.execute({ action: "add", name: "has space", command: "node" }, h.NO_CTX);
  assert.ok(badName.includes("服务名"));
  const badType = await h.tool.execute({ action: "add", name: "x", command: "node", type: "http" }, h.NO_CTX);
  assert.ok(badType.includes("未注册"));
  const noCmd = await h.tool.execute({ action: "add", name: "x" }, h.NO_CTX);
  assert.ok(noCmd.includes("command"));
  assert.equal(readFileSync(h.globalFile, "utf8"), before);
  rmSync(h.dir, { recursive: true, force: true });
});

test("manage_mcp add：损坏文件 fail-closed——拒绝修改且原字节不变", async () => {
  const h = makeHarness();
  const broken = '{\n  "mcpServers": {\n    "demo": "坏掉的"\n  // 未闭合';
  writeFileSync(h.globalFile, broken, "utf8");
  const out = await h.tool.execute({ action: "add", name: "x", command: "node" }, h.NO_CTX);
  assert.ok(out.includes("拒绝修改") && out.includes("已损坏"));
  assert.equal(readFileSync(h.globalFile, "utf8"), broken); // 一字节未动
  assert.equal(h.reloadCount(), 0); // 根本没走到重连
  rmSync(h.dir, { recursive: true, force: true });
});

test("manage_mcp add：同名更新；启动失败时回传排查清单", async () => {
  const h = makeHarness({ reload: FAIL_RELOAD });
  await h.tool.execute({ action: "add", name: "smoke", command: "node", args: ["a.js"] }, h.NO_CTX);
  const upd = await h.tool.execute({ action: "add", name: "smoke", command: "python", args: ["b.py"] }, h.NO_CTX);
  assert.ok(upd.includes("已更新"));
  const file = JSON.parse(readFileSync(h.globalFile, "utf8"));
  assert.equal(file.mcpServers.smoke.command, "python");

  const h2 = makeHarness({ reload: FAIL_RELOAD });
  const fail = await h2.tool.execute({ action: "add", name: "smoke", command: "nope-cmd" }, h2.NO_CTX);
  assert.ok(fail.includes("启动失败") && fail.includes("排查") && fail.includes("预热"));
  assert.ok(fail.includes("再次 add 即可覆盖更新"));
  rmSync(h.dir, { recursive: true, force: true });
  rmSync(h2.dir, { recursive: true, force: true });
});

test("manage_mcp remove：移除并重连；不存在时报现有清单；损坏文件拒改", async () => {
  const h = makeHarness();
  await h.tool.execute({ action: "add", name: "smoke", command: "node" }, h.NO_CTX);
  const removed = await h.tool.execute({ action: "remove", name: "smoke" }, h.NO_CTX);
  assert.ok(removed.includes("已从全局配置") && removed.includes("剩余服务器"));
  const file = JSON.parse(readFileSync(h.globalFile, "utf8"));
  assert.equal(file.mcpServers.smoke, undefined);

  const miss = await h.tool.execute({ action: "remove", name: "ghost" }, h.NO_CTX);
  assert.ok(miss.includes('没有名为 "ghost"') && miss.includes("现有"));

  writeFileSync(h.globalFile, "{broken", "utf8");
  const corrupt = await h.tool.execute({ action: "remove", name: "x" }, h.NO_CTX);
  assert.ok(corrupt.includes("拒绝修改"));
  rmSync(h.dir, { recursive: true, force: true });
});

test("manage_mcp：工作区 scope 独立成文件；list 展示两份配置+状态+损坏标注", async () => {
  const h = makeHarness();
  const wsOut = await h.tool.execute(
    { action: "add", name: "smoke", command: "node", scope: "workspace" },
    h.NO_CTX,
  );
  assert.ok(wsOut.includes("工作区配置"));
  const wsFile = JSON.parse(readFileSync(join(h.wsRoot, "mcp.json"), "utf8"));
  assert.equal(wsFile.mcpServers.smoke.command, "node");
  assert.equal(existsSync(h.globalFile), false); // 工作区 scope 不碰全局文件

  writeFileSync(h.globalFile, "{broken", "utf8");
  const list = await h.tool.execute({ action: "list" }, h.NO_CTX);
  assert.ok(list.includes("全局") && list.includes("损坏"));
  assert.ok(list.includes("工作区") && list.includes("smoke"));
  assert.ok(list.includes("本会话连接状态"));
  assert.ok(list.includes("demo（全局，2 个工具）"));
  rmSync(h.dir, { recursive: true, force: true });
});
