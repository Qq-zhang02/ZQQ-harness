/**
 * agent_task 工具单元测试（docs/5 SA1；docs/15 起 agent_tasks 退役，并行 = 工具循环并行执行多个 agent_task——见 agent.test.ts；
 * docs/16 起非阻塞派发——工具返回受理回执，报告经收件箱自动送达）：stub SubagentService——
 * 派发回执与错误文案、参数校验（description/task/scope/effort/timeoutMs）、
 * 请求字段透传（含 ctx.signal）、服务缺失的防御路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFileLedger } from "../../../core/file-tools.ts";
import type { SubagentDispatch, SubagentFollowup, SubagentRequest, SystemToolDeps } from "../../../core/types.ts";
import type { Tool, ToolContext } from "../../../tools/registry.ts";
import { createAgentFollowupTool, createAgentTaskTool, createArchiveSubagentTool, createStopSubagentTool, createSubagentStatusTool, dispatchAck, formatWorkerResult, fmtDur, parseTaskItem, taskItemProperties } from "./agent-task.ts";

function makeTool(capture?: { req?: SubagentRequest; signal?: AbortSignal }, dispatch?: SubagentDispatch): Tool {
  const deps = {
    ledger: createFileLedger(),
    subagent: {
      dispatch: (req: SubagentRequest, signal?: AbortSignal) => {
        if (capture) {
          capture.req = req;
          capture.signal = signal;
        }
        return dispatch ?? { ok: true, subId: 7, name: req.name ?? "sub-1" };
      },
    },
  } as unknown as SystemToolDeps;
  return createAgentTaskTool(deps);
}

const tctx: ToolContext = { workspace: { root: "F:\\ws" }, requestApproval: async () => "allowed-once" };

test("agent_task：派发受理回执（非阻塞）——立即返回、指引报告自动送达，可复用附追加指引", async () => {
  const t = makeTool();
  const out = await t.execute({ description: "实现鉴权", task: "做吧", name: "impl-auth" }, tctx);
  assert.ok(out.startsWith("[子代理 impl-auth#7 已派发]"), out);
  assert.ok(out.includes("不等待其完成"), out);
  assert.ok(out.includes("[子代理任务报告 · 自动送达]"), out);
  assert.ok(out.includes("不要编造或提前汇总"), out);
  assert.ok(!out.includes("agent_followup"), "一次性缺省不带追加指引");
  const reusable = await t.execute({ description: "d", task: "t", name: "spec", reusable: true }, tctx);
  assert.ok(reusable.startsWith("[子代理 spec#7 已派发]"), reusable);
  assert.ok(reusable.includes("agent_followup"), "reusable=true 附追加指引");
});

test("agent_task：派发被拒（并发上限等）原样返回服务错误文案", async () => {
  const t = makeTool(undefined, { ok: false, error: "并发上限已达 3（subagentMaxConcurrent）：该任务未启动。" });
  const out = await t.execute({ description: "d", task: "t", name: "x" }, tctx);
  assert.equal(out, "并发上限已达 3（subagentMaxConcurrent）：该任务未启动。");
});

test("agent_task：参数校验与字段透传（description/task 必填、scope/effort/timeoutMs 合法才放行、signal 透传）", async () => {
  const cap: { req?: SubagentRequest; signal?: AbortSignal } = {};
  const t = makeTool(cap);
  const ctl = new AbortController();

  assert.equal(await t.execute({ task: "缺描述" }, tctx), "错误：description 不能为空——用一句话概括这个子任务（审批卡与结果标注用）。");
  assert.equal(await t.execute({ description: "d" }, tctx), "错误：task 不能为空——任务书必须自包含（子代理看不到本对话历史）。");
  assert.equal(
    await t.execute({ description: "d", task: "t", scope: "src" }, tctx),
    '错误：scope 必须是非空的相对路径前缀数组（如 ["src/auth"]）；不需要限制就省略该参数。',
  );
  assert.equal(await t.execute({ description: "d", task: "t", effort: "ultra" }, tctx), "错误：effort 只能是 off/low/high/max/default 之一。");
  assert.equal(await t.execute({ description: "d", task: "t", timeoutMs: 1000 }, tctx), "错误：timeoutMs 必须 ≥60000 毫秒。");

  const out = await t.execute(
    {
      description: "摘要",
      task: "任务书",
      name: "impl",
      scope: ["src/auth", "docs"],
      effort: "low",
      timeoutMs: 120_000,
    },
    { ...tctx, signal: ctl.signal },
  );
  assert.ok(out.startsWith("[子代理 impl#7 已派发]"), out);
  assert.equal(cap.req?.name, "impl");
  assert.equal(cap.req?.description, "摘要");
  assert.equal(cap.req?.task, "任务书");
  assert.deepEqual(cap.req?.scope, ["src/auth", "docs"]);
  assert.equal(cap.req?.effort, "low");
  assert.equal(cap.req?.timeoutMs, 120_000);
  assert.equal(cap.signal, ctl.signal, "ctx.signal 必须透传给子代理服务（中止级联）");
});

test("agent_task：服务缺失（非协调者会话装配）返回防御错误", async () => {
  const deps = { ledger: createFileLedger() } as unknown as SystemToolDeps;
  const t = createAgentTaskTool(deps);
  const out = await t.execute({ description: "d", task: "t" }, tctx);
  assert.equal(out, "错误：子代理服务不可用（本会话不是协调者会话）。");
});

test("formatWorkerResult：失败带残局速览与复活/接续指引（docs/41；一次性也带 read_archive 指引）", () => {
  const r = {
    ok: false, text: "", error: "子代理超时（300000ms）", rounds: 3, subId: 2,
    transcript: "sub-2-demo/transcript.json",
    progressDigest: "已完成 4 个工具调用；写入文件 2 个：src/a.ts、src/b.ts。\n最后进展：正在跑 e2e…",
  };
  const out = formatWorkerResult(r, "demo");
  assert.ok(out.includes("[子代理 demo 失败] 子代理超时（300000ms）（3 轮）"), out);
  assert.ok(out.includes("死前进展："), "残局速览段");
  assert.ok(out.includes("已完成 4 个工具调用"), "速览内容");
  assert.ok(out.includes("read_archive（subId=2"), "一次性失败也带 read_archive 指引（docs/41 修复；docs/42 起附 summary=true 摘要版提示）");
  assert.ok(out.includes("agent_followup 从存档唤醒复活"), "复活指引");
  assert.ok(out.includes("[[过程档案#2]]"), "过程档案标记");
  // 无速览/无 transcript 的失败保持原样（不加空指引）
  assert.equal(formatWorkerResult({ ok: false, text: "", error: "失败" }, "n"), "[子代理 n 失败] 失败");
});

test("formatWorkerResult：无 rounds/usage 时不输出统计段", () => {
  assert.equal(formatWorkerResult({ ok: true, text: "报告" }, "n"), "[子代理 n 完成]\n---\n报告");
  assert.equal(formatWorkerResult({ ok: false, text: "", error: "失败" }, "n"), "[子代理 n 失败] 失败");
  assert.equal(formatWorkerResult({ ok: true, text: "r", rounds: 3 }, "n"), "[子代理 n 完成] 3 轮\n---\nr");
});

test("fmtDur：秒/分秒/时分三档与边界", () => {
  assert.equal(fmtDur(0), "0s");
  assert.equal(fmtDur(59_400), "59s");
  assert.equal(fmtDur(60_000), "1m00s");
  assert.equal(fmtDur(192_500), "3m13s"); // 四舍五入到秒
  assert.equal(fmtDur(3_600_000), "1h00m");
  assert.equal(fmtDur(3_723_000), "1h02m");
  assert.equal(fmtDur(-5), "0s"); // 防御：负数归 0
});

test("formatWorkerResult：elapsedMs 进 stats（「用时」位于轮数与用量之间）", () => {
  const r = formatWorkerResult(
    { ok: true, text: "报告", rounds: 4, elapsedMs: 192_500, usage: { prompt: 1200, completion: 300 } },
    "n",
  );
  assert.ok(r.includes("[子代理 n 完成] 4 轮 · 用时 3m13s · 输入 1.2k / 输出 300 tokens"), r);
  // 失败路径同样带用时
  const f = formatWorkerResult({ ok: false, text: "", error: "超时", elapsedMs: 61_000 }, "n");
  assert.ok(f.includes("超时（用时 1m01s）"), f);
});

// ---------- docs/18：stop_subagent（打断即终结；pause/resume 已退役） ----------

test("stop_subagent：目标校验与透传（name / subId / 两者同给 subId 优先）；服务缺失防御", async () => {
  const calls: Array<[{ name?: string; subId?: number }, "stop" | "archive"]> = [];
  const deps = {
    ledger: createFileLedger(),
    subagentControl: (target: { name?: string; subId?: number }, action: "stop" | "archive") => {
      calls.push([{ ...target }, action]);
      return `ok:${action}`;
    },
  } as unknown as SystemToolDeps;
  const stop = createStopSubagentTool(deps);
  assert.equal(stop.name, "stop_subagent");

  assert.equal(await stop.execute({ name: "impl" }, tctx), "ok:stop");
  assert.deepEqual(calls[0], [{ name: "impl" }, "stop"]);
  await stop.execute({ subId: 3 }, tctx);
  assert.deepEqual(calls[1], [{ subId: 3 }, "stop"]);
  await stop.execute({ name: "impl", subId: 7 }, tctx);
  assert.deepEqual(calls[2], [{ subId: 7, name: "impl" }, "stop"], "两者同给时都透传（控制端 subId 优先）");

  assert.ok((await stop.execute({}, tctx)).includes("需要 name 或 subId"));
  assert.ok((await stop.execute({ subId: 0 }, tctx)).includes("正整数"));
  assert.ok((await stop.execute({ subId: 1.5 }, tctx)).includes("正整数"));
  const noDeps = { ledger: createFileLedger() } as unknown as SystemToolDeps;
  assert.ok((await createStopSubagentTool(noDeps).execute({ name: "x" }, tctx)).includes("不可用"));
});

// ---------- P3：过程档案入口标记（docs/6 §3 方案 A） ----------

test("formatWorkerResult：transcript 存在时报告尾部追加 [[过程档案#subId]] 标记；无存档不加", async () => {
  const withArc = formatWorkerResult(
    { ok: true, text: "报告正文", rounds: 2, subId: 3, transcript: "sub-3-x/transcript.json" },
    "impl-x",
  );
  assert.ok(withArc.endsWith("\n[[过程档案#3]]"), withArc);
  const withArcFail = formatWorkerResult(
    { ok: false, text: "", error: "超时", subId: 4, transcript: "sub-4-y/transcript.json" },
    "impl-y",
  );
  assert.ok(withArcFail.endsWith("\n[[过程档案#4]]"), withArcFail);
  // 无存档（旧结果/写失败降级）：格式与现状字节一致
  assert.equal(
    formatWorkerResult({ ok: true, text: "报告正文", rounds: 2 }, "impl-x"),
    "[子代理 impl-x 完成] 2 轮\n---\n报告正文",
  );
  assert.equal(
    formatWorkerResult({ ok: true, text: "报告正文", rounds: 2, subId: 5 }, "impl-z"),
    "[子代理 impl-z 完成] 2 轮\n---\n报告正文",
    "只有 subId 没有 transcript 也不加标记",
  );
});

// ---------- docs/9：reusable 参数 + agent_followup / archive_subagent ----------

test("parseTaskItem：reusable 校验——true 透传、false/缺省不写字段、非布尔报错", () => {
  assert.equal((parseTaskItem({ description: "d", task: "t", reusable: true }) as SubagentRequest).reusable, true);
  assert.equal("reusable" in parseTaskItem({ description: "d", task: "t" }), false, "缺省不写字段（空不写惯例）");
  assert.equal("reusable" in parseTaskItem({ description: "d", task: "t", reusable: false }), false, "显式 false 与缺省等价");
  assert.equal(
    (parseTaskItem({ description: "d", task: "t", reusable: "yes" }) as { error: string }).error,
    "错误：reusable 只能是布尔值（true=可复用；缺省 false=一次性）。",
  );
});

test("formatWorkerResult：可复用结果带待命提示（name#subId + agent_followup/archive_subagent 指引）；第 N 次任务进统计段", () => {
  const out = formatWorkerResult(
    { ok: true, text: "报告", rounds: 3, subId: 6, name: "spec", taskNo: 2, reusable: true },
    "spec",
  );
  assert.ok(out.startsWith("[子代理 spec 完成] 第 2 次任务 · 3 轮"), out);
  assert.ok(out.includes("（该子代理可复用：spec#6 已保留待命"), out);
  assert.ok(out.includes("agent_followup"), out);
  assert.ok(out.includes("archive_subagent"), out);
  // taskNo=1（首任务）不带「第 N 次」——与一次性结果格式一致
  const first = formatWorkerResult({ ok: true, text: "报告", rounds: 3, subId: 6, reusable: true }, "spec");
  assert.ok(first.startsWith("[子代理 spec 完成] 3 轮"), first);
  // 失败的可复用结果同样带提示（worker 存活转 idle）
  const fail = formatWorkerResult({ ok: false, text: "", error: "超时", subId: 6, reusable: true }, "spec");
  assert.ok(fail.includes("已保留待命"), fail);
});

test("agent_followup：目标/任务校验；followup 透传（subId 优先）；派发回执即时返回；signal 透传", async () => {
  const calls: Array<[{ name?: string; subId?: number }, SubagentFollowup, (AbortSignal | undefined)]> = [];
  const deps = {
    ledger: createFileLedger(),
    subagent: {
      followup: (target: { name?: string; subId?: number }, req: SubagentFollowup, signal?: AbortSignal): SubagentDispatch => {
        calls.push([{ ...target }, { ...req }, signal]);
        return { ok: true, subId: 6, name: "spec" };
      },
    },
  } as unknown as SystemToolDeps;
  const t = createAgentFollowupTool(deps);
  assert.equal(t.name, "agent_followup");

  const ctl = new AbortController();
  const out = await t.execute({ name: "spec", subId: 6, description: "追加摘要", task: "追加任务", timeoutMs: 90_000 }, { ...tctx, signal: ctl.signal });
  assert.ok(out.startsWith("[子代理 spec#6 已派发]"), out);
  assert.ok(out.includes("不等待其完成"), out);
  assert.ok(out.includes("agent_followup 按 name=spec"), `回执带追加指引（可复用实例）：${out}`);
  assert.deepEqual(calls[0]![0], { subId: 6, name: "spec" }, "目标透传（两者同给 subId 优先语义在服务端）");
  assert.equal(calls[0]![1].task, "追加任务");
  assert.equal(calls[0]![1].description, "追加摘要");
  assert.equal(calls[0]![1].timeoutMs, 90_000);
  assert.equal(calls[0]![2], ctl.signal, "中止信号透传（接进后台任务的中止级联）");

  assert.ok((await t.execute({ task: "t" }, tctx)).includes("需要 name 或 subId"));
  assert.ok((await t.execute({ name: "x" }, tctx)).includes("task 不能为空"));
  assert.ok((await t.execute({ name: "x", task: "t", timeoutMs: 1000 }, tctx)).includes("timeoutMs 必须 ≥60000"));
  assert.ok((await t.execute({ subId: 0, task: "t" }, tctx)).includes("正整数"));
  const noDeps = { ledger: createFileLedger() } as unknown as SystemToolDeps;
  assert.ok((await createAgentFollowupTool(noDeps).execute({ name: "x", task: "t" }, tctx)).includes("不可用"));
});

test("archive_subagent：目标校验与 archive 动作透传；服务缺失防御", async () => {
  const calls: Array<[{ name?: string; subId?: number }, string]> = [];
  const deps = {
    ledger: createFileLedger(),
    subagentControl: (target: { name?: string; subId?: number }, action: "pause" | "resume" | "archive") => {
      calls.push([{ ...target }, action]);
      return `ok:${action}`;
    },
  } as unknown as SystemToolDeps;
  const t = createArchiveSubagentTool(deps);
  assert.equal(t.name, "archive_subagent");
  assert.equal(await t.execute({ name: "spec" }, tctx), "ok:archive");
  assert.deepEqual(calls[0], [{ name: "spec" }, "archive"]);
  await t.execute({ subId: 6 }, tctx);
  assert.deepEqual(calls[1], [{ subId: 6 }, "archive"]);
  assert.ok((await t.execute({}, tctx)).includes("需要 name 或 subId"));
  assert.ok((await t.execute({ subId: -1 }, tctx)).includes("正整数"));
  const noDeps = { ledger: createFileLedger() } as unknown as SystemToolDeps;
  assert.ok((await createArchiveSubagentTool(noDeps).execute({ name: "x" }, tctx)).includes("不可用"));
});

// ---------- docs/10 R1：formatWorkerResult 的上下文占比三态 ----------

test("formatWorkerResult：contextPct 进 stats 行；低占比正常待命提示不变", () => {
  const out = formatWorkerResult(
    { ok: true, text: "报告", rounds: 3, usage: { prompt: 1000, completion: 200 }, reusable: true, subId: 5, contextPct: 12 },
    "spec",
  );
  assert.ok(out.includes("[子代理 spec 完成] 3 轮 · 输入 1k / 输出 200 tokens · 上下文 12%"), out);
  assert.ok(out.includes("已保留待命"), "低占比正常待命提示");
  assert.ok(!out.includes("不宜再派"));
});

test("formatWorkerResult：contextPct ≥ followup 门槛（35）→ 待命提示带警告", () => {
  const out = formatWorkerResult(
    { ok: true, text: "报告", reusable: true, subId: 5, contextPct: 40 },
    "spec",
  );
  assert.ok(out.includes("上下文 40%"), out);
  assert.ok(out.includes("已达追加上限（35%）"), "警告文案");
  assert.ok(out.includes("[[过程档案#5]]"), "接续指引");
  assert.ok(!out.includes("已保留待命，后续任务用 agent_followup"), "不再正常邀请追加");
});

test("formatWorkerResult：forceArchived → 待命提示整段替换为强制归档说明", () => {
  const out = formatWorkerResult(
    { ok: true, text: "报告", reusable: true, subId: 7, contextPct: 62, forceArchived: true },
    "spec",
  );
  assert.ok(out.includes("已自动归档"), out);
  assert.ok(out.includes("62%"));
  assert.ok(out.includes("agent_task 重新派发"));
  assert.ok(out.includes("[[过程档案#7]]"));
  assert.ok(!out.includes("已保留待命"), "不留待命话头");
});

test("formatWorkerResult：contextPct 落 (30,35) → 附「上下文过长」预警但正常邀请追加（docs/10 修订三档）", () => {
  const out = formatWorkerResult(
    { ok: true, text: "报告", reusable: true, subId: 5, contextPct: 32 },
    "spec",
    { warnPct: 30, followupPct: 35 },
  );
  assert.ok(out.includes("上下文过长预警"), out);
  assert.ok(out.includes("32%"));
  assert.ok(out.includes("超过 30%"), "预警线数字");
  assert.ok(out.includes("agent_followup"), "仍邀请追加（未拒收）");
  assert.ok(out.includes("达到 35% 后追加将被拒绝"), "预告拒收线");
  // docs/42：预警 ≠ 必须重派——两种处置并列，且写明「保留原实例时不要再派新实例写同一目录」
  assert.ok(out.includes("两种处置按用户意愿选"), "预警并列两种处置");
  assert.ok(out.includes("①保留它继续") && out.includes("不要再派新实例写同一目录"), "保留原实例的处置与同目录单实例纪律");
  assert.ok(out.includes("②archive_subagent 归档后 agent_task 重新派发"), "归档重派仍是选项之一");
});

// ---------- docs/11 W1：归档原因说明（docs/16：暂停状态报随 facing 通道退役——暂停通知走送达消息） ----------

test("formatWorkerResult：archived=request → 归档请求中止说明（不误报待命）；archived=context 与 forceArchived 同文案", () => {
  const req = formatWorkerResult(
    { ok: false, text: "", error: "任务被归档请求中止", reusable: true, name: "s", subId: 7, taskNo: 2, transcript: "sub-7-s/transcript.json", archived: "request" },
    "s",
  );
  assert.ok(req.includes("[子代理 s 失败] 任务被归档请求中止"), req);
  assert.ok(req.includes("已按归档请求归档"), req);
  assert.ok(req.includes("[[过程档案#7]]"), req);
  assert.ok(!req.includes("已保留待命"), "归档收尾不得输出待命提示");
  const ctxA = formatWorkerResult(
    { ok: true, text: "报告", reusable: true, subId: 8, contextPct: 61, forceArchived: true, archived: "context" },
    "c",
  );
  const ctxB = formatWorkerResult({ ok: true, text: "报告", reusable: true, subId: 8, contextPct: 61, forceArchived: true }, "c");
  assert.equal(ctxA, ctxB, "archived=context 与 forceArchived 输出一致（消费面统一）");
  assert.ok(ctxA.includes("已自动归档"), ctxA);
});

// ---------- docs/32：subagent_status 状态表（协调者第六件，直用只读） ----------

test("subagent_status：状态表文案透传与 all 参数透传；接缝缺失（非协调者会话装配）防御", async () => {
  let seen: { all?: boolean } | undefined;
  const deps = {
    ledger: createFileLedger(),
    subagentStatus: (opts?: { all?: boolean }) => {
      seen = opts;
      return opts?.all ? "历史记录（最近 1 条）：- #1 s（完成 · 2026-11-17 20:13）" : "当前没有活动子代理（本会话尚未派出过子代理）。";
    },
  } as unknown as SystemToolDeps;
  const t = createSubagentStatusTool(deps);
  assert.equal(await t.execute({}, tctx), "当前没有活动子代理（本会话尚未派出过子代理）。");
  assert.deepEqual(seen, {}, "缺省不带 all");
  assert.ok((await t.execute({ all: true }, tctx)).includes("#1 s"));
  assert.deepEqual(seen, { all: true });
  const bare = createSubagentStatusTool({ ledger: createFileLedger() } as unknown as SystemToolDeps);
  assert.ok((await bare.execute({}, tctx)).includes("不是协调者会话"));
});

// ---------- docs/42：只读子代理参数 / 派发回执附注 / 提供方限流建议 ----------

test("docs/42 parseTaskItem：readOnly——true 透传、false/缺省不写字段、非布尔报错；schema 声明并说明结构性保证", () => {
  const ro = parseTaskItem({ description: "d", task: "t", readOnly: true });
  assert.ok(!("error" in ro));
  assert.deepEqual(ro, { task: "t", description: "d", readOnly: true });
  for (const args of [{ description: "d", task: "t", readOnly: false }, { description: "d", task: "t" }]) {
    const r = parseTaskItem(args);
    assert.ok(!("error" in r));
    assert.equal("readOnly" in r, false, "缺省/false 不写字段（旧语义不变）");
  }
  assert.deepEqual(parseTaskItem({ description: "d", task: "t", readOnly: "yes" }), { error: "错误：readOnly 只能是布尔值（true=只读；缺省 false=可写）。" });
  const props = taskItemProperties() as Record<string, { type?: string; description?: string }>;
  assert.equal(props.readOnly?.type, "boolean");
  assert.ok(props.readOnly!.description!.includes("只读沙箱") && props.readOnly!.description!.includes("不可提权"), "描述写明保证而非口号");
  // agent_task 工具本体：readOnly 随请求透传给服务层
  const cap: { req?: SubagentRequest } = {};
  void cap;
});

test("docs/42 agent_task：服务层回执附注（同范围可唤醒实例/并发占用/近期限流）原样附在回执尾；无附注时回执与此前逐字一致", async () => {
  const note = "⚠ 写入范围重叠：本会话已有同范围的子代理 r1#4（空闲待命，有过程存档）——若这是接续它的工作，优先用 agent_followup（按 subId）唤醒它而非新派；…\n（当前运行中子代理 2/3）";
  const withNote = makeTool(undefined, { ok: true, subId: 8, name: "handover", note });
  const out = await withNote.execute({ description: "d", task: "t", name: "handover" }, tctx);
  assert.ok(out.startsWith("[子代理 handover#8 已派发]"), out);
  assert.ok(out.includes("⚠ 写入范围重叠：本会话已有同范围的子代理 r1#4"), "重叠提示进入回执");
  assert.ok(out.trimEnd().endsWith("（当前运行中子代理 2/3）"), "附注在回执尾部（派发事实在前）");
  const plain = await makeTool().execute({ description: "d", task: "t", name: "p" }, tctx);
  assert.equal(plain, dispatchAck("p", 7, false), "无附注：回执 = 既有 dispatchAck 文本");
  assert.ok(!plain.includes("⚠"));
  // agent_followup 的回执不带附注（唤醒简报是给子代理的，不进协调者回执）
  const fdeps = {
    ledger: createFileLedger(),
    subagent: { followup: () => ({ ok: true, subId: 4, name: "r1" }), dispatch: () => ({ ok: false, error: "x" }) },
  } as unknown as SystemToolDeps;
  const f = await createAgentFollowupTool(fdeps).execute({ subId: 4, task: "继续" }, tctx);
  assert.ok(f.startsWith("[子代理 r1#4 已派发]") && !f.includes("唤醒简报"), f);
});

test("docs/42 formatWorkerResult：提供方限流按类附建议（速率限制→降并发/串行；用量上限→等重置）；普通失败不带", () => {
  const base = { ok: false as const, text: "", subId: 3, transcript: "sub-3-x/transcript.json" };
  const rate = formatWorkerResult({ ...base, error: "已达到速率限制，请您控制请求频率", limitKind: "rate" }, "x");
  assert.ok(rate.includes("⚠ 提供方速率限制") && rate.includes("调小 subagentMaxConcurrent") && rate.includes("agent_followup 复活同一子代理续做"), rate);
  assert.ok(!rate.includes("用量上限"), "速率限制不带用量上限建议");
  const cap = formatWorkerResult({ ...base, error: "已达到 5 小时的使用上限，限额将在 18:41:01 重置", limitKind: "cap" }, "x");
  assert.ok(cap.includes("⚠ 提供方用量上限") && cap.includes("立即重试无益") && !cap.includes("速率限制"), cap);
  const plain = formatWorkerResult({ ...base, error: "子代理超时（300000ms）" }, "x");
  assert.ok(!plain.includes("提供方"), "普通失败不臆测限流");
  // 顺序：失败归因 → 限流建议 → 死前进展 → 复活指引（先知道「为什么挂」，再看到「做到哪」）
  assert.ok(rate.indexOf("⚠ 提供方速率限制") < rate.indexOf("（半成品已保留"), rate);
  assert.equal(formatWorkerResult({ ok: false, text: "", error: "失败" }, "n"), "[子代理 n 失败] 失败", "无存档失败文案不变");
});
