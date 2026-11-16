/**
 * tools.write-file 模块测试：新建/覆写、先读后写守卫、审批矩阵（read-only 必问、
 * 区外必问、danger+逐条确认才问、拒绝不写）。台账与 read-file/edit-file 共用构造。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolWriteFile } from "./index.ts";
import { buildContext } from "../../../core/context.ts";
import { loadConfig } from "../../../config.ts";
import { createFileLedger, ledgerKey, type FileLedger } from "../../../core/file-tools.ts";
import type { ApprovalDecision, ApprovalRequest } from "../../../approval/types.ts";
import type { SandboxMode } from "../../../sandbox/types.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ToolContext } from "../../../tools/registry.ts";

interface Harness {
  deps: SystemToolDeps;
  ledger: FileLedger;
  asks: ApprovalRequest[];
  setSandbox(m: SandboxMode): void;
  setConfirm(b: boolean): void;
  decide(d: ApprovalDecision): void;
  toolCtx(): ToolContext;
}

function makeHarness(wsRoot: string): Harness {
  const ledger: FileLedger = createFileLedger();
  const asks: ApprovalRequest[] = [];
  let sandbox: SandboxMode = "workspace-write";
  let confirm = false;
  let decision: ApprovalDecision = "allowed-once";
  const ctx = buildContext(
    { userDir: wsRoot, globalSkillsDir: wsRoot, globalMcpFile: join(wsRoot, "mcp.json"), workspacesFile: join(wsRoot, "w.json"), sessionsDir: join(wsRoot, "s") },
    loadConfig(),
  );
  const ask = async (req: ApprovalRequest) => {
    asks.push(req);
    return decision;
  };
  const deps: SystemToolDeps = {
    ctx,
    workspace: () => ({ root: wsRoot }),
    skills: () => [],
    requestApproval: ask,
    alwaysConfirm: () => confirm, // docs/30：模块 live 读 deps——测试经 setSandbox/setConfirm 驱动
    sandboxMode: () => sandbox,
    spillDir: () => undefined,
    privateTempDir: () => undefined,
    mcpStatus: () => [],
    reloadMcp: async () => [],
    ledger,
  };
  return {
    deps,
    ledger,
    asks,
    setSandbox: (m) => (sandbox = m),
    setConfirm: (b) => (confirm = b),
    decide: (d) => (decision = d),
    toolCtx: () => ({ workspace: { root: wsRoot }, requestApproval: ask, sandboxMode: sandbox }),
  };
}

test("write_file：新建（含父目录）成功并登记台账；覆写已读文件放行", async () => {
  const ws = mkdtempSync(join(tmpdir(), "wf-"));
  const h = makeHarness(ws);
  toolWriteFile.setup(h.deps.ctx);
  const tool = h.deps.ctx.tools.require("write_file").create(h.deps);

  const out = await tool.execute({ path: "sub/new.txt", content: "A\nB" }, h.toolCtx());
  assert.ok(out.includes("已写入") && out.includes("新建") && out.includes("2 行"));
  assert.equal(readFileSync(join(ws, "sub", "new.txt"), "utf8"), "A\nB");
  assert.ok(h.ledger.wasRead(ledgerKey(join(ws, "sub", "new.txt"))));

  const again = await tool.execute({ path: "sub/new.txt", content: "C" }, h.toolCtx());
  assert.ok(again.includes("覆写"));
  assert.equal(readFileSync(join(ws, "sub", "new.txt"), "utf8"), "C");
  rmSync(ws, { recursive: true, force: true });
});

test("write_file：覆写未读过的已有文件被拒；read_file 之后放行（先读后写契约）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "wf2-"));
  const h = makeHarness(ws);
  toolWriteFile.setup(h.deps.ctx);
  const write = h.deps.ctx.tools.require("write_file").create(h.deps);
  writeFileSync(join(ws, "user.txt"), "用户数据");

  const refused = await write.execute({ path: "user.txt", content: "X" }, h.toolCtx());
  assert.ok(refused.includes("先 read_file"));
  assert.equal(readFileSync(join(ws, "user.txt"), "utf8"), "用户数据"); // 原文未动
  assert.equal(h.asks.length, 0); // 守卫在裁决之前，未弹卡

  // 用真实的 read_file 工具读一遍（同一台账）
  const { toolReadFile } = await import("../read-file/index.ts");
  toolReadFile.setup(h.deps.ctx);
  const read = h.deps.ctx.tools.require("read_file").create(h.deps);
  await read.execute({ path: "user.txt" }, h.toolCtx());
  const ok = await write.execute({ path: "user.txt", content: "Y" }, h.toolCtx());
  assert.ok(ok.includes("覆写"));
  rmSync(ws, { recursive: true, force: true });
});

test("write_file：read-only 模式弹审批，批准才写、拒绝不写", async () => {
  const ws = mkdtempSync(join(tmpdir(), "wf3-"));
  const h = makeHarness(ws);
  h.setSandbox("read-only");
  toolWriteFile.setup(h.deps.ctx);
  const tool = h.deps.ctx.tools.require("write_file").create(h.deps);

  h.decide("allowed-once");
  const ok = await tool.execute({ path: "a.txt", content: "1" }, h.toolCtx());
  assert.ok(ok.includes("已写入"));
  assert.equal(h.asks.length, 1);
  assert.ok(h.asks[0].reasons.some((r) => r.includes("read-only")));

  h.decide("rejected");
  const no = await tool.execute({ path: "b.txt", content: "2" }, h.toolCtx());
  assert.ok(!existsSync(join(ws, "b.txt")));
  assert.ok(no.includes("拒绝"));
  rmSync(ws, { recursive: true, force: true });
});

test("write_file：workspace-write 区外弹审批；danger-full-access + 逐条确认弹卡", async () => {
  const ws = mkdtempSync(join(tmpdir(), "wf4-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "wf4-out-")); // 另一个临时目录 = 工作区外
  const h = makeHarness(ws);
  toolWriteFile.setup(h.deps.ctx);
  const tool = h.deps.ctx.tools.require("write_file").create(h.deps);

  const outside = await tool.execute({ path: join(outsideDir, "x.txt"), content: "o" }, h.toolCtx());
  assert.ok(outside.includes("已写入"));
  assert.equal(h.asks.length, 1);
  assert.ok(h.asks[0].reasons.some((r) => r.includes("工作区外")));

  // danger-full-access：alwaysConfirm=false（默认）不问；描述透传审批卡（docs/30：经 deps live setters 驱动）
  h.decide("allowed-once");
  h.setSandbox("danger-full-access");
  await tool.execute({ path: "d1.txt", content: "1" }, h.toolCtx());
  assert.equal(h.asks.length, 1); // 仍是区外那一次
  h.setConfirm(true);
  await tool.execute(
    { path: "d2.txt", content: "2", description: "写冒烟文件" },
    h.toolCtx(),
  );
  assert.equal(h.asks.length, 2);
  assert.equal(h.asks[1].description, "写冒烟文件");
  rmSync(ws, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test("write_file：读取之后文件被外部修改（并行子代理/外部进程）→ 拒绝并引导重读；重读后放行（§5.3 乐观锁）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "wf5-"));
  const h = makeHarness(ws);
  toolWriteFile.setup(h.deps.ctx);
  const write = h.deps.ctx.tools.require("write_file").create(h.deps);
  const { toolReadFile } = await import("../read-file/index.ts");
  toolReadFile.setup(h.deps.ctx);
  const read = h.deps.ctx.tools.require("read_file").create(h.deps);

  writeFileSync(join(ws, "shared.txt"), "v1");
  await read.execute({ path: "shared.txt" }, h.toolCtx());
  writeFileSync(join(ws, "shared.txt"), "别人改过的 v2"); // 读取之后、写入之前被改

  const refused = await write.execute({ path: "shared.txt", content: "mine" }, h.toolCtx());
  assert.ok(refused.includes("已被修改"), refused);
  assert.ok(refused.includes("重新 read_file"), "拒绝文案应引导重读");
  assert.equal(readFileSync(join(ws, "shared.txt"), "utf8"), "别人改过的 v2"); // 他人工作未被覆盖
  assert.equal(h.asks.length, 0); // 守卫在裁决之前，未弹卡

  await read.execute({ path: "shared.txt" }, h.toolCtx()); // 重读自愈
  const ok = await write.execute({ path: "shared.txt", content: "mine" }, h.toolCtx());
  assert.ok(ok.includes("覆写"));
  assert.equal(readFileSync(join(ws, "shared.txt"), "utf8"), "mine");
  rmSync(ws, { recursive: true, force: true });
});
