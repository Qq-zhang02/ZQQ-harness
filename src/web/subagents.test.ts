/**
 * runWorker / subagentServiceFor 单元测试（docs/5 SA1 + SA3 冲突专项；docs/16 非阻塞派发）：
 * worker 运行机制——完整工具循环（多轮/最终报告/轮数）、用量聚合进父会话 totals、
 * 审批 [子代理] 标注 + subagent 字段、失败一律 ok:false、系统提示构成（base/职责段/
 * req.system/工具行/AGENTS.md、无 agent_task）、effort 继承与覆盖、报告超预算修剪、
 * timeoutMs 超时；SA3：并发/累计配额（同步回执拒绝，不排队）、scope 透传进 worker 工具
 * 上下文、abort 级联、双 worker 审批串行（同时至多一张卡）。
 * SA4：SSE subagent 生命周期事件（spawned→done/error 载荷、配额拒绝不发）与
 * rt.subagents 审计记录（成功/失败都记录、被拒不记录）。
 * docs/16：dispatch/followup 同步受理回执；任务结算（完成/失败/暂停后恢复完成/归档中止）
 * 一律经收件箱自动送达（测试直调场景消息留在 rt.inbox 供断言）；轮末排空的相邻报告合并。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../core/context.ts";
import { loadConfig } from "../config.ts";
import { createFileLedger } from "../core/file-tools.ts";
import { SUBAGENT_MAX_CONCURRENT, SUBAGENT_MAX_TASKS, SUBAGENT_MAX_TOTAL } from "../config.ts";
import { toolAgentTask } from "../modules/tools/agent-task/index.ts";
import { McpManager } from "../mcp/manager.ts";
import type { McpTransportDef, SystemToolDef } from "../core/types.ts";
import type { ChatParams, ChatResult, LLMProvider } from "../llm/provider.ts";
import type { SessionRuntime } from "../core/host.ts";
import { SessionStore } from "./sessions.ts";
import { AttachmentStore } from "./attachments.ts";
import { runWorker, subagentServiceFor, applySubagentControl, archiveSourceOf, subagentStatusText, WORKER_ROLE_SECTION } from "./subagents.ts";
import { makeWorkerUi } from "./subagent-worker.ts";
import { TOOL_EVENT_ARGS_MAX_CHARS } from "../config.ts";
import type { WorkerSession } from "./subagent-records.ts";
import { isAutoReport, takeCoordinatorTurnText } from "./session-lifecycle.ts";
import type { SessionShell } from "./session-runtime.ts";

/** 脚本化提供方：按序吐 ChatResult；记录每次请求参数（messages/effort/signal）。 */
class ScriptProvider implements LLMProvider {
  readonly name = "script";
  calls: ChatParams[] = [];
  private script: ChatResult[];
  private i = 0;
  constructor(script: ChatResult[]) {
    this.script = script;
  }
  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    const r = this.script[this.i] ?? { content: "(脚本耗尽)", toolCalls: [], usage: null };
    this.i++;
    if (r.content && params.onTextDelta) params.onTextDelta(r.content);
    return r;
  }
}

const toolRound = (id: string, args = "{}"): ChatResult => ({
  content: "",
  toolCalls: [{ id, name: "zz_echo", arguments: args }],
  usage: null,
});

/** docs/11 W1：等协调者收件箱出现 n 条消息（deliverToCoordinator 在测试直调场景无
 *  sessionHost/未登记 runtimes → 只入队不开轮，消息留在 rt.inbox 供断言）。超时返回已有内容。 */
async function waitForInbox(rt: SessionRuntime, n = 1, ms = 1000): Promise<string[]> {
  for (let i = 0; i < ms / 5 && (rt.inbox?.length ?? 0) < n; i++) await sleep(5);
  return rt.inbox ?? [];
}

/** 桩 worker 工具：回显参数；approval 变体触发一次审批并回传决议；scope 变体捕获 ctx.writeScope。 */
function echoToolDef(capture?: string[], approvalSink?: string[], scopeSink?: (string[] | undefined)[]): SystemToolDef {
  return {
    name: "zz_echo",
    summary: "测试回显工具",
    create: () => ({
      name: "zz_echo",
      description: "测试",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: [] },
      async execute(args, ctx) {
        capture?.push(String(args.value ?? ""));
        if (scopeSink) scopeSink.push(ctx.writeScope);
        if (approvalSink) {
          const d = await ctx.requestApproval({ toolName: "zz_echo", command: `run ${String(args.value ?? "")}`, reasons: [] });
          approvalSink.push(d);
          return `decision:${d}`;
        }
        return `echo:${String(args.value ?? "")}`;
      },
    }),
  };
}

interface Harness {
  sh: SessionShell;
  rt: SessionRuntime;
  broadcasts: { event: string; data: unknown }[];
  toolCalls: string[];
}

/** 最小壳 + 假会话：runWorker 只消费这些面。 */
function makeHarness(
  script: ChatResult[],
  opts?: { approval?: boolean; approvalSink?: string[]; scopeSink?: (string[] | undefined)[]; llm?: LLMProvider; contextLength?: number },
): Harness {
  const userDir = mkdtempSync(join(tmpdir(), "zqq-suba-u-"));
  writeFileSync(join(userDir, "AGENTS.md"), "全局规则：保持谨慎。\n", "utf8");
  const ctx = buildContext(
    {
      userDir,
      globalSkillsDir: join(userDir, "skills"),
      globalMcpFile: join(userDir, "mcp.json"),
      workspacesFile: join(userDir, "workspaces.json"),
      sessionsDir: join(userDir, "sessions"),
    },
    loadConfig(),
  );
  const toolCalls: string[] = [];
  ctx.tools.register(echoToolDef(toolCalls, opts?.approval ? opts.approvalSink : undefined, opts?.scopeSink));
  toolAgentTask.setup(ctx); // audience=coordinator：worker registry 必须把它过滤掉
  const broadcasts: { event: string; data: unknown }[] = [];
  const sh: SessionShell = {
    ctx,
    sessions: new SessionStore(userDir),
    attachments: new AttachmentStore(userDir), // docs/33
    providerFile: {
      path: "",
      data: {
        active: "",
        // docs/10 R1：提供 contextLength 时给出可解析的提供方（contextPctOf 消费）；缺省空数组
        providers:
          opts?.contextLength !== undefined
            ? [{
                id: "p", name: "P", format: "openai", baseUrl: "http://x", apiKey: "k", model: "m",
                effort: "high" as const, contextLength: opts.contextLength, maxTokens: null,
              }]
            : [],
      },
    },
    runtimes: new Map(),
    viewId: "",
    viewSeq: 0,
    recentWorkspaces: [],
    workspacesFile: join(userDir, "workspaces.json"),
    userDir,
    globalMcpFile: join(userDir, "mcp.json"),
    sandboxTmpRoot: join(userDir, "tmp"),
    broadcast: (event, data) => broadcasts.push({ event, data }),
  };
  const rt = {
    id: "0e0d8f8a-aaaa-4bbb-8ccc-dddddddddddd",
    workspace: { root: userDir },
    kind: "normal",
    llm: opts?.llm ?? new ScriptProvider(script),
    settings: { alwaysConfirm: false, effort: "high", askMode: "ask", sandboxMode: "workspace-write" },
    totals: { prompt: 0, completion: 0, cacheHit: 0, reasoning: 0, breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 } },
    auditEvents: [],
    mcp: { status: () => [] },
    fileLedger: createFileLedger(),
    pendingApproval: null,
    workers: new Set(),
    subagentTotal: 0,
    subagents: [],
    activeSubagents: new Map(),
    agent: { contextEstimate: () => ({ total: 0, breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 } }) },
  } as unknown as SessionRuntime;
  return { sh, rt, broadcasts, toolCalls };
}

test("runWorker：完整工具循环——多轮工具调用、报告提取、轮数、工具走 worker 自己的注册表", async () => {
  const h = makeHarness([
    toolRound("c1", '{"value":"a"}'),
    toolRound("c2", '{"value":"b"}'),
    { content: "  最终报告：完成  ", toolCalls: [], usage: null },
  ]);
  const r = await runWorker(h.sh, h.rt, { task: "干活" }, { seq: 1 });
  assert.ok(r.ok);
  assert.equal(r.text, "最终报告：完成");
  assert.equal(r.rounds, 3);
  assert.deepEqual(h.toolCalls, ["a", "b"]); // 两次工具调用都在 worker 独立上下文里执行
});

test("runWorker：用量聚合——worker 全程 usage 一次计入父会话 totals（差额归 other）", async () => {
  const h = makeHarness([
    { content: "", toolCalls: [toolRound("c1").toolCalls[0]!], usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 5 } },
    { content: "报告", toolCalls: [], usage: { promptTokens: 50, completionTokens: 10, cacheHitTokens: 8 } },
  ]);
  const r = await runWorker(h.sh, h.rt, { task: "t" }, { seq: 1 });
  assert.ok(r.ok);
  assert.deepEqual(r.usage, { prompt: 150, completion: 30, reasoning: 5, cacheHit: 8 });
  assert.equal(h.rt.totals.prompt, 150); // 一次汇总进父会话
  assert.equal(h.rt.totals.completion, 30);
  assert.equal(h.rt.totals.reasoning, 5);
  assert.equal(h.rt.totals.cacheHit, 8);
  const usageEvents = h.broadcasts.filter((b) => b.event === "usage");
  assert.equal(usageEvents.length, 1, "worker 过程不推 usage，只在结束时汇总一次");
  const call = usageEvents[0]!.data as { call: { breakdown: { other: number } } };
  assert.equal(call.call.breakdown.other, 150); // 分类明细随 worker 历史消亡，差额归 other
});

test("runWorker：审批路由到父会话并带 [子代理 name] 标注", async () => {
  const decisions: string[] = [];
  const h = makeHarness(
    [toolRound("c1", '{"value":"x"}'), { content: "done", toolCalls: [], usage: null }],
    { approval: true, approvalSink: decisions },
  );
  const p = runWorker(h.sh, h.rt, { task: "t", name: "impl-auth" }, { seq: 1 });
  // 等审批卡挂上父会话单槽（worker 工具触发）
  for (let i = 0; i < 100 && h.rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.rt.pendingApproval, "审批应挂到父会话 pendingApproval");
  const approvalEvents = h.broadcasts.filter((b) => b.event === "approval");
  const req = approvalEvents[0]!.data as { command: string; subagent?: string };
  assert.ok(req.command.startsWith("[子代理 impl-auth] "), `命令应带来源标注：${req.command}`);
  assert.equal(req.subagent, "impl-auth", "ApprovalRequest.subagent 字段标注来源（前端卡片展示用）");
  h.rt.pendingApproval!("allowed-once");
  const r = await p;
  assert.ok(r.ok);
  assert.deepEqual(decisions, ["allowed-once"]); // 决议正常回流 worker
});

