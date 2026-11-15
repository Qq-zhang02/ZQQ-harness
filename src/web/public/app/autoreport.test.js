/** autoreport.js 测试（docs/26 F1）：送达前缀参数化拆解 / 摘要提取 / 通用格式化函数。 */
import test from "node:test";
import assert from "node:assert/strict";
import { splitAutoText, autoReportSummary, firstLine, prettyArgs, fmtTok, fmtDur } from "./autoreport.js";

const P = { reportPrefix: "[子代理任务报告 · 自动送达]", statusPrefix: "[子代理状态 · 自动送达]" };

// ---------- splitAutoText：前缀穷举 ----------

test("splitAutoText：前缀缺失（meta 未到）与非字符串输入一律 null（按普通文本渲染）", () => {
  assert.equal(splitAutoText(P.reportPrefix + "x", { reportPrefix: null, statusPrefix: null }), null);
  assert.equal(splitAutoText(P.reportPrefix + "x", {}), null);
  assert.equal(splitAutoText(undefined, P), null);
  assert.equal(splitAutoText(42, P), null);
});

test("splitAutoText：报告前缀命中 → { status:false }；状态前缀命中 → { status:true }", () => {
  assert.deepEqual(splitAutoText(P.reportPrefix + "\n[子代理 w1 完成]", P), { status: false, body: "[子代理 w1 完成]" });
  assert.deepEqual(splitAutoText(P.statusPrefix + "w1 仍在运行", P), { status: true, body: "w1 仍在运行" });
});

test("splitAutoText：仅剥一个前导换行（正文自身的空行保留）", () => {
  const out = splitAutoText(P.reportPrefix + "\n\n正文第二行", P);
  assert.ok(out, "前缀命中应返回拆解体");
  assert.equal(out.body, "\n正文第二行");
});

test("splitAutoText：不匹配任何前缀 → null；报告前缀优先于状态前缀判定", () => {
  assert.equal(splitAutoText("普通用户消息", P), null);
  const both = { reportPrefix: "A", statusPrefix: "AB" };
  assert.deepEqual(splitAutoText("ABx", both), { status: false, body: "Bx" });
});

// ---------- autoReportSummary：摘要行 ----------

test("autoReportSummary：任务报告取正文首行（[子代理 X 完成] 行自带统计）", () => {
  assert.equal(autoReportSummary(P.reportPrefix + "\n[子代理 w1 完成] 统计行\n后续细节", P), "[子代理 w1 完成] 统计行");
});

test("autoReportSummary：状态通知截到首个句读（中文冒号/中文句号/英文冒号；英文句点不是句读）", () => {
  assert.equal(autoReportSummary(P.statusPrefix + "w2 上下文治理：已修剪 30%", P), "w2 上下文治理：");
  assert.equal(autoReportSummary(P.statusPrefix + "已完成。详细", P), "已完成。");
  assert.equal(autoReportSummary(P.statusPrefix + "done: something", P), "done:");
  assert.equal(autoReportSummary(P.statusPrefix + "done. something", P), "done. something");
});

test("autoReportSummary：状态通知无句读且超 60 字 → 截 60 字加省略号", () => {
  const long = "x".repeat(80);
  const out = autoReportSummary(P.statusPrefix + long, P);
  assert.equal(out, "x".repeat(60) + "…");
  const short = autoReportSummary(P.statusPrefix + "x".repeat(30), P);
  assert.equal(short, "x".repeat(30));
});

test("autoReportSummary：meta 缺失时兜底按报告处理（全文首行）", () => {
  assert.equal(autoReportSummary("[子代理 w1 完成] 直接正文", { reportPrefix: null, statusPrefix: null }), "[子代理 w1 完成] 直接正文");
});

// ---------- 通用格式化 ----------

test("firstLine：压缩空白 + 截 100 字", () => {
  assert.equal(firstLine("a\n  b\t\tc"), "a b c");
  assert.equal(firstLine("x".repeat(150)).length, 100);
});

test("prettyArgs：合法 JSON 缩进美化；非法 JSON 原样返回", () => {
  assert.equal(prettyArgs('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyArgs("not json"), "not json");
});

test("fmtTok：<1 万原样；≥1 万 k 化一位小数", () => {
  assert.equal(fmtTok(0), "0");
  assert.equal(fmtTok(9999), "9999");
  assert.equal(fmtTok(10000), "10.0k");
  assert.equal(fmtTok(12345), "12.3k");
});

test("fmtDur：秒/分秒/时分三段与零负值钳制", () => {
  assert.equal(fmtDur(0), "0s");
  assert.equal(fmtDur(-5000), "0s");
  assert.equal(fmtDur(59_400), "59s");
  assert.equal(fmtDur(61_000), "1m01s");
  assert.equal(fmtDur(3_600_000), "1h00m");
  assert.equal(fmtDur(3_661_000), "1h01m");
});
