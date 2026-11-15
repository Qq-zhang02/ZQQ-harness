// toolinfo.test.js（docs/28 P2-3）：工具块展示信息纯逻辑的单测——折叠行摘要（pwsh=
// description、读/写/编辑=动词+文件名）与展开体片段（write 只内容、edit 红绿 diff 与消歧
// 注记、其他/降级=null）。全部纯函数（哨兵锁定禁 DOM）。
import test from "node:test";
import assert from "node:assert/strict";
import { toolHeadline, toolBodyBlocks } from "./toolinfo.js";

/** @param {unknown} o */
const j = (o) => JSON.stringify(o);

test("toolHeadline：run_pwsh 折叠行只显示 description（缺省退 command 首行）", () => {
  assert.equal(toolHeadline("run_pwsh", j({ description: "列出目录", command: "Get-ChildItem -Recurse | Select -First 500" }), "{}"), "列出目录");
  assert.equal(toolHeadline("run_pwsh", j({ command: "npm test 2>&1\nsecond line" }), "preview-fallback"), "npm test 2>&1 second line",
    "无 description 时退 command 首行（firstLine 压空白截 100）");
  assert.equal(toolHeadline("run_pwsh", '{"command": "Get-Child', "残缺 preview 行"), "残缺 preview 行",
    "参数 JSON 被截断不可解析 → 退 fallback preview");
  assert.equal(toolHeadline("run_pwsh", j({ description: "   " }), "无命令 preview"), "无命令 preview",
    "description 为空白不算");
});

test("toolHeadline：读/写/编辑折叠行=动词+文件名（read 带 offset 起始行）", () => {
  assert.equal(toolHeadline("read_file", j({ path: "src/web/server.ts" }), ""), "读取 src/web/server.ts");
  assert.equal(toolHeadline("read_file", j({ path: "big.log", offset: 100, limit: 50 }), ""), "读取 big.log · 第 100 行起");
  assert.equal(toolHeadline("write_file", j({ path: "docs/28 x.md", content: "…" }), ""), "写入 docs/28 x.md");
  assert.equal(toolHeadline("edit_file", j({ path: "a.ts", old_string: "x", new_string: "y" }), ""), "编辑 a.ts");
  assert.equal(toolHeadline("read_file", j({ offset: 5 }), "no-path-preview"), "no-path-preview",
    "缺 path（非法形态）→ 退 fallback");
});

test("toolHeadline：其他工具维持现状（firstLine(fallback)）", () => {
  assert.equal(toolHeadline("mcp__fs__list", j({ dir: "/tmp" }), '{"dir":"F:\\\\ws"}'), '{"dir":"F:\\\\ws"}');
  assert.equal(toolHeadline("view_image", undefined, "看图 参数…"), "看图 参数…");
  assert.equal(toolHeadline("zz_echo", "{}", ""), "");
});

test("toolBodyBlocks：write_file 展开体=注记?+写入内容（不返回参数 JSON 块）", () => {
  assert.deepEqual(toolBodyBlocks("write_file", j({ path: "a.md", content: "正文内容" })), [
    { type: "content", text: "正文内容" },
  ]);
  assert.deepEqual(toolBodyBlocks("write_file", j({ path: "a.md", description: "写文档", content: "正文" })), [
    { type: "note", text: "写文档" },
    { type: "content", text: "正文" },
  ]);
  assert.equal(toolBodyBlocks("write_file", j({ path: "a.md" })), null, "无 content 字段 → null（退参数展示）");
});

test("toolBodyBlocks：edit_file 展开体=diff（old/new 全文）+ 消歧注记", () => {
  assert.deepEqual(toolBodyBlocks("edit_file", j({ path: "a.ts", old_string: "const x = 1;", new_string: "const x = 2;" })), [
    { type: "diff", oldText: "const x = 1;", newText: "const x = 2;" },
  ]);
  assert.deepEqual(
    toolBodyBlocks("edit_file", j({ path: "a.ts", old_string: "x", new_string: "y", occurrence: 2 })),
    [{ type: "diff", oldText: "x", newText: "y", note: "occurrence=2：第 2 处" }],
  );
  assert.deepEqual(
    toolBodyBlocks("edit_file", j({ path: "a.ts", old_string: "x", new_string: "y", replace_all: true })),
    [{ type: "diff", oldText: "x", newText: "y", note: "replace_all：全部替换" }],
  );
  assert.equal(toolBodyBlocks("edit_file", j({ path: "a.ts", old_string: "x" })), null, "缺 new_string → null");
});

test("toolBodyBlocks：其他工具/参数不可解析 → null（调用方走参数 JSON 展示）", () => {
  assert.equal(toolBodyBlocks("read_file", j({ path: "a.ts" })), null);
  assert.equal(toolBodyBlocks("run_pwsh", j({ command: "ls" })), null);
  assert.equal(toolBodyBlocks("write_file", '{"content": "被截断的 JSON…'), null);
  assert.equal(toolBodyBlocks("edit_file", undefined), null);
  assert.equal(toolBodyBlocks("write_file", j([1, 2])), null, "数组形态参数 → null");
});