test("subagentServiceFor：缺省名自动编号 sub-1/sub-2（服务实例内计数）", async () => {
  const names: string[] = [];
  const userDir = mkdtempSync(join(tmpdir(), "zqq-suba-n-"));
  const ctx = buildContext(
    {
      userDir,
      globalSkillsDir: join(userDir, "skills"),
      globalMcpFile: join(userDir, "mcp.json"),
      workspacesFile: join(userDir, "workspaces.json"),
      sessionsDir: join(userDir, "sessions"),
    },
    loadConfig(),
  );
  const sink: string[] = [];
  ctx.tools.register(echoToolDef(undefined, sink));
  const broadcasts: { event: string; data: unknown }[] = [];
  const sh = {
    ctx,
    sessions: new SessionStore(userDir),
    providerFile: { path: "", data: { active: "", providers: [] } },
    runtimes: new Map(),
    viewId: "",
    viewSeq: 0,
    recentWorkspaces: [],
    workspacesFile: join(userDir, "workspaces.json"),
    userDir,
    globalMcpFile: join(userDir, "mcp.json"),
    sandboxTmpRoot: join(userDir, "tmp"),
    broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
  } as unknown as SessionShell;
  const rt = {
    id: "0e0d8f8a-bbbb-4bbb-8ccc-dddddddddddd",
    workspace: { root: userDir },
    kind: "normal",
    llm: new ScriptProvider([
      toolRound("c1", '{"value":"1"}'),
      { content: "ok", toolCalls: [], usage: null },
      toolRound("c2", '{"value":"2"}'),
      { content: "ok", toolCalls: [], usage: null },
    ]),
    settings: { alwaysConfirm: false, effort: "high", askMode: "ask", sandboxMode: "workspace-write" },
    totals: { prompt: 0, completion: 0, cacheHit: 0, reasoning: 0, breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 } },
    auditEvents: [],
    mcp: { status: () => [] },
    fileLedger: createFileLedger(),
    pendingApproval: null,
    workers: new Set(),
    subagentTotal: 0,
    subagents: [],
    activeSubagents: new Map(),
    agent: { contextEstimate: () => ({ total: 0, breakdown: {} }) },
  } as unknown as SessionRuntime;
  const svc = subagentServiceFor(sh, rt);
  const d1 = svc.dispatch({ task: "t1", description: "d" });
  assert.ok(d1.ok && d1.name === "sub-1", "首个派发自动编号 sub-1");
  for (let i = 0; i < 100 && rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
  names.push(String((broadcasts.find((b) => b.event === "approval")!.data as { command: string }).command));
  rt.pendingApproval!("allowed-once");
  await waitForInbox(rt); // 等首个任务结算（报告送达 = 收尾完成的标记）
  const d2 = svc.dispatch({ task: "t2", description: "d" });
  assert.ok(d2.ok && d2.name === "sub-2");
  for (let i = 0; i < 100 && rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
  names.push(String((broadcasts.filter((b) => b.event === "approval")[1]!.data as { command: string }).command));
  rt.pendingApproval!("rejected");
  await waitForInbox(rt, 2);
  assert.deepEqual(names, ["[子代理 sub-1] run 1", "[子代理 sub-2] run 2"]);
});

test("runWorker：失败一律 ok:false——提供方抛错与空回复", async () => {
  const boom: LLMProvider = {
    name: "boom",
    chat: async () => {
      throw new Error("网络炸了");
    },
  };
  const h1 = makeHarness([]);
  (h1.rt as unknown as { llm: LLMProvider }).llm = boom;
  const r1 = await runWorker(h1.sh, h1.rt, { task: "t" }, { seq: 1 });
  assert.equal(r1.ok, false);
  assert.equal(r1.text, "");
  assert.equal(r1.error, "网络炸了");

  const h2 = makeHarness([{ content: "   ", toolCalls: [], usage: null }]);
  const r2 = await runWorker(h2.sh, h2.rt, { task: "t" }, { seq: 1 });
  assert.equal(r2.ok, false);
  assert.ok(r2.error?.includes("空回复"));
});

test("runWorker：系统提示=父会话 sections+职责段+req.system；worker 无 agent_task（结构性禁嵌套）", async () => {
  let system = "";
  const h = makeHarness([{ content: "ok", toolCalls: [], usage: null }]);
  (h.rt.llm as unknown as ScriptProvider).chat = async (p) => {
    system = String(p.messages[0]?.content ?? "");
    return { content: "ok", toolCalls: [], usage: null };
  };
  await runWorker(h.sh, h.rt, { task: "t", system: "你是代码审校员。" }, { seq: 1 });
  assert.ok(system.includes("你是 ZQQ-harness"), "含 base 段");
  assert.ok(system.includes(WORKER_ROLE_SECTION), "含子代理职责段");
  assert.ok(system.includes("你是代码审校员。"), "req.system 注入 order 5");
  assert.ok(system.includes("zz_echo"), "工具行来自 worker 自己的注册表");
  assert.ok(system.includes("全局规则：保持谨慎。"), "全局 AGENTS.md 注入");
  assert.ok(!system.includes("agent_task"), "worker 无 agent_task → 禁止嵌套派发");
  assert.ok(!system.includes("load_skill") || system.includes("zz_echo"), "sanity");
});

test("runWorker：effort 缺省继承父会话当前档位；req.effort 覆盖", async () => {
  const h = makeHarness([{ content: "ok", toolCalls: [], usage: null }, { content: "ok", toolCalls: [], usage: null }]);
  const r1 = await runWorker(h.sh, h.rt, { task: "t" }, { seq: 1 });
  assert.ok(r1.ok);
  assert.equal((h.rt.llm as unknown as ScriptProvider).calls[0]!.effort, "high"); // 继承 rt.settings.effort
  await runWorker(h.sh, h.rt, { task: "t", effort: "low" }, { seq: 2 });
  assert.equal((h.rt.llm as unknown as ScriptProvider).calls[1]!.effort, "low"); // per-request 覆盖
});

test("runWorker：报告超 subagentResultMaxChars 预算被修剪（含省略标记）", async () => {
  const long = "报告头。\n" + "x".repeat(20_000) + "\n报告尾。";
  const h = makeHarness([{ content: long, toolCalls: [], usage: null }]);
  const r = await runWorker(h.sh, h.rt, { task: "t" }, { seq: 1 });
  assert.ok(r.ok);
  assert.ok(r.text.length < 17_000, `修剪后应 ≤ 预算量级（缺省 16k，真机待办上调），实际 ${r.text.length}`);
  assert.ok(r.text.includes("省略"), "应带省略标记");
});

test("runWorker：timeoutMs 超时归 ok:false 并标注超时", async () => {
  const slow: LLMProvider = {
    name: "slow",
    chat: (p) =>
      new Promise<ChatResult>((_, reject) => {
        p.signal?.addEventListener("abort", () => reject(new Error("调用超时")));
      }),
  };
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = slow;
  const r = await runWorker(h.sh, h.rt, { task: "t", timeoutMs: 50 }, { seq: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("超时"), r.error);
});

// ---------- SA3 冲突专项（docs/5 §6 SA3 测试清单——本阶段的灵魂） ----------

/** 闸门提供方：chat 挂起直到 release()——让 worker 保持"运行中"以占用并发槽。 */
function gatedProvider(): { llm: LLMProvider; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  return {
    llm: {
      name: "gated",
      chat: () =>
        gate.then(() => ({ content: "done", toolCalls: [], usage: null }) satisfies ChatResult),
    },
    release,
  };
}

test("并发上限：同时运行第 4 个任务（上限 3）立即拒绝回执，不排队；槽释放后可再派（C7；docs/16 非阻塞）", async () => {
  const g = gatedProvider();
  const h = makeHarness([], { llm: g.llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  const receipts = [1, 2, 3].map((i) => svc.dispatch({ task: `t${i}`, description: "d" }));
  assert.ok(receipts.every((r) => r.ok), "三个派发同步受理");
  for (let i = 0; i < 100 && h.rt.workers.size < 3; i++) await sleep(5); // 让前三个真正进入运行（chat 挂起）
  assert.equal(h.rt.workers.size, 3, "三个 worker 在活动登记中");

  const fourth = svc.dispatch({ task: "t4", description: "d" }); // 同步裁决：立即回执，不排队
  assert.equal(fourth.ok, false, "第 4 个任务超出并发上限");
  assert.ok(fourth.error?.includes("并发上限"), fourth.error);
  assert.ok(fourth.error?.includes("未启动"), "明确告知未启动（不排队）");
  assert.equal(h.rt.workers.size, 3, "被拒任务不占槽");

  g.release(); // 前三个完成
  const reports = await waitForInbox(h.rt, 3);
  assert.equal(reports.length, 3, "三份完成报告全部自动送达");
  assert.ok(reports.every((r) => r.includes("[子代理任务报告 · 自动送达]")), reports[0]);
  for (let i = 0; i < 100 && h.rt.workers.size > 0; i++) await sleep(5);
  assert.equal(h.rt.workers.size, 0, "完成后注销活动登记");
  const again = svc.dispatch({ task: "t5", description: "d" }); // 槽已空，可再派
  assert.ok(again.ok);
  assert.equal(h.rt.subagentTotal, 4, "累计计数只含真正启动的（3 运行 + 1 再派；被拒项未启动不计）");
});

test("累计上限：subagentTotal 达 subagentMaxTotal 后新任务立即报错（C7 累计闸）", async () => {
  const h = makeHarness([{ content: "ok", toolCalls: [], usage: null }]);
  h.rt.subagentTotal = SUBAGENT_MAX_TOTAL;
  const r = await runWorker(h.sh, h.rt, { task: "t" }, { seq: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("累计上限"), r.error);
});

test("scope 透传：req.scope 经 writeScope 进 worker 全部工具上下文；缺省不带字段（§5.4）", async () => {
  const scopes: (string[] | undefined)[] = [];
  const h = makeHarness(
    [toolRound("c1", '{"value":"a"}'), { content: "done", toolCalls: [], usage: null }],
    { scopeSink: scopes },
  );
  await runWorker(h.sh, h.rt, { task: "t", scope: ["src/auth", "docs"] }, { seq: 1 });
  assert.deepEqual(scopes, [["src/auth", "docs"]]);

  const scopes2: (string[] | undefined)[] = [];
  const h2 = makeHarness([toolRound("c1", '{"value":"a"}'), { content: "ok", toolCalls: [], usage: null }], { scopeSink: scopes2 });
  await runWorker(h2.sh, h2.rt, { task: "t" }, { seq: 1 });
  assert.deepEqual(scopes2, [undefined], "缺省不带 writeScope（整个工作区）");
});

test("abort 级联：外部 signal 中止后 worker 归 ok:false（已中止），无悬空 promise（C8）", async () => {
  const ctl = new AbortController();
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) =>
      new Promise<ChatResult>((_, reject) => {
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const p = runWorker(h.sh, h.rt, { task: "t" }, { seq: 1, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 20));
  ctl.abort();
  const r = await p; // 必须能收尾（不能永挂）
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("中止"), r.error);
});

test("P1 死锁修复：worker 审批挂卡时外部 abort——卡立即取消、worker 收尾 ok:false 不悬空", async () => {
  const ctl = new AbortController();
  const decisions: string[] = [];
  const h = makeHarness([toolRound("c1", '{"value":"x"}')], { approval: true, approvalSink: decisions });
  const p = runWorker(h.sh, h.rt, { task: "t", name: "stuck" }, { seq: 1, signal: ctl.signal });
  for (let i = 0; i < 100 && h.rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.rt.pendingApproval, "审批卡已挂上父会话单槽（死锁场景成立）");
  ctl.abort(); // 按「停止」：不手动点卡片——正在等的卡必须随信号自行取消
  const r = await p; // worker 必须能收尾（修复前永远挂在这里）
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("中止"), r.error);
  assert.deepEqual(decisions, ["cancelled"], "cancelled 决议回流 worker 工具");
  assert.equal(h.rt.pendingApproval, null, "单槽已清空");
  const decided = h.rt.auditEvents.filter((e) => e.type === "approval/decided").map((e) => e.decision);
  assert.deepEqual(decided, ["cancelled"], "审计记 decided/cancelled");
});

test("审批串行：两个 worker 并行触发审批——第一张决议前第二张不弹，按序决议不互踩（C3）", async () => {
  const sink: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  // 两阶段提供方：首轮（无 tool 消息）发起触发审批的工具调用；之后挂起等闸门再交报告
  const llm: LLMProvider = {
    name: "two-phase",
    chat: (p) => {
      const task = String(p.messages[p.messages.length - 1]?.content ?? "");
      return !p.messages.some((m) => m.role === "tool")
        ? Promise.resolve(toolRound(`c-${task}`, '{"value":"x"}')) // 首轮：触发审批的工具调用
        : gate.then(() => ({ content: `done:${task}`, toolCalls: [], usage: null }) satisfies ChatResult); // 卡住等闸门
    },
  };
  const h = makeHarness([], { approval: true, approvalSink: sink, llm });
  const p1 = runWorker(h.sh, h.rt, { task: "w1", name: "a-one" }, { seq: 1 });
  const p2 = runWorker(h.sh, h.rt, { task: "w2", name: "a-two" }, { seq: 2 });
  // 等第一张卡挂上
  for (let i = 0; i < 100 && h.rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.rt.pendingApproval, "第一张卡已挂单槽");
  await new Promise((r) => setTimeout(r, 30));
  let cardCount = h.broadcasts.filter((b) => b.event === "approval").length;
  assert.equal(cardCount, 1, "第一张决议前第二张不弹（串行队列）");
  const firstCmd = String((h.broadcasts.find((b) => b.event === "approval")!.data as { command: string }).command);
  assert.ok(["a-one", "a-two"].some((n) => firstCmd.includes(n)), `首卡来自其中一个 worker：${firstCmd}`);
  h.rt.pendingApproval!("allowed-once"); // 第一张决议
  // 第二张随后弹上
  for (let i = 0; i < 100 && cardCount < 2; i++) {
    await new Promise((r) => setTimeout(r, 5));
    cardCount = h.broadcasts.filter((b) => b.event === "approval").length;
  }
  assert.equal(cardCount, 2, "前卡决议后后卡弹出");
  h.rt.pendingApproval!("rejected");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1.ok && r2.ok, "两个 worker 都收尾（决议结果回流，报告照常）");
  assert.deepEqual(sink.slice().sort(), ["allowed-once", "rejected"]);
});

// ---------- SA4 可观测性（docs/5 §6 SA4：SSE 事件 + 审计记录） ----------

/** 从 broadcast 记录里抽出 subagent 事件载荷。 */
function subEvents(h: Harness) {
  return h.broadcasts.filter((b) => b.event === "subagent").map((b) => b.data as {
    sessionId: string;
    subId: number;
    name: string;
    phase: string;
    summary?: string;
    rounds?: number;
    usage?: { prompt: number; completion: number };
    error?: string;
    toolName?: string;
    preview?: string;
    output?: string;
    id?: string;
  });
}

test("SA4 事件：spawned→(tool→toolResult)*→done 顺序与载荷；失败走 phase=error 带 error", async () => {
  const h = makeHarness([
    { content: "", toolCalls: [{ id: "c1", name: "zz_echo", arguments: '{"value":"a"}' }], usage: { promptTokens: 100, completionTokens: 20 } },
    { content: "报告", toolCalls: [], usage: { promptTokens: 50, completionTokens: 10 } },
  ]);
  const r = await runWorker(h.sh, h.rt, { task: "t", name: "impl-x", description: "实现 X" }, { seq: 3 });
  assert.ok(r.ok);
  const evs = subEvents(h);
  assert.deepEqual(
    evs.map((e) => e.phase),
    ["spawned", "tool", "toolResult", "done"],
    "工具级过程流（docs/6 P3 方案 B）穿插在 spawned 与 done 之间",
  );
  assert.equal(evs[0]!.sessionId, h.rt.id);
  assert.equal(evs[0]!.subId, 3);
  assert.equal(evs[0]!.name, "impl-x");
  assert.equal(evs[0]!.summary, "实现 X");
  const [toolEv, resEv, doneEv] = [evs[1]!, evs[2]!, evs[3]!];
  assert.equal(toolEv.toolName, "zz_echo", "tool 事件带工具名");
  assert.equal(toolEv.id, "c1", "tool 事件带 callId（前端配对回填）");
  assert.ok((toolEv.preview ?? "").includes("a"), "tool 事件带参数预览");
  assert.equal(resEv.id, "c1");
  assert.equal(resEv.output, "echo:a");
  assert.equal(doneEv.rounds, 2);
  assert.deepEqual(doneEv.usage, { prompt: 150, completion: 30 });

  const h2 = makeHarness([{ content: "   ", toolCalls: [], usage: null }]); // 空回复 → 失败
  await runWorker(h2.sh, h2.rt, { task: "t", name: "bad" }, { seq: 4 });
  const evs2 = subEvents(h2);
  assert.deepEqual(
    evs2.map((e) => e.phase),
    ["spawned", "error"],
    "无工具调用的 worker 不产生过程流事件",
  );
  assert.ok(evs2[1]!.error?.includes("空回复"));
});

test("P3 方案 B：过程流 output 截断到预算内并带标记；只发 tool 级不发 delta 级", async () => {
  const h = makeHarness([
    { content: "", toolCalls: [{ id: "c1", name: "zz_echo", arguments: `{"value":"${"y".repeat(3000)}"}` }], usage: null },
    { content: "done", toolCalls: [], usage: null },
  ]);
  await runWorker(h.sh, h.rt, { task: "t", name: "noisy" }, { seq: 1 });
  const evs = subEvents(h).filter((e) => e.name === "noisy");
  const resEv = evs.find((e) => e.phase === "toolResult")!;
  assert.ok((resEv.output ?? "").length <= 500, `截断后 ≤500，实际 ${(resEv.output ?? "").length}`);
  assert.ok((resEv.output ?? "").includes("已截断"), "带截断标记（全文在工具结果与 A 的 transcript 里）");
  assert.ok(evs.every((e) => ["spawned", "tool", "toolResult", "done", "error"].includes(e.phase)), "只有 tool 级事件，无 delta 级");
});

test("SA4 审计记录：成功/失败都写 rt.subagents（name/ok/rounds/usage/at）；配额拒绝不记录不发事件", async () => {
  const h = makeHarness([
    { content: "ok", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } },
    { content: "", toolCalls: [], usage: null }, // 第二个 worker 的空回复
  ]);
  await runWorker(h.sh, h.rt, { task: "t1", name: "good-one", description: "d1" }, { seq: 1 });
  await runWorker(h.sh, h.rt, { task: "t2", name: "bad-one" }, { seq: 2 });
  assert.equal(h.rt.subagents.length, 2, "两个真实启动的 worker 各一条记录");
  const [rec1, rec2] = h.rt.subagents;
  assert.equal(rec1!.name, "good-one");
  assert.equal(rec1!.description, "d1");
  assert.equal(rec1!.ok, true);
  assert.equal(rec1!.rounds, 1);
  assert.deepEqual(rec1!.usage, { prompt: 10, completion: 5 });
  assert.ok(!Number.isNaN(Date.parse(rec1!.at)), "at 为 ISO 时间");
  assert.equal(rec2!.ok, false);
  assert.ok(rec2!.error?.includes("空回复"));
  assert.ok(!("description" in rec2!), "无 description 不写字段");

  h.rt.subagentTotal = SUBAGENT_MAX_TOTAL; // 顶到累计上限 → 下一个被拒
  const rejected = await runWorker(h.sh, h.rt, { task: "t3" }, { seq: 3 });
  assert.equal(rejected.ok, false);
  assert.equal(h.rt.subagents.length, 2, "被拒任务未启动，不产生审计记录");
  assert.equal(subEvents(h).length, 4, "被拒任务也不发 subagent 事件（2 worker × 2）");
});

// ---------- P2：worker 带真 MCP（docs/6 §2.3 路线 A，修订 docs/5 偏差 19） ----------

/** 桩 MCP 传输：连接即握手成功（固定 instructions），单工具 echo；connect/stop/调用计数。 */
function stubMcpTransport(counts: { connect: number; stop: number; calls: string[] }): McpTransportDef {
  return {
    type: "stub",
    async connect() {
      counts.connect++;
      return {
        instructions: "文献库桩说明：调用 echo 查询文献。",
        serverInfo: { name: "stub-demo", version: "1" },
        listTools: () => [{ name: "echo", description: "回显查询", inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
        callTool: async (_name, args) => {
          counts.calls.push(String(args.value ?? ""));
          return `文献结果：${String(args.value ?? "")}`;
        },
        get alive() {
          return true;
        },
        stop: () => {
          counts.stop++;
        },
      };
    },
  };
}

/** 装配带桩 MCP 的 harness：真 McpManager + 工作区 mcp.json 指向桩传输。 */
function mcpHarness(script: ChatResult[], counts: { connect: number; stop: number; calls: string[] }): Harness {
  const h = makeHarness(script);
  h.sh.ctx.mcpTransports.register(stubMcpTransport(counts));
  h.rt.mcp = new McpManager(h.sh.ctx.mcpTransports);
  writeFileSync(
    join(h.rt.workspace!.root, "mcp.json"),
    JSON.stringify({ mcpServers: { demo: { type: "stub", command: "stub" } } }),
    "utf8",
  );
  return h;
}

const mcpRound = (id: string, value: string): ChatResult => ({
  content: "",
  toolCalls: [{ id, name: "mcp__demo__echo", arguments: JSON.stringify({ value }) }],
  usage: null,
});

test("P2 worker MCP：worker 直调 mcp__ 工具（不弹审批）；系统提示渲染 MCP 段；同会话懒加载只连一次", async () => {
  const counts = { connect: 0, stop: 0, calls: [] as string[] };
  const h = mcpHarness(
    [
      mcpRound("c1", "graphene"),
      { content: "报告：查询完成", toolCalls: [], usage: null },
      mcpRound("c2", "membrane"),
      { content: "报告：第二个也完成", toolCalls: [], usage: null },
    ],
    counts,
  );
  // docs/20：worker MCP 首连后应重建一次协调者系统提示（「子代理系统提示词说明」段补上
  // MCP 说明）——给桩 agent 装 spy 计数；workerMcpToolsOf 的 promise 缓存保证只触发一次
  let refreshed = 0;
  (h.rt.agent as unknown as { refreshSystemPrompt: () => void }).refreshSystemPrompt = () => refreshed++;
  const r1 = await runWorker(h.sh, h.rt, { task: "查文献" }, { seq: 1 });
  assert.ok(r1.ok, r1.error);
  assert.deepEqual(counts.calls, ["graphene"], "worker 直调 mcp__ 工具（信任模型，不走审批）");
  assert.ok(!h.broadcasts.some((b) => b.event === "approval"), "MCP 调用不弹审批卡（用户报告的问题消失）");
  const sys = String((h.rt.llm as unknown as ScriptProvider).calls[0]!.messages[0]!.content);
  assert.ok(sys.includes("文献库桩说明"), "worker 系统提示渲染 MCP 使用说明段");
  assert.ok(
    (h.rt.llm as unknown as ScriptProvider).calls[0]!.tools!.some((t) => t.name === "mcp__demo__echo"),
    "工具 schema 来自 worker registry（含 mcp__ 工具）",
  );

  const r2 = await runWorker(h.sh, h.rt, { task: "再查", name: "w2" }, { seq: 2 });
  assert.ok(r2.ok, r2.error);
  assert.deepEqual(counts.calls, ["graphene", "membrane"], "第二个 worker 复用快照工具");
  assert.equal(counts.connect, 1, "同会话只连一次（每 server 一个进程，全部 worker 共享）");
  assert.equal(counts.stop, 0, "会话运行期间连接保持（不随单个 worker 结束断开）");
  assert.equal(refreshed, 1, "docs/20：MCP 首连热更协调者系统提示恰好一次（第二个 worker 不再触发）");
});

test("P2 降级：MCP 服务器全部连接失败时 worker 照常运行（不带 mcp__ 工具，不因故障拒派）", async () => {
  const h = makeHarness([{ content: "没有 MCP 也能干活", toolCalls: [], usage: null }]);
  h.sh.ctx.mcpTransports.register({
    type: "bad",
    async connect() {
      throw new Error("服务器起不来");
    },
  });
  h.rt.mcp = new McpManager(h.sh.ctx.mcpTransports);
  writeFileSync(
    join(h.rt.workspace!.root, "mcp.json"),
    JSON.stringify({ mcpServers: { bad: { type: "bad", command: "x" } } }),
    "utf8",
  );
  const r = await runWorker(h.sh, h.rt, { task: "t" }, { seq: 1 });
  assert.ok(r.ok, r.error);
  assert.equal(r.text, "没有 MCP 也能干活");
});

// ---------- P3：worker 全程 transcript 落盘（docs/6 §3 方案 A） ----------

test("P3 transcript 落盘：成功 worker 写 spill 私有目录，记录/结果携带相对路径，内容含任务书与工具结果、不含系统提示", async () => {
  const h = makeHarness([toolRound("c1", '{"value":"a"}'), { content: "报告：完成", toolCalls: [], usage: null }]);
  const r = await runWorker(h.sh, h.rt, { task: "干活", name: "impl-t" }, { seq: 7 });
  assert.ok(r.ok, r.error);
  assert.equal(r.subId, 7);
  const rel = join("sub-7-impl-t", "transcript.json");
  assert.equal(r.transcript, rel, "SubagentResult 携带相对路径（formatWorkerResult 标记用）");
  assert.equal(h.rt.subagents[0]!.transcript, rel, "SubagentRecord 携带（存档往返 + API 查找用）");
  const subEv = h.broadcasts.filter((b) => b.event === "subagent").find((b) => (b.data as { phase: string }).phase === "done");
  assert.equal((subEv!.data as { transcript?: string }).transcript, rel, "SSE done 事件携带（前端「📄 过程」入口）");

  const file = join(h.sh.sessions.spillDir(h.rt.id)!, rel);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    kind?: string;
    title?: string;
    messageCount?: number;
    subagent?: { subId?: number; name?: string; reusable?: boolean; tasks?: number; state?: string };
    messages: { role: string; content?: unknown }[];
  };
  // docs/17：存档为主对话 SessionData 同构格式（kind:"subagent" + subagent 元数据块 + messages）
  assert.equal(parsed.kind, "subagent", "存档 kind=subagent（主对话同构）");
  assert.equal(parsed.title, "impl-t");
  assert.equal(parsed.messageCount, parsed.messages.length);
  assert.equal(parsed.subagent?.subId, 7);
  assert.equal(parsed.subagent?.name, "impl-t");
  assert.equal(parsed.subagent?.reusable, false);
  assert.equal(parsed.subagent?.state, "archived", "一次性任务收尾即归档形态");
  assert.ok(parsed.messages.every((m) => m.role !== "system"), "系统提示不入存档（按工作区可重建）");
  assert.equal(parsed.messages[0]!.role, "user");
  assert.equal(parsed.messages[0]!.content, "干活");
  assert.ok(parsed.messages.some((m) => m.role === "tool"), "工具结果入存档");
  assert.ok(parsed.messages.some((m) => m.role === "assistant" && m.content === "报告：完成"), "最终报告入存档");
});

test("P3 transcript 落盘：失败 worker（空回复）同样落盘——部分过程有排查价值", async () => {
  const h = makeHarness([{ content: "   ", toolCalls: [], usage: null }]);
  const r = await runWorker(h.sh, h.rt, { task: "注定失败", name: "bad" }, { seq: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.transcript, "失败 worker 也有过程存档");
  const file = join(h.sh.sessions.spillDir(h.rt.id)!, r.transcript!);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { messages: { role: string }[] };
  assert.equal(parsed.messages[0]!.role, "user");
});

test("P3 best-effort：transcript 写失败（路径被目录占用）不影响 worker 结果，记录不带入口", async () => {
  const h = makeHarness([{ content: "照常完成", toolCalls: [], usage: null }]);
  // 预占 transcript.json 为目录 → writeFileSync 抛错 → dumpTranscript 吞掉返回 undefined
  mkdirSync(join(h.sh.sessions.spillDir(h.rt.id)!, "sub-1-anon", "transcript.json"), { recursive: true });
  const r = await runWorker(h.sh, h.rt, { task: "t", name: "anon" }, { seq: 1 });
  assert.ok(r.ok, r.error);
  assert.equal(r.text, "照常完成");
  assert.equal(r.transcript, undefined);
  assert.equal(h.rt.subagents[0]!.transcript, undefined);
});

// ---------- 需求三第三棒（docs/8）：活动句柄的实时历史出口（抽屉详情页轮询数据源） ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("第三棒 liveMessages：运行中句柄暴露 worker 实时历史（任务书/工具调用/结果，无系统提示）；收尾随句柄注销", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let chats = 0;
  const llm: LLMProvider = {
    name: "stepwise",
    chat: async () => {
      chats++;
      if (chats === 1) return toolRound("c1", '{"value":"a"}');
      await gate; // 第二轮挂起：此窗口断言实时历史
      return { content: "报告：完成", toolCalls: [], usage: null };
    },
  };
  const h = makeHarness([], { llm });
  const p = runWorker(h.sh, h.rt, { task: "任务书原文", name: "liveview" }, { seq: 1 });
  for (let i = 0; i < 100 && chats < 2; i++) await sleep(5);
  const live = h.rt.activeSubagents.get(1)?.liveMessages?.();
  assert.ok(Array.isArray(live), "运行中句柄暴露实时历史（liveMessages）");
  assert.ok(live!.every((m) => m.role !== "system"), "不含系统提示（与 transcript 落盘同口径）");
  assert.equal(live![0]!.role, "user");
  assert.equal(live![0]!.content, "任务书原文");
  assert.ok(live!.some((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0), "已完成轮次含工具调用");
  assert.ok(live!.some((m) => m.role === "tool"), "工具结果已回填——前端轮询可见思考/正文/工具全量");
  release();
  const r = await p;
  assert.ok(r.ok, r.error);
  assert.equal(h.rt.activeSubagents.size, 0, "收尾注销句柄（liveMessages 随之消失，回看转 transcript 存档）");
});

// ---------- docs/18：打断即终结（stop；暂停/恢复机制退役） ----------

test("docs/18：stop 打断任务执行中的 worker——立即结算（不占并发槽、不再派发请求）；一次性随之归档", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) =>
      new Promise<ChatResult>((_, reject) => {
        chats++;
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const p = runWorker(h.sh, h.rt, { task: "t", name: "stopped" }, { seq: 1 });
  for (let i = 0; i < 100 && chats < 1; i++) await sleep(5);
  const entry = h.rt.activeSubagents.get(1)!;
  assert.equal(entry.status, "run");
  entry.stop(); // 请求在飞：立即中止 → 任务结算（打断即终结）
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("任务被用户停止"), r.error);
  const chatsAtStop = chats;
  await sleep(50);
  assert.equal(chats, chatsAtStop, "打断后不再派发 LLM 请求");
  assert.equal(h.rt.activeSubagents.size, 0, "一次性结算即归档注销（不占并发槽）");
  assert.equal(h.rt.workers.size, 0, "并发槽释放");
  const phases = subPhases(h, 1);
  assert.equal(phases.join("→"), "spawned→error", "打断收尾走 error 事件（失败归因任务被用户停止）");
});

test("docs/18：启动前即 stop——任务未开始即结算（零 LLM 调用），可复用转待命", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) => {
      chats++;
      return new Promise<ChatResult>((_, reject) => {
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "不该跑的任务", description: "d", name: "early", reusable: true }).ok);
  h.rt.activeSubagents.get(1)!.stop(); // 句柄注册与 dispatch 同步段完成——启动前即打断（ws 级标记）
  await waitForInbox(h.rt, 0, 50); // 给收尾一点时间（打断结算的报告不送达——inbox 应为空）
  await sleep(60);
  assert.equal(chats, 0, "任务未开始（零 LLM 调用）");
  assert.equal(h.rt.subagents[0]!.state, "idle", "可复用被打断转待命（保留驻留）");
  assert.equal(h.rt.subagents[0]!.ok, false);
  assert.ok(h.rt.subagents[0]!.error?.includes("任务被用户停止"));
  assert.equal(h.rt.activeSubagents.get(1)!.status, "idle");
  assert.equal(h.rt.inbox?.length ?? 0, 0, "打断结算不送达失败报告（通知/工具文案已覆盖）");
});

