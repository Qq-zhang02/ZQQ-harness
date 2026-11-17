/**
 * tools.list-files 模块测试（docs/32 协调者只读目录清单）：默认工作区根列举、子目录
 * 参数、目录在前排序与「/」后缀、空目录、越界拒绝、不存在/非目录的错误文案。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLedger } from "../../../core/file-tools.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ToolContext } from "../../../tools/registry.ts";
import { createListFilesTool } from "./list-files.ts";

const tctx: ToolContext = { workspace: { root: "." }, requestApproval: async () => "allowed-once" };

function makeTool(root: string): ReturnType<typeof createListFilesTool> {
  return createListFilesTool({ ledger: createFileLedger(), workspace: () => ({ root }) } as unknown as SystemToolDeps);
}

test("list_files：根列举（目录在前带「/」）、子目录参数、空目录标注", async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-listfiles-"));
  try {
    mkdirSync(join(ws, "sub"));
    mkdirSync(join(ws, "empty"));
    writeFileSync(join(ws, "a.txt"), "");
    writeFileSync(join(ws, "b.md"), "");
    writeFileSync(join(ws, "sub", "c.txt"), "");
    const t = makeTool(ws);
    const root = await t.execute({}, tctx);
    assert.ok(root.includes("目录 （工作区根）：共 4 项"), root);
    assert.ok(root.includes("sub/"), root);
    assert.ok(root.includes("a.txt"), root);
    assert.ok(root.indexOf("sub/") < root.indexOf("a.txt"), "目录排在文件之前");
    const sub = await t.execute({ path: "sub" }, tctx);
    assert.ok(sub.includes("c.txt"), sub);
    assert.ok(sub.includes("目录 sub："), sub);
    const empty = await t.execute({ path: "empty" }, tctx);
    assert.ok(empty.includes("（空目录）"), empty);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("list_files：越界拒绝、不存在、非目录的错误文案", async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-listfiles-"));
  try {
    writeFileSync(join(ws, "a.txt"), "");
    const t = makeTool(ws);
    const out = await t.execute({ path: "../outside" }, tctx);
    assert.ok(out.includes("超出工作区边界"), out);
    assert.ok((await t.execute({ path: "nope" }, tctx)).includes("目录不存在"));
    assert.ok((await t.execute({ path: "a.txt" }, tctx)).includes("不是目录"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
