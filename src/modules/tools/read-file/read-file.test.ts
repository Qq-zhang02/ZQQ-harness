/**
 * tools.read-file 模块测试：行号输出、offset/limit 续读、空文件/缺失/二进制报错、
 * 台账登记（write/edit 的前置凭据）。模块 setup → ctx.tools 注册 → create 实例化，
 * 与 server 组装同路径；已读台账用真实 Set（与 write-file/edit-file 测试同一构造）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolReadFile } from "./index.ts";
import { buildContext } from "../../../core/context.ts";
import { loadConfig } from "../../../config.ts";
import { createFileLedger, ledgerKey, type FileLedger } from "../../../core/file-tools.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ToolContext } from "../../../tools/registry.ts";

function makeHarness(wsRoot: string) {
  const ledger: FileLedger = createFileLedger();
  const ctx = buildContext(
    { userDir: wsRoot, globalSkillsDir: wsRoot, globalMcpFile: join(wsRoot, "mcp.json"), workspacesFile: join(wsRoot, "w.json"), sessionsDir: join(wsRoot, "s") },
    loadConfig(),
  );
  const deps: SystemToolDeps = {
    ctx,
    workspace: () => ({ root: wsRoot }),
    skills: () => [],
    requestApproval: async () => "allowed-once",
    alwaysConfirm: () => false,
    sandboxMode: () => "workspace-write",
    spillDir: () => undefined,
    privateTempDir: () => undefined,
    mcpStatus: () => [],
    reloadMcp: async () => [],
    ledger,
  };
  const tctx: ToolContext = { workspace: { root: wsRoot }, requestApproval: async () => "allowed-once" };
  return { deps, ledger, tctx };
}

test("read_file：注册、行号输出、offset/limit 续读提示、台账登记", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rf-"));
  const { deps, ledger, tctx } = makeHarness(ws);
  toolReadFile.setup(deps.ctx);
  const tool = deps.ctx.tools.require("read_file").create(deps);

  writeFileSync(join(ws, "a.txt"), "l1\nl2\nl3\nl4\nl5\n");
  const out = await tool.execute({ path: "a.txt" }, tctx);
  assert.ok(out.includes("共 5 行；显示第 1–5 行"));
  assert.ok(out.includes("1\tl1") && out.includes("5\tl5"));

  const part = await tool.execute({ path: "a.txt", offset: 3, limit: 2 }, tctx);
  assert.ok(part.includes("显示第 3–4 行"));
  assert.ok(part.includes("还有后续行"));
  assert.ok(part.includes("3\tl3") && !part.includes("5\tl5"));

  assert.ok((await tool.execute({ path: "a.txt", offset: 99 }, tctx)).includes("超出总行数"));
  assert.ok((await tool.execute({ path: "空.txt" }, tctx)).startsWith("错误"));
  assert.ok((await tool.execute({ path: "  " }, tctx)).startsWith("错误"));

  assert.ok(ledger.wasRead(ledgerKey(join(ws, "a.txt"))));
  rmSync(ws, { recursive: true, force: true });
});

test("read_file：空文件、CRLF 按 LF 显示、二进制拒绝", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rf2-"));
  const { deps, tctx } = makeHarness(ws);
  toolReadFile.setup(deps.ctx);
  const tool = deps.ctx.tools.require("read_file").create(deps);

  writeFileSync(join(ws, "empty.txt"), "");
  assert.ok((await tool.execute({ path: "empty.txt" }, tctx)).includes("空文件"));

  writeFileSync(join(ws, "crlf.txt"), "a\r\nb\r\n");
  const crlf = await tool.execute({ path: "crlf.txt" }, tctx);
  assert.ok(crlf.includes("a\tb") === false && crlf.includes("1\ta\n") && !crlf.includes("\r"));

  writeFileSync(join(ws, "bin.dat"), Buffer.from([0x01, 0x00, 0x02]));
  assert.ok((await tool.execute({ path: "bin.dat" }, tctx)).includes("二进制"));
  rmSync(ws, { recursive: true, force: true });
});