test("docs/18：stop 打断后并发槽立即释放（第 4 个任务可派）；被打断的报告不送达", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) => {
      chats++;
      return new Promise<ChatResult>((_, reject) => {
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const svc = subagentServiceFor(h.sh, h.rt);
  for (const i of [1, 2, 3]) assert.ok(svc.dispatch({ task: `t${i}`, description: "d", name: `n${i}` }).ok);
  for (let i = 0; i < 100 && chats < 3; i++) await sleep(5);
  assert.equal(h.rt.workers.size, 3, "三个 worker 在跑（占满并发）");
  h.rt.activeSubagents.get(2)!.stop(); // n2 打断 → 结算释放槽
  let freed = h.rt.workers.size;
  for (let i = 0; i < 100 && freed !== 2; i++) {
    await sleep(5);
    freed = h.rt.workers.size;
  }
  assert.equal(freed, 2, "打断结算即释放并发槽（不再站着空位）");
  const fourth = svc.dispatch({ task: "t4", description: "d" });
  assert.equal(fourth.ok, true, "释放的槽立即可用");
  assert.equal(h.rt.inbox?.length ?? 0, 0, "打断结算不送达失败报告");
});

test("docs/18 真中断：stop 立即打断进行中的 LLM 请求——任务结算（不重发、不挂起）", async () => {
  let chats = 0;
  const seenSignals: Array<AbortSignal | undefined> = [];
  const llm: LLMProvider = {
    name: "interruptible",
    chat: (p) => {
      chats++;
      seenSignals.push(p.signal);
      // 首轮请求挂起，直到信号 abort 才拒绝（流式请求被打断的形态）
      return new Promise<ChatResult>((_, rej) => {
        if (p.signal?.aborted) return rej(new Error("aborted"));
        p.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      });
    },
  };
  const h = makeHarness([], { llm });
  const p = runWorker(h.sh, h.rt, { task: "t", name: "cut" }, { seq: 1 });
  for (let i = 0; i < 100 && chats < 1; i++) await sleep(5);
  const entry = h.rt.activeSubagents.get(1)!;
  entry.stop(); // 首轮请求在飞：立即 abort → 任务结算
  const r = await p;
  assert.equal(seenSignals[0]?.aborted, true, "进行中的请求收到中止信号");
  assert.equal(r.ok, false, "打断即失败结算");
  assert.ok(r.error?.includes("任务被用户停止"), r.error);
  assert.equal(r.stopped, true, "打断结算带标记（送达侧据此跳过失败报告）");
  await sleep(30);
  assert.equal(chats, 1, "没有重发（恢复机制已退役）");
  assert.equal(h.rt.activeSubagents.size, 0, "一次性结算归档注销");
});

test("docs/18：手动打断（via=ui）→ 状态通知送达且失败报告不送达（一次操作一条消息）；可复用转待命后 followup 接续", async () => {
  let chats = 0;
  const llm: LLMProvider = {
    name: "abort-throwing",
    chat: (p) => {
      chats++;
      return new Promise<ChatResult>((res, rej) => {
        if (p.signal?.aborted) return rej(new Error("请求已被中止（输出未完成）"));
        p.signal?.addEventListener("abort", () => rej(new Error("请求已被中止（输出未完成）")), { once: true });
        if (chats >= 2) return res({ content: "接续报告：完成", toolCalls: [], usage: null });
      });
    },
  };
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "t", description: "d", name: "spec", reusable: true }).ok);
  for (let i = 0; i < 100 && chats < 1; i++) await sleep(5); // 首轮请求在飞
  const msg = applySubagentControl(h.rt, { subId: 1 }, "stop", "ui"); // 界面 ⏹
  assert.ok(msg.includes("已打断子代理：spec#1"), msg);
  await sleep(80);
  const inbox = h.rt.inbox ?? [];
  assert.equal(inbox.length, 1, "只送达状态通知；打断结算的失败报告不送达（一次操作一条消息）");
  assert.ok((inbox[0] ?? "").startsWith("[子代理状态 · 自动送达]"));
  assert.ok((inbox[0] ?? "").includes("已被用户打断"), inbox[0]);
  assert.ok((inbox[0] ?? "").includes("agent_followup"), "通知指引新任务书接续（没有恢复）");
  for (let i = 0; i < 100 && h.rt.activeSubagents.get(1)?.status !== "idle"; i++) await sleep(5);
  assert.equal(h.rt.activeSubagents.get(1)!.status, "idle", "可复用被打断转待命");
  const f = svc.followup({ subId: 1 }, { task: "新任务书", description: "接续" }); // 只能发新提示词
  assert.ok(f.ok, "待命后 followup 接续（被打断的任务不自动续跑）");
  const report = (await waitForInbox(h.rt, 2))[1] ?? "";
  assert.ok(report.includes("[子代理任务报告 · 自动送达]"), report);
  assert.ok(report.includes("接续报告：完成"), report);
  assert.ok(report.includes("第 2 次任务"), report);
});

