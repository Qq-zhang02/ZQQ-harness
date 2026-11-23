/**
 * core/progress.ts 单元测试（docs/42）：工具调用与结果配对、成败判定、进展事实提取（路径只认
 * 真实 path——B3 回归：漏传 path 的调用不得把 content 源码当路径）、残局速览格式、限流归类。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../llm/provider.ts";
import { callArgs, progressDigestOf, progressFactsOf, providerLimitOf, toolCallLine, toolEventsOf, toolOk } from "./progress.ts";

const user = (content: string): ChatMessage => ({ role: "user", content });
const say = (content: string): ChatMessage => ({ role: "assistant", content, toolCalls: [] });
const call = (id: string, name: string, args: Record<string, unknown>): ChatMessage => ({ role: "assistant", content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const result = (toolCallId: string, content: string): ChatMessage => ({ role: "tool", toolCallId, content });

test("toolEventsOf：按 toolCallId 配对调用与结果；未回填的调用 result 为 undefined；损坏的 arguments 不抛错", () => {
  const msgs = [
    user("任务书"),
    call("1", "read_file", { path: "a.md" }),
    call("2", "run_pwsh", { command: "python x.py", description: "跑脚本" }),
    result("2", "exit code: 0\n\n[stdout]\nok"),
    result("1", "F:\\ws\\a.md（共 3 行）\n1\thello"),
    call("3", "edit_file", { path: "a.md" }),
  ];
  const ev = toolEventsOf(msgs);
  assert.deepEqual(ev.map((e) => e.call.name), ["read_file", "run_pwsh", "edit_file"]);
  assert.equal(ev[0]!.result, "F:\\ws\\a.md（共 3 行）\n1\thello", "结果按 id 配对，不按出现顺序");
  assert.equal(ev[2]!.result, undefined, "调用发出后被中断：无结果");
  const broken = toolEventsOf([{ role: "assistant", content: null, toolCalls: [{ id: "x", name: "write_file", arguments: "{not json" }] }]);
  assert.deepEqual(callArgs(broken[0]!.call), {}, "损坏 JSON → 空对象");
});

test("toolOk：run_pwsh 只认 exit code: 0（超时/非零/被中断/无结果都算失败）；其余工具以「错误」前缀判失败", () => {
  const ev = (name: string, result?: string) => ({ call: { id: "i", name, arguments: "{}" }, ...(result !== undefined ? { result } : {}) });
  assert.equal(toolOk(ev("run_pwsh", "exit code: 0\n\n[stdout]\nok")), true);
  assert.equal(toolOk(ev("run_pwsh", "exit code: 01")), false, "exit code: 01 不是 0（防前缀误判）");
  assert.equal(toolOk(ev("run_pwsh", "exit code: 1")), false);
  assert.equal(toolOk(ev("run_pwsh", "exit code: unknown（超时被终止：…）")), false);
  assert.equal(toolOk(ev("run_pwsh")), false, "无结果 = 未完成");
  assert.equal(toolOk(ev("write_file", "已写入 F:\\ws\\a.md（3 行，新建）")), true);
  assert.equal(toolOk(ev("write_file", "错误：缺少必填参数 path（…）")), false);
  assert.equal(toolOk(ev("edit_file", "工具执行出错：boom")), false, "注册表兜底文案同算失败");
});

test("progressFactsOf：写入/读取/已看图只列真实 path；漏传 path 的调用绝不回退到 content 源码（B3 回归）", () => {
  const msgs = [
    user("任务书"),
    // 真机实录的脏样本：模型漏传 path，只带了 new_string（源码片段）
    call("1", "edit_file", { old_string: "x", new_string: 'with open(c.TAB / "tab_R1_4_env_spearman", "w")' }),
    result("1", "错误：缺少必填参数 path（要编辑的目标文件路径…）"),
    call("2", "write_file", { path: "results/R1/key_numbers.md", content: "# 关键数字\n" }),
    result("2", "已写入 F:\\ws\\results\\R1\\key_numbers.md（2 行，新建）"),
    call("3", "edit_file", { path: "results/R1/key_numbers.md", old_string: "a", new_string: "b" }),
    result("3", "已编辑 F:\\ws\\results\\R1\\key_numbers.md（替换 1 处；文件现为 2 行）"),
    call("4", "read_file", { path: "work/shared/ztyle.py" }),
    result("4", "F:\\ws\\work\\shared\\ztyle.py（共 10 行）\n1\timport"),
    call("5", "read_image", { path: "results/R2/fig_2.png" }),
    result("5", "[已读取图片 results/R2/fig_2.png] 格式 image/png · 120.0 KB。…"),
    call("6", "run_pwsh", { command: "python 03_beta_div.py", description: "跑 beta 多样性" }),
    result("6", "exit code: 0\n\n[stdout]\nstep1\nstep2"),
    call("7", "run_pwsh", { command: "python 04_env_assembly.py", description: "跑 env assembly" }),
    result("7", "exit code: unknown（超时被终止：已达本次 timeout_ms 上限，进程树 PID 4321 已一并终止；…）"),
    say("04 超时了，先把 05 跑起来。"),
    call("8", "run_pwsh", { command: "python 05_null_model.py", description: "零模型" }),
  ];
  const f = progressFactsOf(msgs);
  assert.deepEqual(f.written, ["results/R1/key_numbers.md"], "同一路径去重；无 path 的调用不入列");
  assert.deepEqual(f.read, ["work/shared/ztyle.py"]);
  assert.deepEqual(f.images, ["results/R2/fig_2.png"]);
  assert.equal(f.done, 7, "已回填 7 个");
  assert.equal(f.calls, 8, "发起 8 个（最后一个未回填）");
  assert.equal(f.lastOkCommand, "python 03_beta_div.py", "最后成功的命令：跳过其后的超时与未完成");
  assert.deepEqual(f.recent, [
    "run_pwsh python 03_beta_div.py",
    "run_pwsh python 04_env_assembly.py（超时）",
    "run_pwsh python 05_null_model.py（未完成——调用发出后被中断）",
  ]);
  assert.equal(f.lastText, "04 超时了，先把 05 跑起来。");
  const digest = progressDigestOf(msgs)!;
  assert.ok(!digest.includes("with open("), `摘要不得混入源码片段：\n${digest}`);
  assert.ok(digest.includes("经文件工具写入 1 个：results/R1/key_numbers.md"), digest);
  assert.ok(digest.includes("最后成功的命令：python 03_beta_div.py"), digest);
  assert.ok(digest.includes("已查看图片 1 张"), digest);
  assert.ok(digest.includes("（发起 8 个，1 个未回填）"), digest);
});

test("progressDigestOf：无任何进展（仅任务书/首轮 LLM 即超时）返回 undefined；只有助手文本时不造统计；超长截 600 字", () => {
  assert.equal(progressDigestOf([user("任务书")]), undefined);
  assert.equal(progressDigestOf([]), undefined);
  const onlyText = progressDigestOf([user("任务书"), say("我先想想怎么下手。")])!;
  assert.ok(onlyText.includes("已完成 0 个工具调用") && onlyText.includes("最后进展：我先想想怎么下手。"), onlyText);
  const long = progressDigestOf([say("长".repeat(1000))])!;
  assert.ok(long.includes("长".repeat(600) + "…（截断）") && !long.includes("长".repeat(601)), long);
});

test("toolCallLine：path 类报路径、run_pwsh 报命令（压成单行截 80）、都没有只报工具名", () => {
  const ev = (name: string, args: Record<string, unknown>) => ({ call: { id: "i", name, arguments: JSON.stringify(args) } });
  assert.equal(toolCallLine(ev("read_file", { path: " a.md " })), "read_file a.md");
  assert.equal(toolCallLine(ev("run_pwsh", { command: "python x.py   --n 999\n --seed 1" })), "run_pwsh python x.py --n 999 --seed 1");
  assert.equal(toolCallLine(ev("run_pwsh", { command: "x".repeat(200) })), `run_pwsh ${"x".repeat(79)}…`, "命令截 80 字（79 + 省略号），前缀工具名不计入");
  assert.equal(toolCallLine(ev("write_file", { content: "绝不当路径" })), "write_file");
  assert.equal(toolCallLine({ call: { id: "i", name: "write_file", arguments: "{broken" } }), "write_file");
});

test("providerLimitOf：速率限制与用量上限各归其类（真机文案）；普通错误不臆测", () => {
  assert.equal(providerLimitOf("已达到速率限制，请您控制请求频率"), "rate");
  assert.equal(providerLimitOf("429 Too Many Requests: Rate limit reached for requests per minute"), "rate");
  assert.equal(providerLimitOf("已达到 5 小时的使用上限，限额将在 18:41:01 重置"), "cap");
  assert.equal(providerLimitOf("Insufficient quota: you exceeded your current quota"), "cap");
  assert.equal(providerLimitOf("子代理超时（300000ms）"), undefined);
  assert.equal(providerLimitOf("网络炸了"), undefined);
  assert.equal(providerLimitOf(undefined), undefined);
});
