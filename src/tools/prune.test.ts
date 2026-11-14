import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneToolResult } from "./prune.ts";
import { ToolRegistry, type Tool, type ToolContext } from "./registry.ts";

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return { workspace: { root: process.cwd() }, requestApproval: async () => "rejected", ...over };
}

test("pruneToolResult：不超预算原样返回（不落盘）", () => {
  const r = pruneToolResult("abc", 100);
  assert.equal(r.text, "abc");
  assert.equal(r.prunedChars, 0);
  assert.equal(r.spilled, undefined);
});

test("pruneToolResult：只保留头部并注明被剪字符数（docs/10 R2）", () => {
  const s = "A".repeat(30_000) + "B".repeat(30_000);
  const r = pruneToolResult(s, 4_000);
  assert.ok(r.text.startsWith("A"));
  assert.ok(!r.text.includes("B"), "尾部不再保留");
  assert.ok(r.text.includes("后文已省略"));
  assert.ok(r.prunedChars > 0);
  // 修剪结果长度在预算附近（标记长度已预留进预算）
  assert.ok(r.text.length <= 4_000 + 8, `输出 ${r.text.length} 应≈预算 4000`);
  // 被剪字符数 = 总量 - 头部保留量（省略标记不计入头部）
  const head = r.text.slice(0, r.text.indexOf("\n[后文已省略"));
  assert.equal(r.prunedChars, 60_000 - head.length);
});

test("pruneToolResult：切点不劈开代理对", () => {
  // 😀 为 2 个 UTF-16 码元（高代理 + 低代理）；让它恰好横跨理论切点
  const s = "x".repeat(995) + "😀".repeat(10) + "y".repeat(995);
  const r = pruneToolResult(s, 1_000);
  for (let i = 0; i < r.text.length; i++) {
    const c = r.text.charCodeAt(i);
    const isLowSurrogate = c >= 0xdc00 && c <= 0xdfff;
    const prevIsHigh = i > 0 && r.text.charCodeAt(i - 1) >= 0xd800 && r.text.charCodeAt(i - 1) <= 0xdbff;
    assert.ok(!isLowSurrogate || prevIsHigh, `位置 ${i} 出现孤立低代理项`);
  }
  // 头部保留的是完整字符
  assert.ok(!/[^\x00-\uffff]/.test(r.text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "").replace(/\n\[后文已省略[^\]]*\]/, "")));
});
test("pruneToolResult：零预算边界（整体丢弃，只留说明）", () => {
  const r0 = pruneToolResult("hello world".repeat(10), 0);
  assert.ok(r0.text.includes("整体丢弃"));
  assert.equal(r0.prunedChars, 110);
  const rNeg = pruneToolResult("hello world".repeat(10), -5);
  assert.ok(rNeg.text.includes("整体丢弃"));
  const rTiny = pruneToolResult("hello world".repeat(10), 10);
  assert.ok(rTiny.text.includes("整体丢弃"));
});

test("pruneToolResult：触发修剪即全文落盘（无门槛，docs/10 R2）——全文可读、附检索提示", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-spill-"));
  try {
    // 小文本（被剪量仅 ~3000 字符，旧语义低于 2 万门槛不落盘；新语义触发即落盘）
    const s = "常量正文行\n".repeat(1_000);
    const r = pruneToolResult(s, 4_000, { dir });
    assert.ok(r.spilled, "触发修剪即应产生 spill 文件（无门槛）");
    assert.ok(r.text.includes("完整输出已存盘"));
    assert.ok(r.text.includes(r.spilled!));
    const full = readFileSync(r.spilled!, "utf8");
    assert.equal(full, s); // 全文保底：存盘内容与原始输出一致
    assert.ok(r.prunedChars > 0 && r.prunedChars < 20_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneToolResult：spill 目录不可写时退回纯头部截断（best-effort 不报错）", () => {
  // 把"目录"指到一个已存在的文件路径上，mkdirSync 必然失败
  const dir = mkdtempSync(join(tmpdir(), "zqq-spill-bad-"));
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x", "utf8");
  try {
    const s = "常量正文行\n".repeat(8_000);
    const r = pruneToolResult(s, 4_000, { dir: blocker });
    assert.equal(r.spilled, undefined);
    assert.ok(r.text.includes("后文已省略"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("注册表层统一修剪：普通工具与 mcp__ 工具超预算都被剪（头部保留），full 保留原文", async () => {
  const bigTool: Tool = {
    name: "mcp__demo__big",
    description: "输出大文本的测试工具",
    parameters: { type: "object", properties: {} },
    execute: async () => "M".repeat(50_000) + "Z".repeat(50_000),
  };
  const r = new ToolRegistry();
  r.register(bigTool);
  const res = await r.executeWithMeta("mcp__demo__big", "{}", makeCtx());
  assert.ok(res.prunedChars > 0);
  assert.ok(res.text.includes("后文已省略"));
  assert.ok(res.text.startsWith("M"));
  assert.ok(!res.text.includes("Z"));
  assert.equal(res.full.length, 100_000); // UI 拿到完整输出
  assert.equal((await r.execute("mcp__demo__big", "{}", makeCtx())).length < 100_000, true); // execute 只取入模型文本
});

test("注册表层修剪：spillDir 透传（executeWithMeta 触发落盘）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-spill-reg-"));
  try {
    const bigTool: Tool = {
      name: "big",
      description: "输出大文本的测试工具",
      parameters: { type: "object", properties: {} },
      execute: async () => "N".repeat(60_000),
    };
    const r = new ToolRegistry();
    r.register(bigTool);
    const res = await r.executeWithMeta("big", "{}", makeCtx({ spillDir: dir }));
    assert.ok(res.spilled);
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