test("docs/18 applySubagentControl：subId 优先 / name 全生效打断 / miss 附活动清单", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) => {
      chats++;
      return new Promise<ChatResult>((_, reject) => {
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  void runWorker(h.sh, h.rt, { task: "a1", description: "d", name: "twin" }, { seq: 1 });
  void runWorker(h.sh, h.rt, { task: "a2", description: "d", name: "twin" }, { seq: 2 });
  void runWorker(h.sh, h.rt, { task: "b", description: "d", name: "solo" }, { seq: 3 });
  for (let i = 0; i < 100 && chats < 3; i++) await sleep(5);
  const miss = applySubagentControl(h.rt, { name: "ghost" }, "stop");
  assert.ok(miss.includes("没有匹配") && miss.includes("twin#1") && miss.includes("solo#3"), "miss 附活动清单");
  const msg = applySubagentControl(h.rt, { name: "twin" }, "stop");
  assert.ok(msg.includes("twin#1") && msg.includes("twin#2"), "按 name 匹配全部同名（一起打断）");
  assert.ok(msg.includes("已打断子代理"), msg);
  for (let i = 0; i < 100 && h.rt.activeSubagents.size !== 1; i++) await sleep(5); // twin 两个结算注销
  assert.ok(applySubagentControl(h.rt, { subId: 3 }, "stop").includes("solo#3"), "按 subId 匹配");
  for (let i = 0; i < 100 && h.rt.activeSubagents.size > 0; i++) await sleep(5);
  assert.equal(h.rt.activeSubagents.size, 0, "打断结算全部注销");
});

// ---------- docs/9：可复用子代理（reusable 派发 / followup 追加 / archive 归档） ----------

const subPhases = (h: Harness, subId: number): string[] =>
  h.broadcasts
    .filter((b) => b.event === "subagent" && (b.data as { subId?: number }).subId === subId)
    .map((b) => (b.data as { phase: string }).phase);

test("docs/9 可复用生命周期：reusable 派发→idle（记录 upsert state:idle/tasks）→followup 历史延续（第 2 次任务）→archive 定格→再派被拒", async () => {
  const llm = new ScriptProvider([
    { content: "报告：任务一完成", toolCalls: [], usage: null },
    { content: "报告：任务二完成", toolCalls: [], usage: null },
  ]);
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);

  // 首任务（reusable 派发）：派发回执即时返回；报告送达带待命标注；记录 upsert idle；句柄驻留 status=idle
  const d1 = svc.dispatch({ task: "任务一", description: "首任务", name: "spec", reusable: true });
  assert.ok(d1.ok, "派发同步受理");
  assert.equal(d1.name, "spec");
  assert.equal(d1.subId, 1);
  const report1 = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(report1.includes("[子代理 spec 完成]"), report1);
  assert.ok(report1.includes("已保留待命"), "送达报告带待命标注");
  const rec1 = h.rt.subagents[0]!;
  assert.equal(rec1.subId, 1);
  assert.equal(rec1.state, "idle");
  assert.equal(rec1.tasks, 1);
  assert.equal(rec1.reusable, true);
  const handle = h.rt.activeSubagents.get(1)!;
  assert.ok(handle, "可复用句柄任务结束仍驻留（跨任务存活）");
  assert.equal(handle.status, "idle");
  assert.equal(handle.tasks, 1);
  assert.deepEqual(subPhases(h, 1), ["spawned", "idle"], "spawned 带 reusable、任务结束发 idle（不发 done）");

  // 追加任务：派发即回执；第二次 worker 请求含首任务上下文（历史延续=复用价值）；记录 tasks=2 仍 idle
  const d2 = svc.followup({ name: "spec" }, { task: "任务二", description: "追加" });
  assert.ok(d2.ok, "followup 同步受理");
  await waitForInbox(h.rt, 2);
  const report2 = (h.rt.inbox ?? [])[1] ?? "";
  assert.ok(report2.includes("第 2 次任务"), report2);
  const second = llm.calls[1]!;
  assert.ok(second.messages.some((m) => m.role === "user" && m.content === "任务一"), "请求含首任务书");
  assert.ok(second.messages.some((m) => m.role === "assistant" && m.content === "报告：任务一完成"), "请求含首任务报告");
  assert.ok(second.messages.some((m) => m.role === "user" && m.content === "任务二"), "请求含新任务书");
  assert.equal(h.rt.subagents[0]!.tasks, 2);
  assert.equal(h.rt.subagents[0]!.state, "idle");
  assert.deepEqual(subPhases(h, 1), ["spawned", "idle", "task", "idle"], "followup 起跑发 task 相位");

  // transcript 累积重写：同一文件含两次任务书
  const rec = h.rt.subagents[0]!;
  const file = join(h.sh.sessions.spillDir(h.rt.id)!, rec.transcript!);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { messages: { role: string; content?: string }[] };
  assert.ok(parsed.messages.some((m) => m.role === "user" && m.content === "任务一"));
  assert.ok(parsed.messages.some((m) => m.role === "user" && m.content === "任务二"));
  assert.equal(h.rt.subagents.length, 1, "同 subId 记录 upsert（不追加）");

  // 归档：记录定格 archived、句柄注销、archived 事件；归档后再派被拒
  const msg = applySubagentControl(h.rt, { subId: 1 }, "archive");
  assert.ok(msg.includes("已归档子代理：spec#1"), msg);
  assert.ok(msg.includes("共完成 2 次任务"), msg);
  assert.equal(h.rt.subagents[0]!.state, "archived");
  assert.equal(h.rt.subagents[0]!.tasks, 2);
  assert.equal(h.rt.activeSubagents.size, 0);
  assert.deepEqual(subPhases(h, 1), ["spawned", "idle", "task", "idle", "archived"]);
  const d3 = svc.followup({ subId: 1 }, { task: "任务三" });
  assert.equal(d3.ok, false);
  assert.ok(d3.error!.includes("已归档"), d3.error);
});

