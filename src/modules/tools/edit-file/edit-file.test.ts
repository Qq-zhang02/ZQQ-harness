/**
 * tools.edit-file 模块测试：先读后编辑、唯一命中、CRLF 保持、replace_all、
 * occurrence 指定第几处、编辑类错误（未命中/多次/相同/越界/互斥）、read-only 审批。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolEditFile } from "./index.ts";
import { toolReadFile } from "../read-file/index.ts";
import { buildContext } from "../../../core/context.ts";
import { createFileLedger } from "../../../core/file-tools.ts";
import { loadConfig } from "../../../config.ts";
import type { ApprovalDecision, ApprovalRequest } from "../../../approval/types.ts";
import type { SandboxMode } from "../../../sandbox/types.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ToolContext } from "../../../tools/registry.ts";

function makeHarness(wsRoot: string) {
  const ledger = createFileLedger();
  const asks: ApprovalRequest[] = [];
  let sandbox: SandboxMode = "workspace-write";
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
    alwaysConfirm: () => false,
    sandboxMode: () => sandbox,
    spillDir: () => undefined,
    privateTempDir: () => undefined,
    mcpStatus: () => [],
    reloadMcp: async () => [],
    ledger,
  };
  toolEditFile.setup(ctx);
  toolReadFile.setup(ctx);
  const edit = ctx.tools.require("edit_file").create(deps);
  const read = ctx.tools.require("read_file").create(deps);
  return {
    edit,
    read,
    asks,
    setSandbox: (m: SandboxMode) => (sandbox = m),
    decide: (d: ApprovalDecision) => (decision = d),
    tctx: (): ToolContext => ({ workspace: { root: wsRoot }, requestApproval: ask, sandboxMode: sandbox }),
    wsRoot,
  };
}

test("edit_file：未读拒绝；read_file 后唯一命中替换成功", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef-")));
  writeFileSync(join(h.wsRoot, "code.ts"), "const a = 1;\nconst b = 2;\n");

  const refused = await h.edit.execute({ path: "code.ts", old_string: "a", new_string: "x" }, h.tctx());
  assert.ok(refused.includes("先 read_file"));

  await h.read.execute({ path: "code.ts" }, h.tctx());
  const out = await h.edit.execute({ path: "code.ts", old_string: "const a = 1;", new_string: "const a = 42;" }, h.tctx());
  assert.ok(out.includes("替换 1 处"));
  assert.ok(readFileSync(join(h.wsRoot, "code.ts"), "utf8").includes("const a = 42;"));
  rmSync(h.wsRoot, { recursive: true, force: true });
});

test("edit_file：CRLF 文件编辑后仍是 CRLF（LF 串可匹配）", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef2-")));
  writeFileSync(join(h.wsRoot, "win.txt"), "line1\r\nline2\r\n");
  await h.read.execute({ path: "win.txt" }, h.tctx());
  const out = await h.edit.execute({ path: "win.txt", old_string: "line1\nline2", new_string: "line1\nedited" }, h.tctx());
  assert.ok(out.includes("替换 1 处"));
  const raw = readFileSync(join(h.wsRoot, "win.txt"), "utf8");
  assert.ok(raw.includes("\r\n") && raw.startsWith("line1\r\nedited\r\n"));
  rmSync(h.wsRoot, { recursive: true, force: true });
});

test("edit_file：多次命中报错要求唯一或 replace_all；未命中/相同串报错", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef3-")));
  writeFileSync(join(h.wsRoot, "m.txt"), "x\nx\nx\n");
  await h.read.execute({ path: "m.txt" }, h.tctx());

  const multi = await h.edit.execute({ path: "m.txt", old_string: "x", new_string: "y" }, h.tctx());
  assert.ok(multi.includes("3 次"));
  const all = await h.edit.execute({ path: "m.txt", old_string: "x", new_string: "y", replace_all: true }, h.tctx());
  assert.ok(all.includes("替换 3 处"));
  assert.equal(readFileSync(join(h.wsRoot, "m.txt"), "utf8"), "y\ny\ny\n");

  const miss = await h.edit.execute({ path: "m.txt", old_string: "zzz", new_string: "q" }, h.tctx());
  assert.ok(miss.includes("不存在"));
  const same = await h.edit.execute({ path: "m.txt", old_string: "y", new_string: "y" }, h.tctx());
  assert.ok(same.includes("相同"));
  rmSync(h.wsRoot, { recursive: true, force: true });
});

test("edit_file：occurrence 指定改第几处（同文多处只改其一）", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef5-")));
  writeFileSync(join(h.wsRoot, "m.txt"), "x\nx\nx\n");
  await h.read.execute({ path: "m.txt" }, h.tctx());

  const second = await h.edit.execute({ path: "m.txt", old_string: "x", new_string: "y", occurrence: 2 }, h.tctx());
  assert.ok(second.includes("替换 1 处"));
  assert.equal(readFileSync(join(h.wsRoot, "m.txt"), "utf8"), "x\ny\nx\n");

  // 编辑后台账已更新：紧接着再改第 1 处无需重读
  const first = await h.edit.execute({ path: "m.txt", old_string: "x", new_string: "z", occurrence: 1 }, h.tctx());
  assert.ok(first.includes("替换 1 处"));
  assert.equal(readFileSync(join(h.wsRoot, "m.txt"), "utf8"), "z\ny\nx\n");

  const over = await h.edit.execute({ path: "m.txt", old_string: "x", new_string: "q", occurrence: 9 }, h.tctx());
  assert.ok(over.includes("超出范围"));
  const conflict = await h.edit.execute(
    { path: "m.txt", old_string: "x", new_string: "q", occurrence: 1, replace_all: true },
    h.tctx(),
  );
  assert.ok(conflict.includes("不能同时使用"));
  rmSync(h.wsRoot, { recursive: true, force: true });
});

test("edit_file：read-only 模式编辑弹审批，拒绝则文件不动", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef4-")));
  writeFileSync(join(h.wsRoot, "r.txt"), "keep\n");
  await h.read.execute({ path: "r.txt" }, h.tctx());
  h.setSandbox("read-only");
  h.decide("rejected");
  const out = await h.edit.execute({ path: "r.txt", old_string: "keep", new_string: "changed" }, h.tctx());
  assert.ok(out.includes("拒绝"));
  assert.equal(readFileSync(join(h.wsRoot, "r.txt"), "utf8"), "keep\n");
  assert.equal(h.asks.length, 1);
  rmSync(h.wsRoot, { recursive: true, force: true });
});

test("edit_file：读取之后文件被外部修改 → 拒绝并引导重读；重读后编辑成功（§5.3 乐观锁）", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef6-")));
  writeFileSync(join(h.wsRoot, "s.txt"), "alpha\nbeta\n");
  await h.read.execute({ path: "s.txt" }, h.tctx());
  writeFileSync(join(h.wsRoot, "s.txt"), "alpha\ngamma\n"); // 读取之后被外部修改

  const refused = await h.edit.execute({ path: "s.txt", old_string: "alpha", new_string: "A" }, h.tctx());
  assert.ok(refused.includes("已被修改"), refused);
  assert.ok(refused.includes("重新 read_file"), "拒绝文案应引导重读");
  assert.equal(readFileSync(join(h.wsRoot, "s.txt"), "utf8"), "alpha\ngamma\n"); // 未基于陈旧基底盲写

  await h.read.execute({ path: "s.txt" }, h.tctx()); // 重读自愈：基于最新内容编辑
  const ok = await h.edit.execute({ path: "s.txt", old_string: "gamma", new_string: "G" }, h.tctx());
  assert.ok(ok.includes("替换 1 处"));
  assert.equal(readFileSync(join(h.wsRoot, "s.txt"), "utf8"), "alpha\nG\n");
  rmSync(h.wsRoot, { recursive: true, force: true });
});

test("edit_file：scope 越界硬拒（不走审批）；scope 内照常（§5.4）", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "ef7-")));
  writeFileSync(join(h.wsRoot, "in-scope.txt"), "x\n");
  writeFileSync(join(h.wsRoot, "near.txt"), "y\n");
  await h.read.execute({ path: "in-scope.txt" }, h.tctx());
  await h.read.execute({ path: "near.txt" }, h.tctx());
  const tctx = { ...h.tctx(), writeScope: ["in-scope.txt"] as string[] };

  const refused = await h.edit.execute({ path: "near.txt", old_string: "y", new_string: "z" }, tctx);
  assert.ok(refused.includes("scope"), refused);
  assert.equal(h.asks.length, 0, "scope 越界是结构性硬拒，不弹卡");
  assert.equal(readFileSync(join(h.wsRoot, "near.txt"), "utf8"), "y\n");

  const ok = await h.edit.execute({ path: "in-scope.txt", old_string: "x", new_string: "X" }, tctx);
  assert.ok(ok.includes("替换 1 处"));
  rmSync(h.wsRoot, { recursive: true, force: true });
});
