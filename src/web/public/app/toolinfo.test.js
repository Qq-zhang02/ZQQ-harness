// toolinfo.test.js（docs/28 P2-3）：工具块展示信息纯逻辑的单测——折叠行摘要（pwsh=
// description、读/写/编辑=动词+文件名）与展开体片段（write 只内容、edit 红绿 diff 与消歧
// 注记、其他/降级=null）。全部纯函数（哨兵锁定禁 DOM）。
import test from "node:test";
import assert from "node:assert/strict";
import { toolHeadline, toolBodyBlocks, isToolResultError } from "./toolinfo.js";

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

test("isToolResultError：「错误：」前缀与 pwsh 非零 exit 判失败；成功/普通输出不误判", () => {
  // 「错误：」前缀 = 全部系统工具/MCP 控制面的错误回传统一形态（文件工具/agent_task 校验/控制工具等）
  assert.equal(isToolResultError("错误：文件不存在：F:/x/y.ts（编辑前先确认路径）"), true);
  assert.equal(isToolResultError("  错误：缺少必填参数 path——提供后重新调用。"), true, "允许前导空白");
  assert.equal(isToolResultError("已写入 F:/x/y.ts（3 行，120 字符，新建）"), false, "成功写入不误判");
  // pwsh exit code：非 0 = 失败（含负数）；0 = 成功；unknown/缺失不按数字判
  assert.equal(isToolResultError("命令输出……\nexit code: 1"), true);
  assert.equal(isToolResultError("exit code: -1073741510"), true, "负数退出码（如 Ctrl+C 中断）= 失败");
  assert.equal(isToolResultError("输出\nexit code: 0"), false);
  assert.equal(isToolResultError("exit code: unknown"), false, "unknown 不是非零数字，不判失败");
  assert.equal(isToolResultError("正常文本提到 exit code: 0 即可"), false);
  // 边界形态
  assert.equal(isToolResultError(""), false);
  assert.equal(isToolResultError(undefined), false);
  assert.equal(isToolResultError(null), false);
  // 修剪注记在头部不影响判定（pruneToolResult 头部保留省略标记时错误行仍在开头附近的情况由前缀/exit 行覆盖）
  assert.equal(isToolResultError("[输出超过 48000 字符已截断……]\nexit code: 2"), true);
});