test("运行计时：任务用时进送达报告/记录/事件（报告带「用时」；可复用跨任务累计 + 句柄 liveElapsedMs）", async () => {
  const h = makeHarness([
    { content: "报告：任务一完成", toolCalls: [], usage: null },
    { content: "报告：任务二完成", toolCalls: [], usage: null },
  ]);
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "任务一", description: "d", name: "spec", reusable: true }).ok);
  const report1 = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(/用时 \d+m?\d*s/.test(report1), `送达报告带「用时」统计：${report1.slice(0, 120)}`);
  // 记录的累计用时（elapsedMs>0 才写字段——桩任务可能 0ms 完成，0 时缺省视为 0）
  const recMs1 = h.rt.subagents[0]!.elapsedMs ?? 0;
  assert.ok(recMs1 >= 0, "记录带累计用时");

  const handle = h.rt.activeSubagents.get(1)!;
  assert.ok((handle.liveElapsedMs?.() ?? 0) >= recMs1, "句柄 liveElapsedMs 在 idle 态返回累计快照");
  assert.equal(handle.taskStartedAt, undefined, "idle 态无进行中任务，taskStartedAt 清空");

  assert.ok(svc.followup({ name: "spec" }, { task: "任务二", description: "d2" }).ok);
  await waitForInbox(h.rt, 2);
  const report2 = (h.rt.inbox ?? [])[1] ?? "";
  assert.ok(/用时 \d+m?\d*s/.test(report2), "第二次任务的送达报告同样带用时");
  const totalMs = h.rt.subagents[0]!.elapsedMs ?? 0;
  assert.ok(totalMs >= recMs1, "记录累计随任务递增（含挂起等墙钟）");

  // 事件携带：两次 idle 的 elapsedMs 递增；spawned 带 taskStartedAt 种子
  const evts = h.broadcasts.filter((b) => b.event === "subagent") as unknown as { data: Record<string, unknown> }[];
  const idles = evts.map((b) => b.data).filter((d) => d.phase === "idle");
  assert.ok(idles.length === 2 && ((idles[1]!.elapsedMs as number) ?? 0) >= ((idles[0]!.elapsedMs as number) ?? 0), "idle 事件累计用时递增");
  const spawned = evts.map((b) => b.data).find((d) => d.phase === "spawned");
  assert.ok(typeof spawned!.taskStartedAt === "number", "spawned 事件带 taskStartedAt 种子");

  // 一次性 worker：报告与记录同样携带用时（报告恒带；记录 >0 才写字段）
  assert.ok(svc.dispatch({ task: "一次性", description: "d3", name: "once" }).ok);
  await waitForInbox(h.rt, 3);
  const report3 = (h.rt.inbox ?? [])[2] ?? "";
  assert.ok(/用时 \d+m?\d*s/.test(report3), "一次性送达报告带用时");
  const onceRec = h.rt.subagents.find((r) => r.name === "once")!;
  assert.ok((onceRec.elapsedMs ?? 0) >= 0, "一次性记录带用时");
});

test("docs/9 followup 拒绝态：不存在 / 一次性已完成（已归档）/ 重启失效（idle 记录无句柄）；一次性记录 state=archived 不带 reusable", async () => {
  const h = makeHarness([{ content: "一次性完成", toolCalls: [], usage: null }]);
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "一次性任务", description: "d", name: "once" }).ok);
  await waitForInbox(h.rt); // 等结算（收尾 = 记录/句柄定型）
  const rec = h.rt.subagents[0]!;
  assert.equal(rec.state, "archived", "一次性：用完即归档");
  assert.equal(rec.reusable, undefined);
  assert.equal(h.rt.activeSubagents.size, 0, "一次性收尾即注销句柄");

  const rOnce = svc.followup({ subId: 1 }, { task: "x" });
  assert.ok(!rOnce.ok && rOnce.error.includes("已归档"), "一次性已完成 → 已归档拒绝");
  const rMiss = svc.followup({ name: "ghost" }, { task: "x" });
  assert.ok(!rMiss.ok && rMiss.error.includes("没有找到这个子代理"), "不存在的目标拒绝");

  // 重启后无存档可唤醒：记录 state=idle 但无活动句柄、无 transcript → 报「没有可唤醒的过程存档」
  h.rt.subagents.push({ subId: 9, name: "ghosted", ok: true, reusable: true, state: "idle", tasks: 1, at: new Date().toISOString() });
  const rStale = svc.followup({ subId: 9 }, { task: "x" });
  assert.ok(
    !rStale.ok && rStale.error.includes("不在线") && rStale.error.includes("没有可唤醒的过程存档") && rStale.error.includes("read_archive"),
    "无存档失效文案带「不在线」并引导重派 + read_archive 接续（docs/17）",
  );
});

// ---------- docs/17：存档注入（read_archive）与重启唤醒 ----------

test("docs/17 重启唤醒：followup 命中「idle 记录+无句柄+有存档」→ 从存档恢复历史同 subId 继续任务（构造期参数随存档还原）", async () => {
  const llm = new ScriptProvider([
    { content: "报告：任务一完成", toolCalls: [], usage: null },
    { content: "报告：唤醒后任务二完成", toolCalls: [], usage: null },
  ]);
  const h = makeHarness([], { llm });
  const svcBefore = subagentServiceFor(h.sh, h.rt);
  // 首派发（带角色段 system + effort 覆盖）→ idle；存档落盘（含构造期参数）
  assert.ok(svcBefore.dispatch({ task: "任务一", description: "首任务", name: "spec", reusable: true, system: "你是测试专家", effort: "low" }).ok);
  await waitForInbox(h.rt);
  const rec1 = h.rt.subagents[0]!;
  assert.equal(rec1.state, "idle");
  const archiveFile = join(h.sh.sessions.spillDir(h.rt.id)!, rec1.transcript!);
  const before = JSON.parse(readFileSync(archiveFile, "utf8")) as { subagent?: { system?: string; effort?: string; tasks?: number; state?: string } };
  assert.equal(before.subagent?.system, "你是测试专家", "存档 meta 含构造期参数（system）");
  assert.equal(before.subagent?.effort, "low");
  assert.equal(before.subagent?.state, "idle");

  // 模拟服务重启：句柄全清 + 新服务实例（reusables Map 随服务闭包重建 = 重启后的注册表）
  h.rt.activeSubagents.clear();
  const svcAfter = subagentServiceFor(h.sh, h.rt);

  // 唤醒：followup 同步受理、同 subId；异步恢复历史 + 执行追加任务
  const marksBefore = h.broadcasts.length;
  const d = svcAfter.followup({ name: "spec" }, { task: "任务二", description: "唤醒后追加" });
  if (!d.ok) assert.fail(`唤醒受理失败：${d.error}`);
  assert.equal(d.subId, 1, "同 subId 复活");
  assert.equal(d.name, "spec");
  await waitForInbox(h.rt, 2);
  const report2 = (h.rt.inbox ?? [])[1] ?? "";
  assert.ok(report2.includes("第 2 次任务"), report2);
  const second = llm.calls[1]!;
  assert.ok(second.messages.some((m) => m.role === "user" && m.content === "任务一"), "请求含存档中的首任务书（历史延续）");
  assert.ok(second.messages.some((m) => m.role === "assistant" && m.content === "报告：任务一完成"), "请求含存档中的首任务报告");
  assert.ok(second.messages.some((m) => m.role === "user" && m.content === "任务二"), "请求含新任务书");
  // 累计延续：记录 upsert（tasks=2 仍 idle）+ 句柄复活 idle
  assert.equal(h.rt.subagents[0]!.tasks, 2);
  assert.equal(h.rt.subagents[0]!.state, "idle");
  assert.equal(h.rt.activeSubagents.get(1)?.status, "idle");
  assert.equal(h.rt.activeSubagents.get(1)?.tasks, 2);
  // 存档重写：meta.tasks 随唤醒后的任务累计
  const after = JSON.parse(readFileSync(archiveFile, "utf8")) as { subagent?: { tasks?: number } };
  assert.equal(after.subagent?.tasks, 2);
  // 唤醒不重发 spawned（抽屉行已存在）：事件序 task→idle
  const revivedPhases = h.broadcasts
    .slice(marksBefore)
    .filter((b) => b.event === "subagent" && (b.data as { subId?: number }).subId === 1)
    .map((b) => (b.data as { phase: string }).phase);
  assert.deepEqual(revivedPhases, ["task", "idle"], "唤醒 task 起跑 → idle 收尾，无 spawned");
});

test("docs/17 唤醒闸门与降级：存档缺失 → 唤醒失败指引重派；记录 contextPct≥35 → 拒收沿用；归档记录仍拒", async () => {
  const h = makeHarness([{ content: "ok", toolCalls: [], usage: null }]);
  const svc = subagentServiceFor(h.sh, h.rt);
  // 存档缺失：记录有 transcript 路径但文件不存在 → 唤醒失败降级文案
  h.rt.subagents.push({
    subId: 5, name: "broken", ok: true, reusable: true, state: "idle", tasks: 1,
    transcript: join("sub-5-broken", "transcript.json"), at: new Date().toISOString(),
  });
  const rBroken = svc.followup({ subId: 5 }, { task: "x" });
  assert.ok(!rBroken.ok && rBroken.error.includes("自动唤醒失败") && rBroken.error.includes("read_archive"), "存档不可读 → 降级文案（docs/17）");
  // 上下文门槛沿存档记录生效：contextPct=40 ≥ 35 → 先拒（不读档不唤醒）
  h.rt.subagents.push({
    subId: 6, name: "hot", ok: true, reusable: true, state: "idle", tasks: 1, contextPct: 40,
    transcript: join("sub-6-hot", "transcript.json"), at: new Date().toISOString(),
  });
  const rHot = svc.followup({ subId: 6 }, { task: "x" });
  assert.ok(!rHot.ok && rHot.error.includes("上下文占用已达 40%"), "唤醒前先查上下文门槛（docs/10 R1 沿用）");
  // 归档记录照旧拒绝（不唤醒）
  h.rt.subagents.push({
    subId: 7, name: "done", ok: true, reusable: true, state: "archived", tasks: 1,
    transcript: join("sub-7-done", "transcript.json"), at: new Date().toISOString(),
  });
  const rDone = svc.followup({ subId: 7 }, { task: "x" });
  assert.ok(!rDone.ok && rDone.error.includes("已归档"), "归档不可唤醒");
  assert.equal(h.rt.activeSubagents.size, 0, "全部拒绝路径不注册句柄");
});

test("docs/17 archiveSourceOf：subId→子代理存档 / sessionId→主对话档 / 缺参附清单 / 二选一 / 非法 id 拒绝", async () => {
  const h = makeHarness([{ content: "报告：完成", toolCalls: [], usage: null }]);
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "任务书", description: "d", name: "spec" }).ok);
  await waitForInbox(h.rt);
  const resolve1 = archiveSourceOf(h.sh, h.rt);

  // subId 命中：标签带 name#subId，messages 为存档原文
  const bySub = resolve1({ subId: 1 });
  assert.ok(bySub.ok, "archiveSourceOf(subId) 命中");
  if (bySub.ok) {
    assert.ok(bySub.label.includes("spec#1"), "标签带 name#subId");
    assert.ok(bySub.messages.some((m) => m.role === "user" && m.content === "任务书"), "messages 为存档原文");
  }

  // subId 未命中 → 错误附可用清单（自纠错）
  const miss = resolve1({ subId: 99 });
  assert.ok(!miss.ok && miss.error.includes("spec#1"), "缺档错误附可用清单");

  // 二选一 / 都不给
  const both = resolve1({ subId: 1, sessionId: h.rt.id });
  assert.ok(!both.ok && both.error.includes("二选一"), "参数二选一");
  const none = resolve1({});
  assert.ok(!none.ok && none.error.includes("spec#1"), "缺参附清单");

  // sessionId → 主对话档（SessionStore.load：UUID 校验 + messages 数组校验内建）
  h.sh.sessions.save({
    id: h.rt.id, title: "主对话", updatedAt: new Date().toISOString(), workspace: h.rt.workspace!.root, messageCount: 2,
    totals: { prompt: 0, completion: 0 },
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: null, toolCalls: [] },
    ],
  });
  const bySession = resolve1({ sessionId: h.rt.id });
  assert.ok(bySession.ok && bySession.label.includes("主对话") && bySession.messages.length === 2, "sessionId 读主对话档");
  const bad = resolve1({ sessionId: "../../etc/passwd" });
  assert.ok(!bad.ok, "非法 sessionId 拒绝（UUID 校验）");

  // 旧格式兼容：裸 {messages}（docs/6 P3 原版）存档照常解析（docs/17 宽容读取）
  const oldDir = join(h.sh.sessions.spillDir(h.rt.id)!, "sub-2-old");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "transcript.json"), JSON.stringify({ messages: [{ role: "user", content: "旧档任务" }] }), "utf8");
  h.rt.subagents.push({ subId: 2, name: "old", ok: true, transcript: join("sub-2-old", "transcript.json"), at: new Date().toISOString() });
  const byOld = resolve1({ subId: 2 });
  assert.ok(byOld.ok && byOld.messages.some((m) => m.content === "旧档任务"), "旧格式裸 {messages} 存档可读");
});

test("docs/9 maxTasks：追加任务达上限（subagentMaxTasks）后 followup 立即拒绝（不排队；docs/16 同步回执）", async () => {
  const llm = new ScriptProvider(Array.from({ length: SUBAGENT_MAX_TASKS + 2 }, () => ({ content: "ok 报告", toolCalls: [], usage: null })));
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "首任务", description: "d", reusable: true }).ok);
  await waitForInbox(h.rt);
  for (let i = 0; i < SUBAGENT_MAX_TASKS - 1; i++) {
    const r = svc.followup({ subId: 1 }, { task: `追加${i}` });
    if (!r.ok) assert.fail(`第 ${i + 2} 次派发应受理：${r.error}`);
    await waitForInbox(h.rt, i + 2); // 等上一次任务结算（idle 后才能再追加）
  }
  assert.equal(h.rt.subagents[0]!.tasks, SUBAGENT_MAX_TASKS);
  const capped = svc.followup({ subId: 1 }, { task: "超限" });
  assert.ok(!capped.ok && capped.error.includes("任务次数上限"), "超限派发立即拒绝");
});

test("docs/9 seq 续期：新 worker 从记录最大 subId+1 编号（防可复用 upsert 撞号）", async () => {
  const h = makeHarness([{ content: "ok", toolCalls: [], usage: null }]);
  h.rt.subagents.push({ subId: 3, name: "old", ok: true, at: new Date().toISOString() });
  h.rt.subagentTotal = 1;
  const svc = subagentServiceFor(h.sh, h.rt);
  const d = svc.dispatch({ task: "新任务", description: "d" });
  assert.ok(d.ok && d.subId === 4, "重启后 seq 不归零（从记录最大 subId 续期）");
  await waitForInbox(h.rt);
  assert.equal(h.rt.subagents[1]!.subId, 4);
});

test("docs/9 执行中归档：中止当前任务后归档（不转 idle）；失败归因为归档中止", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) =>
      new Promise<ChatResult>((_, reject) => {
        chats++;
        // 预检：中止先于请求到达（对齐库内既有 abortable 桩——已中止信号不触发 abort 事件，须显式拒绝）
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const svc = subagentServiceFor(h.sh, h.rt);
  const d = svc.dispatch({ task: "长任务", description: "d", name: "victim", reusable: true });
  assert.ok(d.ok);
  for (let i = 0; i < 200 && chats < 1; i++) await sleep(5); // 等首任务确已启动（装配窗口之后）
  assert.equal(chats, 1, "首任务 LLM 请求已发出（archive 落在任务执行窗口）");
  const archMsg = applySubagentControl(h.rt, { subId: 1 }, "archive");
  assert.ok(archMsg.includes("已请求归档"), archMsg);
  // 真实收尾结果经收件箱送达：归档中止 + 归档说明（不误报待命）
  const report = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(report.includes("[子代理任务报告 · 自动送达]"), report);
  assert.ok(report.includes("任务被归档请求中止"), report);
  assert.ok(report.includes("已按归档请求归档"), report);
  assert.ok(!report.includes("已保留待命"), "归档收尾不得再输出待命提示");
  assert.equal(h.rt.subagents[0]!.state, "archived", "归档收尾（不转 idle）");
  assert.equal(h.rt.activeSubagents.size, 0);
  assert.deepEqual(subPhases(h, 1), ["spawned", "archived"], "执行中归档：中止当前任务后归档收尾");
  const again = applySubagentControl(h.rt, { subId: 1 }, "archive");
  assert.ok(again.includes("没有匹配"), "归档后句柄注销，再归档按 miss 处理");
});

test("docs/9 装配窗口归档：派发后立即归档——不执行首任务直接归档（零 LLM 调用）", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) => {
      chats++;
      return new Promise<ChatResult>((_, reject) => {
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const svc = subagentServiceFor(h.sh, h.rt);
  const d = svc.dispatch({ task: "不该跑的任务", description: "d", name: "early", reusable: true });
  assert.ok(d.ok, "派发同步受理（句柄注册在 tryStartWorker 同步段）");
  const msg = h.rt.activeSubagents.get(1)!.requestArchive?.(); // 同步段落在装配窗口（Agent 未就绪）
  assert.ok(msg?.includes("已请求归档"), msg);
  const report = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(report.includes("[子代理任务报告 · 自动送达]"), report);
  assert.ok(report.includes("任务未开始：派发后即被归档"), report);
  assert.equal(chats, 0, "任务未开始（零 LLM 调用）");
  assert.ok(!report.includes("轮"), "任务未执行任何轮次（无轮数统计）");
  assert.equal(h.rt.subagents[0]!.state, "archived");
  assert.equal(h.rt.activeSubagents.size, 0);
  const phases = subPhases(h, 1);
  assert.equal(phases.join("→"), "spawned→archived");
});

test("docs/9 applySubagentControl 边界：可复用 idle 无可打断对象；运行中一次性子代理不支持手动归档", async () => {
  // 可复用 idle：stop 无对象
  const h1 = makeHarness([{ content: "ok", toolCalls: [], usage: null }]);
  const svc1 = subagentServiceFor(h1.sh, h1.rt);
  assert.ok(svc1.dispatch({ task: "t", description: "d", reusable: true, name: "idle-one" }).ok);
  await waitForInbox(h1.rt); // 等结算转 idle
  assert.ok(applySubagentControl(h1.rt, { subId: 1 }, "stop").includes("空闲待命"));

  // 运行中一次性：archive 明确不支持（一次性自动归档）
  const h2 = makeHarness([]);
  const ctl = new AbortController();
  (h2.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) =>
      new Promise<ChatResult>((_, reject) => {
        if (p.signal?.aborted) return reject(new Error("aborted")); // 信号先于请求到达（装配窗口中止）
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const svc2 = subagentServiceFor(h2.sh, h2.rt);
  assert.ok(svc2.dispatch({ task: "长任务", description: "d", name: "once-run" }, ctl.signal).ok);
  for (let i = 0; i < 100 && h2.rt.activeSubagents.size === 0; i++) await sleep(5);
  const archOnce = applySubagentControl(h2.rt, { subId: 1 }, "archive");
  assert.ok(archOnce.includes("一次性子代理"), archOnce);
  assert.ok(archOnce.includes("once-run#1"));
  ctl.abort();
  for (let i = 0; i < 100 && h2.rt.activeSubagents.size > 0; i++) await sleep(5);
  await waitForInbox(h2.rt); // 收尾报告送达（失败归因中止）
  assert.equal(h2.rt.activeSubagents.size, 0);
});

// ---------- docs/10 R1：子代理上下文治理（记录 / followup 门槛 / 强制归档） ----------

test("docs/10 R1：任务收尾的 contextPct 进送达报告/记录/事件（大上下文 → 占比≈0 正常待命）", async () => {
  const h = makeHarness([{ content: "报告", toolCalls: [], usage: null }], { contextLength: 10_000_000 });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "t", description: "d", reusable: true, name: "ctx-ok" }).ok);
  const report = (await waitForInbox(h.rt))[0] ?? "";
  const m = /上下文 (\d+)%/.exec(report);
  assert.ok(m, `送达报告带 contextPct：${report.slice(0, 120)}`);
  const pct = Number(m![1]);
  assert.ok(pct >= 0 && pct <= 100);
  assert.ok(!report.includes("已自动归档"), "占比≈0 不触发强制归档");
  const rec = h.rt.subagents.find((x) => x.subId === 1);
  assert.ok(rec, "idle 记录存在");
  assert.equal(rec!.state, "idle");
  assert.equal(rec!.contextPct, pct, "记录与报告同值");
  const idleEv = h.broadcasts.filter((b) => b.event === "subagent" && (b.data as { phase: string }).phase === "idle");
  assert.equal((idleEv[0]!.data as { contextPct?: number }).contextPct, pct, "idle 事件载荷带 contextPct");
  // currentState 的 activeSubagents 快照（session-runtime 映射 active.contextPct）
  const active = h.rt.activeSubagents.get(1);
  assert.equal(active?.contextPct, pct, "活动句柄带 contextPct");
});

test("docs/10 R1：上下文 > 归档线（50%）→ 任务完成后强制归档（不转 idle；送达报告替换为归档说明）", async () => {
  // contextLength 极小 → 占比夹到 100%，必然 > 50
  const h = makeHarness([{ content: "报告", toolCalls: [], usage: null }], { contextLength: 100 });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "t", description: "d", reusable: true, name: "ctx-fat" }).ok);
  const report = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(report.includes("任务本身成功") || report.includes("[子代理 ctx-fat 完成]"), "报告正常交付");
  assert.ok(report.includes("上下文 100%"), report);
  assert.ok(report.includes("已自动归档"), "送达报告为强制归档说明（非待命提示）");
  assert.ok(!report.includes("已保留待命"), report);
  const rec = h.rt.subagents.find((x) => x.subId === 1);
  assert.equal(rec!.state, "archived", "记录定格 archived");
  assert.equal(h.rt.activeSubagents.size, 0, "句柄注销");
  const phases = h.broadcasts.filter((b) => b.event === "subagent").map((b) => (b.data as { phase: string }).phase);
  assert.ok(phases.includes("archived") && !phases.includes("idle"), `事件序列应 spawned→archived：${phases}`);
  // 归档后 followup 得到「已归档」文案（驻留已释放）
  const f = svc.followup({ subId: 1 }, { task: "再干" });
  assert.ok(!f.ok);
  assert.ok(f.error!.includes("已归档"), f.error);
});

test("docs/10 R1：followup 对上下文 ≥35% 的待命实例拒绝（含指引与过程档案链接）", async () => {
  // 校准：contextLength=2000，任务书拉长使占比落进 [35,50]（不触发强制归档但过 followup 门槛）
  const longTask = "背景：" + "detail ".repeat(190) + "目标：完成校准任务并报告。";
  const h = makeHarness([{ content: "报告", toolCalls: [], usage: null }], { contextLength: 2_000 });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: longTask, description: "d", reusable: true, name: "ctx-mid" }).ok);
  const report = (await waitForInbox(h.rt))[0] ?? "";
  const m = /上下文 (\d+)%/.exec(report);
  assert.ok(m, "报告带占比");
  const pct = Number(m![1]);
  assert.ok(pct >= 35 && pct <= 50, `占比应落 [35,50]，实际 ${pct}%`);
  assert.ok(!report.includes("已自动归档"), `占比 ${pct}% 不应超过归档线（校准失败请调任务书长度）`);
  const rec = h.rt.subagents.find((x) => x.subId === 1);
  assert.equal(rec!.state, "idle", "仍正常待命");
  const f = svc.followup({ subId: 1 }, { task: "追加" });
  assert.ok(!f.ok);
  assert.ok(f.error!.includes("35"), `拒绝文案含门槛：${f.error}`);
  assert.ok(f.error!.includes("[[过程档案#1]]"), "文案含过程存档接续指引");
  assert.ok(f.error!.includes("归档"));
});

test("docs/10 R1：一次性子代理也带 contextPct（纯观测；done 事件与审计记录）", async () => {
  const h = makeHarness([{ content: "报告", toolCalls: [], usage: null }], { contextLength: 10_000_000 });
  const r = await runWorker(h.sh, h.rt, { task: "t", description: "d" }, { seq: 1 });
  assert.ok(r.ok);
  assert.equal(typeof r.contextPct, "number");
  const rec = h.rt.subagents.find((x) => x.subId === 1);
  assert.equal(rec!.state, "archived");
  assert.equal(rec!.contextPct, r.contextPct);
  const doneEv = h.broadcasts.filter((b) => b.event === "subagent" && (b.data as { phase: string }).phase === "done");
  assert.equal((doneEv[0]!.data as { contextPct?: number }).contextPct, r.contextPct);
});

test("docs/10 R1 修订：占用落 (30,35) 待命正常且 followup 照常受理（预警不拒收）", async () => {
  // 校准：contextLength=2000、任务书 repeat(390) 使占比落 ~32%（>30 预警、<35 不拒）
  const task = "背景：" + "detail ".repeat(25) + "目标：完成并报告。";
  const h = makeHarness([{ content: "报告", toolCalls: [], usage: null }, { content: "第二次报告", toolCalls: [], usage: null }], { contextLength: 2_000 });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task, description: "d", reusable: true, name: "ctx-warn" }).ok);
  const report = (await waitForInbox(h.rt))[0] ?? "";
  const m = /上下文 (\d+)%/.exec(report);
  assert.ok(m, "报告带占比");
  const pct = Number(m![1]);
  assert.ok(pct > 30 && pct < 35, `占比应落 (30,35)，实际 ${pct}%（校准漂移请调任务书长度）`);
  assert.ok(report.includes("上下文过长预警"), "过预警线附警告（报告文本自带）");
  assert.ok(!report.includes("已自动归档"));
  assert.equal(h.rt.subagents.find((x) => x.subId === 1)!.state, "idle", "仍待命");
  // followup 照常受理（预警≠拒收）并正常完成第二任务
  const f = svc.followup({ subId: 1 }, { task: "短追加任务" });
  assert.ok(f.ok, "30-35 区间不拒收");
  await waitForInbox(h.rt, 2);
  assert.ok(((h.rt.inbox ?? [])[1] ?? "").includes("第 2 次任务"), "第二份送达报告标注第 2 次任务");
});

test("docs/10 R1 修订：运行中句柄 liveContextPct 实时可用（一直显示的出口）", async () => {
  const h = makeHarness([], { contextLength: 2_000 });
  const ctl = new AbortController();
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "hang",
    chat: (p2) =>
      new Promise<ChatResult>((_, reject) => {
        // 永不主动返回：worker 停在运行态；abort 信号到达即 reject（收尾不悬空，库内桩惯例）
        if (p2.signal?.aborted) return reject(new Error("aborted"));
        p2.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "长任务", description: "d", name: "live-ctx" }, ctl.signal).ok); // signal 必传：外部中止要接进 worker
  let handle = h.rt.activeSubagents.get(1); // 等装配完成（Agent 就绪后 liveContextPct 才有值）
  for (let i = 0; i < 200 && !(handle && handle.liveContextPct?.() !== undefined); i++) {
    await sleep(5);
    handle = h.rt.activeSubagents.get(1);
  }
  const pct = handle!.liveContextPct?.();
  assert.equal(handle!.status, "run");
  assert.equal(typeof pct, "number", "运行中可实时取值（Agent 装配完成后）");
  assert.ok(pct! > 0 && pct! <= 100, `估算落 (0,100]，实际 ${pct}%（任务书+系统提示已入历史）`);
  ctl.abort();
  for (let i = 0; i < 100 && h.rt.activeSubagents.size > 0; i++) await sleep(5); // 收尾不悬空
  assert.equal(h.rt.activeSubagents.size, 0);
});

// ---------- docs/11 W1：子代理异常变动报告协调者（暂停先行返回 + 延迟报告送达） ----------

/** 挂起-可中止提供方：每轮挂起直到信号 abort；第 skip 次之后的调用直接给结论（resume 重发即完成）。 */
function hangThenAnswerProvider(answerAfter: number, answer: string): { llm: LLMProvider; chats: () => number } {
  let chats = 0;
  return {
    chats: () => chats,
    llm: {
      name: "hang-abortable",
      chat: (p) => {
        chats++;
        return new Promise<ChatResult>((res, rej) => {
          if (p.signal?.aborted) return rej(new Error("aborted")); // 预检：中止先于请求到达（docs/10 已知桩坑）
          if (chats > answerAfter) return res({ content: answer, toolCalls: [], usage: null });
          p.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        });
      },
    },
  };
}

test("docs/16：一次性 worker 的真实报告经收件箱送达（含已归档注记）；派发即时返回", async () => {
  const llm = new ScriptProvider([{ content: "最终报告：完成", toolCalls: [], usage: null }]);
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  const d = svc.dispatch({ task: "长任务", description: "d", name: "one" });
  assert.ok(d.ok && d.subId === 1 && d.name === "one", "派发同步受理（回执即时）");
  const report = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(report.startsWith("[子代理任务报告 · 自动送达]"), report);
  assert.ok(report.includes("[子代理 one 完成]"), report);
  assert.ok(report.includes("最终报告：完成"), report);
  assert.ok(report.includes("已自动归档"), "一次性子代理结束状态显式送达（空回复/归档可见）");
  assert.ok(!report.includes("已保留待命"), "一次性报告不带待命提示");
  assert.equal(h.rt.subagents[0]!.state, "archived");
  assert.equal(h.rt.activeSubagents.size, 0, "一次性完成后注销句柄");
  assert.deepEqual(subPhases(h, 1), ["spawned", "done"]);
});
test("docs/14：自动送达报告自带上下文用量与 >25% 预警（治理说明只随报告走，协调者系统提示不再预先描述）", async () => {
  // 校准（参照 docs/10 R1 组 followup 门槛测试的 [35,50] 手法，任务书缩短使占比落 (25,35)：
  // 过预警线、未到拒收线 → 待命提示 + ⚠ 预警并存）
  const longTask = "背景：" + "detail ".repeat(30) + "目标：完成并报告。";
  const llm = new ScriptProvider([{ content: "最终报告：完成", toolCalls: [], usage: null }]);
  const h = makeHarness([], { llm, contextLength: 2_000 });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: longTask, description: "d", name: "warned", reusable: true }).ok);
  await waitForInbox(h.rt);
  const report = (h.rt.inbox ?? [])[0] ?? "";
  assert.ok(report.startsWith("[子代理任务报告 · 自动送达]"), report);
  // 用量随报告自动附带——协调者无需（也不应）向子代理索要：占用是宿主侧算的，子代理不知道
  const m = /上下文 (\d+)%/.exec(report);
  assert.ok(m, `报告应含「上下文 N%」用量行：${report.slice(0, 120)}`);
  const pct = Number(m![1]);
  assert.ok(pct > 25 && pct < 35, `校准漂移：实际占比 ${pct}%（应落 (25,35) 触发预警分支；漂了请调任务书长度）`);
  assert.ok(report.includes("⚠ 上下文过长预警"), "过预警线多加一条警告（docs/14 用户要求）");
  assert.ok(report.includes("已保留待命"), "未达拒收线：待命提示与预警并存");
});

test("docs/11 W1：多份报告按完成顺序 FIFO 送达（两个可复用 worker 按放行时序先后完成）", async () => {
  // 路由闸门提供方：按任务书标记 TASK-a/TASK-b 分流，各自的 chat 挂起直到对应 release
  const gates = new Map<string, { p: Promise<void>; r: () => void }>();
  const gateOf = (k: string) => {
    let g = gates.get(k);
    if (!g) {
      let r!: () => void;
      const p = new Promise<void>((res) => (r = res));
      g = { p, r };
      gates.set(k, g);
    }
    return g;
  };
  const llm: LLMProvider = {
    name: "routed-gated",
    chat: (p) => {
      const users = p.messages.filter((m) => m.role === "user");
      const key = /TASK-([ab])/.exec(String(users[users.length - 1]?.content ?? ""))?.[1] ?? "a";
      const g = gateOf(key);
      return new Promise<ChatResult>((res, rej) => {
        if (p.signal?.aborted) return rej(new Error("aborted"));
        const onAbort = () => rej(new Error("aborted"));
        p.signal?.addEventListener("abort", onAbort, { once: true });
        void g.p.then(() => {
          p.signal?.removeEventListener("abort", onAbort);
          if (p.signal?.aborted) rej(new Error("aborted"));
          else res({ content: `报告：${key} 完成`, toolCalls: [], usage: null });
        });
      });
    },
  };
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "TASK-a", description: "d", name: "wa", reusable: true }).ok);
  assert.ok(svc.dispatch({ task: "TASK-b", description: "d", name: "wb", reusable: true }).ok);
  for (let i = 0; i < 200 && gates.size < 2; i++) await sleep(5); // 两个 worker 都已发出首请求
  // 先放行 wa——它先完成；wb 仍挂起
  gateOf("a").r();
  let inbox = await waitForInbox(h.rt);
  assert.equal(inbox.length, 1, "先完成者先送达");
  assert.ok(inbox[0]!.includes("[子代理 wa 完成]"), inbox[0]);
  assert.ok(inbox[0]!.includes("已保留待命"), "可复用报告带待命提示");
  // 再放行 wb——报告追加在队列尾（FIFO）
  gateOf("b").r();
  inbox = await waitForInbox(h.rt, 2);
  assert.equal(inbox.length, 2);
  assert.ok(inbox[1]!.includes("[子代理 wb 完成]"), inbox[1]);
  assert.ok(inbox[1]!.includes("已保留待命"), inbox[1]);
});

test("docs/16：followup 任务同样非阻塞——第 2 次任务报告完成后送达", async () => {
  const llm = new ScriptProvider([
    { content: "报告一", toolCalls: [], usage: null },
    { content: "报告二", toolCalls: [], usage: null },
  ]);
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "任务一", description: "d", name: "spec", reusable: true }).ok);
  await waitForInbox(h.rt);
  const df = svc.followup({ name: "spec" }, { task: "任务二", description: "追加" });
  assert.ok(df.ok, "followup 派发同步受理");
  const report = (await waitForInbox(h.rt, 2))[1] ?? "";
  assert.ok(report.includes("[子代理 spec 完成]"), report);
  assert.ok(report.includes("第 2 次任务"), report);
  assert.ok(report.includes("报告二"), report);
  assert.equal(h.rt.subagents[0]!.tasks, 2);
});

test("docs/11 W1：界面归档空闲可复用子代理 → 状态通知送达；工具路径（model）不重复送", async () => {
  const llm = new ScriptProvider([
    { content: "报告", toolCalls: [], usage: null },
    { content: "报告", toolCalls: [], usage: null },
  ]);
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "任务一", description: "d", name: "s1", reusable: true }).ok);
  await waitForInbox(h.rt);
  assert.ok(svc.dispatch({ task: "任务二", description: "d", name: "s2", reusable: true }).ok);
  await waitForInbox(h.rt, 2);
  // 工具路径（缺省 via=model）：返回文案即报告，收件箱不送
  const msgTool = applySubagentControl(h.rt, { subId: 1 }, "archive");
  assert.ok(msgTool.includes("已归档子代理：s1#1"), msgTool);
  assert.equal(h.rt.inbox?.length ?? 0, 2, "工具路径不重复送达（收件箱只有两份任务报告）");
  // 界面路径（via=ui）：协调者看不见的异常变动 → 收件箱送达状态通知
  const msgUi = applySubagentControl(h.rt, { subId: 2 }, "archive", "ui");
  assert.ok(msgUi.includes("已归档子代理：s2#2"), msgUi);
  const notice = (await waitForInbox(h.rt, 3))[2] ?? "";
  assert.ok(notice.startsWith("[子代理状态 · 自动送达]"), notice);
  assert.ok(notice.includes("s2#2"), notice);
  assert.ok(notice.includes("已被用户归档"), notice);
  assert.ok(notice.includes("不可再用 agent_followup"), notice);
});

test("docs/18：界面打断运行中子代理 → 状态通知送达且失败报告不送（协调者只收一条）；工具路径不重复送", async () => {
  let chats = 0;
  const h = makeHarness([]);
  (h.rt as unknown as { llm: LLMProvider }).llm = {
    name: "abortable",
    chat: (p) => {
      chats++;
      return new Promise<ChatResult>((_, reject) => {
        if (p.signal?.aborted) return reject(new Error("aborted"));
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "长任务", description: "d", name: "ui-stopped" }).ok);
  for (let i = 0; i < 100 && chats < 1; i++) await sleep(5);
  // 工具路径（缺省 via=model）：返回文案已抵达协调者，收件箱不送（报告也跳过——打断结算）
  const msgTool = applySubagentControl(h.rt, { subId: 1 }, "stop");
  assert.ok(msgTool.includes("已打断子代理：ui-stopped#1"), msgTool);
  assert.ok(msgTool.includes("agent_followup"), "返回文案指引接续方式");
  for (let i = 0; i < 100 && h.rt.workers.size > 0; i++) await sleep(5);
  assert.equal(h.rt.inbox?.length ?? 0, 0, "工具路径不重复送达（失败报告也跳过）");
  assert.equal(h.rt.subagents[0]!.state, "archived", "一次性打断结算即归档");
  // 界面路径（via=ui）：打断是协调者看不见的异常变动 → 收件箱送达状态通知（唯一一条）
  assert.ok(svc.dispatch({ task: "第二个长任务", description: "d", name: "ui-stopped2" }).ok);
  for (let i = 0; i < 100 && h.rt.activeSubagents.size < 1; i++) await sleep(5);
  const msgUi = applySubagentControl(h.rt, { subId: 2 }, "stop", "ui");
  assert.ok(msgUi.includes("已打断子代理：ui-stopped2#2"), msgUi);
  const notice = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(notice.startsWith("[子代理状态 · 自动送达]"), notice);
  assert.ok(notice.includes("已被用户打断"), notice);
  assert.ok(notice.includes("已随之归档"), "一次性子代理的打断通知说明已归档（无 followup 指引）");
  for (let i = 0; i < 100 && h.rt.workers.size > 0; i++) await sleep(5);
  assert.equal(h.rt.inbox?.length ?? 0, 1, "打断结算的失败报告不送达（一次操作一条消息）");
});

test("docs/16：快速完成的任务报告照常送达（结算即送达，与暂停/恢复无关）", async () => {
  const llm = new ScriptProvider([{ content: "真实报告", toolCalls: [], usage: null }]);
  const h = makeHarness([], { llm });
  const svc = subagentServiceFor(h.sh, h.rt);
  assert.ok(svc.dispatch({ task: "快任务", description: "d", name: "fast", reusable: true }).ok);
  const report = (await waitForInbox(h.rt))[0] ?? "";
  assert.ok(report.includes("真实报告"), "完成报告正常送达");
  assert.ok(report.includes("[子代理 fast 完成]"), report);
  const miss = applySubagentControl(h.rt, { subId: 1 }, "stop");
  assert.ok(miss.includes("空闲待命"), "完成后已转 idle——没有可打断的对象");
});

// ---------- docs/16：轮末排空的相邻自动送达报告合并（takeCoordinatorTurnText） ----------

/** inbox 测试桩：只需 inbox 字段（takeCoordinatorTurnText 只消费它）。 */
function inboxRt(inbox: string[]): SessionRuntime {
  return { inbox } as unknown as SessionRuntime;
}

test("docs/16 isAutoReport：两类送达前缀识别；普通文本（含用户消息）不误判", () => {
  assert.ok(isAutoReport("[子代理任务报告 · 自动送达]\n[子代理 a 完成] …"));
  assert.ok(isAutoReport("[子代理状态 · 自动送达] 子代理 a#1 已被用户暂停…"));
  assert.ok(!isAutoReport("帮我看看这个报错"));
  assert.ok(!isAutoReport("[子代理 a 完成] 用时 3s"), "报告正文（无送达前缀）不算");
});

test("docs/16 takeCoordinatorTurnText：队头用户消息不合并；队头报告吞并其后连续报告；遇用户消息停", () => {
  // 用户消息打头：一次只取一条（W2-L1 FIFO 不变）
  const rt1 = inboxRt(["帮我改下文档", "[子代理任务报告 · 自动送达] R1", "[子代理任务报告 · 自动送达] R2"]);
  assert.equal(takeCoordinatorTurnText(rt1), "帮我改下文档");
  assert.deepEqual(rt1.inbox, ["[子代理任务报告 · 自动送达] R1", "[子代理任务报告 · 自动送达] R2"]);
  // 报告打头：连续报告合并为一条（分隔线连接），遇用户消息停
  const rt2 = inboxRt(["[子代理任务报告 · 自动送达] R1", "[子代理状态 · 自动送达] N2", "[子代理任务报告 · 自动送达] R3", "用户插话"]);
  const merged = takeCoordinatorTurnText(rt2);
  assert.ok(merged.includes("R1") && merged.includes("N2") && merged.includes("R3"), merged);
  assert.ok(!merged.includes("用户插话"), "用户消息不并入");
  assert.ok(merged.includes("――――"), "多份报告以分隔线连接");
  assert.deepEqual(rt2.inbox, ["用户插话"]);
  // 单条报告：原样返回（不加分隔线）
  const rt3 = inboxRt(["[子代理任务报告 · 自动送达] R1", "用户插话"]);
  assert.equal(takeCoordinatorTurnText(rt3), "[子代理任务报告 · 自动送达] R1");
  assert.deepEqual(rt3.inbox, ["用户插话"]);
  // 空收件箱防御
  assert.equal(takeCoordinatorTurnText(inboxRt([])), "");
  assert.equal(takeCoordinatorTurnText({} as unknown as SessionRuntime), "");
});

test("makeWorkerUi（docs/28 P2-1/P2-2）：delta 节流批 + ml 锚点 + 工具事件带完整参数与强制 flush", async () => {
  const broadcasts: { event: string; data: Record<string, unknown> }[] = [];
  const sh = { broadcast: (event: string, data: unknown) => broadcasts.push({ event, data: data as Record<string, unknown> }) } as unknown as SessionShell;
  const rt = { id: "sess-1" } as SessionRuntime;
  const ws = {
    subId: 3,
    name: "alpha",
    agent: { messages: [{ role: "user", content: "任务书" }] },
    cur: null,
  } as unknown as WorkerSession;
  const ui = makeWorkerUi(sh, rt, ws);
  // 未到 flush 窗口：增量只进缓冲不广播
  ui.printReasoningDelta("思");
  ui.printReasoningDelta("考");
  ui.printTextDelta("文");
  ui.printTextDelta("字");
  assert.equal(broadcasts.length, 0, "120ms 窗口内不广播（事件量控制）");
  // 工具调用强制 flush：先 delta（reasoning+content 两条）再 tool，顺序保证
  ui.printToolCall("edit_file", '{"path":"a.ts"}', "call-1", '{"path":"a.ts","old_string":"x","new_string":"y"}');
  assert.deepEqual(
    broadcasts.map((b) => b.data.phase),
    ["delta", "delta", "tool"],
    "强制 flush 顺序：思考 → 文字 → 工具",
  );
  const d1 = broadcasts[0]!.data as { kind: string; text: string; ml: number };
  const d2 = broadcasts[1]!.data as { kind: string; text: string; ml: number };
  const t1 = broadcasts[2]!.data as { args?: string };
  assert.equal(d1.kind, "reasoning");
  assert.equal(d1.text, "思考", "同窗口增量合并成一条");
  assert.equal(d1.ml, 1, "ml 锚点=worker 历史长度（切回重放 filterByMl 消费）");
  assert.equal(d2.kind, "content");
  assert.equal(d2.text, "文字");
  assert.equal(t1.args, '{"path":"a.ts","old_string":"x","new_string":"y"}', "完整参数随 tool 事件（P2-2）");
  // 缓冲已清：后续增量等定时器自行 flush
  ui.printReasoningDelta("后");
  assert.equal(broadcasts.length, 3, "flush 后缓冲清空");
  await sleep(150);
  assert.equal(broadcasts.length, 4, "定时器到点刷出");
  const d3 = broadcasts[3]!.data as { phase: string; kind: string; text: string };
  assert.equal(d3.phase, "delta");
  assert.equal(d3.kind, "reasoning");
  assert.equal(d3.text, "后");
  // 超长 args 截断（TOOL_EVENT_ARGS_MAX_CHARS）
  ui.printToolCall("write_file", "{}", "call-2", JSON.stringify({ content: "x".repeat(TOOL_EVENT_ARGS_MAX_CHARS + 500) }));
  const t2 = broadcasts[broadcasts.length - 1]!.data as { args?: string };
  assert.ok((t2.args ?? "").length < TOOL_EVENT_ARGS_MAX_CHARS + 500 && (t2.args ?? "").includes("截断"), "超长参数截断 + 标记");
  // 无 args 的调用（旧签名/桩）不携带字段
  ui.printToolCall("zz_echo", "{}", "call-3");
  const t3 = broadcasts[broadcasts.length - 1]!.data as { args?: string };
  assert.equal(t3.args, undefined, "未传 args 不带字段");
});

// ---------- docs/32：subagent_status 历史记录条数上限（阈值键 subagentStatusHistoryMax，默认 20） ----------

test("subagentStatusText：all=true 只附最近 SUBAGENT_STATUS_HISTORY_MAX 条（默认 20），表头带总数、all=false 提示可传", () => {
  const h = makeHarness([], {});
  for (let i = 1; i <= 25; i++) {
    h.rt.subagents.push({ subId: i, name: `s${i}`, ok: true, state: "archived", at: `2026-11-17T20:${String(i % 60).padStart(2, "0")}:00` });
  }
  h.rt.subagentTotal = 25; // 与记录条数一致（空态文案按累计数分流）
  const all = subagentStatusText(h.rt, { all: true });
  assert.ok(all.includes("当前没有活动子代理"), all);
  assert.ok(all.includes("历史记录（最近 20 条 / 共 25 条）"), "表头 = 生效上限与总数（docs/32 阈值键 subagentStatusHistoryMax）");
  assert.ok(all.includes("#25 s25"), "含最新一条");
  assert.ok(all.includes("#6 s6"), "第 20 新 = #6（切片窗口对齐）");
  assert.ok(!all.includes("#5 s5"), "更早的不出现");
  const none = subagentStatusText(h.rt);
  assert.ok(none.includes("需要查看可传 all=true"), "all 缺省时给指引");
  assert.ok(!none.includes("历史记录（最近"), "all 缺省不带历史记录明细段（只在提示句里出现总数）");
});

// ---------- docs/35 真机待办4：休眠待命记录（服务重启后实例不在线）可直接归档 ----------

test("applySubagentControl：休眠待命记录归档——记录定格 archived + archived 事件 + ui 状态通知 + 落盘", () => {
  const h = makeHarness([]);
  h.rt.kind = "coordinator";
  h.rt.subagents.push({
    subId: 5,
    name: "dorm",
    ok: true,
    reusable: true,
    state: "idle",
    tasks: 2,
    rounds: 7,
    usage: { prompt: 100, completion: 40 },
    transcript: "sub-5-dorm/transcript.json",
    contextPct: 9,
    elapsedMs: 8000,
    at: new Date().toISOString(),
  });
  const events: { event: string; data: { phase?: string; subId?: number; tasks?: number } }[] = [];
  const delivered: string[] = [];
  let persisted = 0;
  const msg = applySubagentControl(h.rt, { subId: 5 }, "archive", "ui", {
    broadcast: (event, data) => events.push({ event, data: data as { phase?: string } }),
    deliver: (t) => delivered.push(t),
    persist: () => persisted++,
  });
  assert.ok(msg.includes("已归档子代理：dorm#5"), msg);
  assert.ok(msg.includes("休眠待命"), msg);
  assert.equal(h.rt.subagents.find((r) => r.subId === 5)!.state, "archived", "记录就地定格 archived");
  const ev = events.find((e) => e.event === "subagent");
  assert.equal(ev?.data?.phase, "archived", "archived 事件广播（前端抽屉行翻 📦）");
  assert.equal(ev?.data?.tasks, 2, "事件携带累计任务数");
  assert.ok(delivered[0]!.startsWith("[子代理状态 · 自动送达]"), "ui 路径状态通知送达协调者收件箱");
  assert.ok(delivered[0]!.includes("[[过程档案#5]]"), "有存档时附 read_archive 接续指引");
  assert.equal(persisted, 1, "记录变更落盘");

  // 已归档的记录不再匹配休眠 idle → 回落 miss 文案（幂等）
  const again = applySubagentControl(h.rt, { subId: 5 }, "archive", "ui", {
    broadcast: () => {},
    deliver: () => {},
    persist: () => {},
  });
  assert.ok(again.startsWith("没有匹配"), again);
});

test("applySubagentControl：休眠待命记录不参与 stop（没有运行实例可打断）；io 缺席（测试直调）只改记录", () => {
  const h = makeHarness([]);
  h.rt.kind = "coordinator";
  h.rt.subagents.push({ subId: 6, name: "dorm2", ok: true, reusable: true, state: "idle", at: new Date().toISOString() });
  const stopMsg = applySubagentControl(h.rt, { subId: 6 }, "stop", "ui");
  assert.ok(stopMsg.startsWith("没有匹配"), stopMsg);
  // io 缺席：归档仍生效（无广播/送达/落盘副作用）
  const msg = applySubagentControl(h.rt, { subId: 6 }, "archive", "model");
  assert.ok(msg.includes("已归档子代理：dorm2#6"), msg);
  assert.equal(h.rt.subagents.find((r) => r.subId === 6)!.state, "archived");
});
