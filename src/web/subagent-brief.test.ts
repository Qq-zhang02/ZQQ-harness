/**
 * 子代理家族 docs/42 测试（subagent-brief.ts 及其接线）：
 *  - 唤醒简报：复活/追加任务时任务书前的系统简报（做到哪 / 上次活动后范围内谁改了什么 / 看过哪些图）
 *  - 已读台账回填：复活的新实例编辑「未变动的自建文件」免重读；被改过的仍须先读（A3/B2）
 *  - 派发回执附注：同范围已有可唤醒实例（C5）、并发占用、近期限流（B4）
 *  - 提供方限流：失败归因归类 + 报告建议 + 状态表记录
 *  - 只读子代理（A6）：不装写入工具与 MCP、run_pwsh 钉死只读沙箱、随存档/复活还原
 *  - 重复打断的状态通知去重（B6）
 * 全部走真实文件工具（write_file/edit_file）与真实存档落盘，只把 LLM 换成脚本桩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { buildContext } from "../core/context.ts";
import { loadConfig } from "../config.ts";
import { createFileLedger } from "../core/file-tools.ts";
import { progressFactsOf } from "../core/progress.ts";
import { toolAgentTask } from "../modules/tools/agent-task/index.ts";
import { toolEditFile } from "../modules/tools/edit-file/index.ts";
import { toolPwsh } from "../modules/tools/pwsh/index.ts";
import { toolReadFile } from "../modules/tools/read-file/index.ts";
import { toolWriteFile } from "../modules/tools/write-file/index.ts";
import { noBackend, setSandboxRunner } from "../sandbox/runner.ts";
import type { ChatParams, ChatResult, LLMProvider } from "../llm/provider.ts";
import type { SessionRuntime } from "../core/host.ts";
import type { SystemToolDef } from "../core/types.ts";
import { SessionStore } from "./sessions.ts";
import { AttachmentStore } from "./attachments.ts";
import { subagentServiceFor, subagentStatusText } from "./subagents.ts";
import { READONLY_ROLE_SECTION, dispatchNoteOf, filesChangedSince, rehydrateLedger, scopesOverlap, wakeBriefOf } from "./subagent-brief.ts";
import type { SessionShell } from "./session-runtime.ts";

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
    const r = this.script[this.i++] ?? { content: "(脚本耗尽)", toolCalls: [], usage: null };
    return r;
  }
}

const tc = (id: string, name: string, args: Record<string, unknown>): ChatResult => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: null });
/** 一轮里并行发出多个工具调用（同一 ChatResult 的多个 toolCalls）。 */
const tc2 = (a: [string, string, Record<string, unknown>], b: [string, string, Record<string, unknown>]): ChatResult => ({
  content: "",
  toolCalls: [a, b].map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
  usage: null,
});
const done = (content: string): ChatResult => ({ content, toolCalls: [], usage: null });

const echoDef: SystemToolDef = {
  name: "zz_echo",
  summary: "测试回显工具",
  create: () => ({
    name: "zz_echo",
    description: "测试",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: [] },
    async execute(_args, ctx) {
      return `echo:readonly=${String(ctx.readOnly === true)}`;
    },
  }),
};

async function waitForInbox(rt: SessionRuntime, n = 1, ms = 1500): Promise<string[]> {
  for (let i = 0; i < ms / 5 && (rt.inbox?.length ?? 0) < n; i++) await new Promise((r) => setTimeout(r, 5));
  return rt.inbox ?? [];
}

interface Harness {
  sh: SessionShell;
  rt: SessionRuntime;
  root: string;
}

/** 最小壳：真实文件三工具 + run_pwsh + 回显桩；工作区根 = 临时目录（子目录即各 scope）。 */
function makeHarness(llm: LLMProvider, opts?: { approval?: boolean }): Harness {
  const root = mkdtempSync(join(tmpdir(), "zqq-brief-"));
  const ctx = buildContext(
    { userDir: root, globalSkillsDir: join(root, "skills"), globalMcpFile: join(root, "mcp.json"), workspacesFile: join(root, "workspaces.json"), sessionsDir: join(root, "sessions") },
    loadConfig(),
  );
  ctx.tools.register(echoDef);
  toolWriteFile.setup(ctx);
  toolEditFile.setup(ctx);
  toolReadFile.setup(ctx);
  toolPwsh.setup(ctx);
  toolAgentTask.setup(ctx);
  const sh = {
    ctx,
    sessions: new SessionStore(root),
    attachments: new AttachmentStore(root),
    providerFile: { path: "", data: { active: "", providers: [] } },
    runtimes: new Map(),
    viewId: "",
    viewSeq: 0,
    recentWorkspaces: [],
    workspacesFile: join(root, "workspaces.json"),
    userDir: root,
    globalMcpFile: join(root, "mcp.json"),
    sandboxTmpRoot: join(root, "tmp"),
    broadcast: () => {},
  } as unknown as SessionShell;
  const rt = {
    id: "0e0d8f8a-cccc-4bbb-8ccc-dddddddddddd",
    workspace: { root },
    kind: "normal",
    llm,
    settings: { alwaysConfirm: false, effort: "high", askMode: "ask", sandboxMode: "workspace-write" },
    totals: { prompt: 0, completion: 0, cacheHit: 0, reasoning: 0, breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 } },
    auditEvents: [],
    mcp: { status: () => [] },
    fileLedger: createFileLedger(),
    pendingApproval: null as null | ((d: "allowed-once") => void),
    workers: new Set(),
    subagentTotal: 0,
    subagents: [],
    activeSubagents: new Map(),
    agent: { contextEstimate: () => ({ total: 0, breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 } }) },
  } as unknown as SessionRuntime;
  return { sh, rt, root };
}

const toolResultsOf = (p: ChatParams): string[] => p.messages.filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool").map((m) => m.content);
const lastUserOf = (p: ChatParams): string => [...p.messages].reverse().find((m) => m.role === "user")!.content;
/** 把文件 mtime 推到「上次活动之后」（确定性地模拟外部改动发生在任务收尾之后）。 */
const touchFuture = (abs: string): void => {
  const fut = new Date(Date.now() + 60_000);
  utimesSync(abs, fut, fut);
};

// ---------- 唤醒简报 + 台账回填（A3/B2） ----------

test("docs/42 唤醒简报（复活）：任务书前附「做到哪/谁改了什么」；未变动的自建文件回填台账免重读，被改过的仍须先读", async () => {
  const llm = new ScriptProvider([
    tc2(["w1", "write_file", { path: "results/R1/own.md", content: "v1\n" }], ["w2", "write_file", { path: "results/R1/touched.md", content: "a\n" }]),
    done("报告：建好两个文件"),
    // 复活后的任务二（一轮里并行编辑两个文件）
    tc2(["e1", "edit_file", { path: "results/R1/own.md", old_string: "v1", new_string: "v2" }], ["e2", "edit_file", { path: "results/R1/touched.md", old_string: "a", new_string: "b" }]),
    done("报告：续做完成"),
  ]);
  const h = makeHarness(llm);
  try {
    const svc = subagentServiceFor(h.sh, h.rt);
    assert.ok(svc.dispatch({ task: "任务一", description: "建文件", name: "r1", reusable: true, scope: ["results/R1"] }).ok);
    await waitForInbox(h.rt);
    assert.deepEqual(h.rt.subagents[0]!.scope, ["results/R1"], "记录带 scope 快照（派发附注的比对依据）");
    // 任务一收尾之后的外部改动：别人新增一个文件、改写本实例建过的 touched.md
    writeFileSync(join(h.root, "results/R1/other.md"), "by someone else\n");
    writeFileSync(join(h.root, "results/R1/touched.md"), "a\nchanged by another instance\n");
    touchFuture(join(h.root, "results/R1/touched.md"));
    touchFuture(join(h.root, "results/R1/other.md"));
    // 模拟服务重启：实例不在线，记录与存档仍在
    h.rt.activeSubagents.clear();
    const svc2 = subagentServiceFor(h.sh, h.rt);
    assert.ok(svc2.followup({ name: "r1" }, { task: "任务二" }).ok);
    await waitForInbox(h.rt, 2);
    const revived = llm.calls[2]!;
    const task = lastUserOf(revived);
    assert.ok(task.startsWith("[唤醒简报"), `任务书前应有唤醒简报：\n${task.slice(0, 200)}`);
    assert.ok(task.endsWith("任务二"), "原任务书原样接在简报之后");
    assert.ok(task.includes("经文件工具写入 2 个：results/R1/own.md、results/R1/touched.md"), task);
    assert.ok(task.includes("有 2 个文件被改动") && task.includes("results/R1/other.md") && task.includes("results/R1/touched.md"), "范围内被改动的文件如实列出");
    assert.ok(task.includes("已恢复台账，可直接编辑：results/R1/own.md"), "未变动的自建文件回填台账");
    assert.ok(task.includes("此后被改动的 1 个文件未恢复台账（results/R1/touched.md）"), "被改过的不回填并说明");
    // 行为验证：own.md 免重读直接编辑成功；touched.md 被拒「未读取过」
    // （复活后的请求带着完整历史——任务一的 w1/w2 结果也在 tool 消息里，只看最后两条）
    const results = toolResultsOf(llm.calls[3]!).slice(-2);
    assert.ok(results[0]!.startsWith("已编辑"), `未变动文件免重读：${results[0]}`);
    assert.ok(results[1]!.includes("本会话未读取过"), `被改过的文件必须先读：${results[1]}`);
    assert.equal(readFileSync(join(h.root, "results/R1/own.md"), "utf8"), "v2\n");
    assert.equal(readFileSync(join(h.root, "results/R1/touched.md"), "utf8"), "a\nchanged by another instance\n", "被改过的文件未被盲写覆盖");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("docs/42 唤醒简报（在线待命实例追加任务）：附范围内自上次收尾以来的磁盘变动；自身台账完好不回填", async () => {
  const llm = new ScriptProvider([tc("c1", "zz_echo", { value: "1" }), done("报告一"), tc("c2", "zz_echo", { value: "2" }), done("报告二")]);
  const h = makeHarness(llm);
  try {
    const svc = subagentServiceFor(h.sh, h.rt);
    assert.ok(svc.dispatch({ task: "任务一", description: "d", name: "r2", reusable: true, scope: ["results/R2"] }).ok);
    await waitForInbox(h.rt);
    mkdirSync(join(h.root, "results/R2"), { recursive: true });
    writeFileSync(join(h.root, "results/R2/new.md"), "x");
    touchFuture(join(h.root, "results/R2/new.md"));
    assert.ok(svc.followup({ name: "r2" }, { task: "任务二" }).ok);
    await waitForInbox(h.rt, 2);
    const task = lastUserOf(llm.calls[2]!);
    assert.ok(task.startsWith("[唤醒简报") && task.includes("results/R2/new.md") && task.endsWith("任务二"), task);
    assert.ok(!task.includes("已恢复台账"), "在线实例的台账完好，不做回填");
    assert.ok(task.includes("范围内有 1 个文件被改动"), task);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

// ---------- 派发回执附注（C5 同范围可唤醒实例 / B4 并发与限流） ----------

test("docs/42 派发附注：同范围已有待命/归档且留有存档的实例 → 提示优先唤醒（只提醒不拦截）；范围不重叠只报并发；近期限流随附", async () => {
  const llm = new ScriptProvider([tc("c1", "zz_echo", {}), done("报告"), tc("c2", "zz_echo", {}), done("报告二")]);
  const h = makeHarness(llm);
  try {
    const svc = subagentServiceFor(h.sh, h.rt);
    const first = svc.dispatch({ task: "任务一", description: "d", name: "r1", reusable: true, scope: ["results/R1"] });
    assert.ok(first.ok && !first.note?.includes("写入范围重叠"), "首个派发没有可重叠的实例");
    assert.ok(first.ok && first.note!.includes("当前运行中子代理 1/"), "并发占用含本实例");
    await waitForInbox(h.rt);
    // 同范围再派（嵌套子目录也算重叠）→ 受理照常，附注提示优先 agent_followup 唤醒 r1#1
    const overlap = svc.dispatch({ task: "接手 R1", description: "d", scope: ["results/R1/figs"] });
    if (!overlap.ok) assert.fail(`只提醒不拦截：派发应照常受理，却被告警拒绝：${overlap.error}`);
    assert.ok(overlap.note!.includes("写入范围重叠") && overlap.note!.includes("r1#1（空闲待命，有过程存档）") && overlap.note!.includes("agent_followup"), overlap.note!);
    await waitForInbox(h.rt, 2);
    // 不重叠的范围：不带重叠提示
    const disjoint = svc.dispatch({ task: "独立任务", description: "d", scope: ["results/R9"] });
    if (!disjoint.ok) assert.fail(disjoint.error);
    assert.ok(!disjoint.note!.includes("写入范围重叠"), disjoint.note!);
    await waitForInbox(h.rt, 3);
    // 归档实例同样提示；近期限流随附
    h.rt.subagents[0]!.state = "archived";
    h.rt.subagentLimits = [{ at: Date.now(), kind: "rate", message: "已达到速率限制" }];
    const after = svc.dispatch({ task: "再接手", description: "d", scope: ["results/R1"] });
    if (!after.ok) assert.fail(after.error);
    assert.ok(after.note!.includes("r1#1（已归档，有过程存档）") && after.note!.includes("本会话近期发生提供方限流 1 次") && after.note!.includes("速率限制"), after.note!);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("docs/42 scopesOverlap/dispatchNoteOf：目录级前缀比对；任一方未给 scope 不提示（旧记录/全工作区不制造噪音）；范围外改动不提示", () => {
  assert.equal(scopesOverlap(["results/R1"], ["results/R1/figs"]), true, "嵌套子目录重叠");
  assert.equal(scopesOverlap(["results/R1"], ["Results/r10"]), false, "R1 与 R10 是不同目录（非字符串前缀）");
  assert.equal(scopesOverlap(["a\\b"], ["A/B"]), true, "分隔符与大小写归一");
  assert.equal(scopesOverlap(undefined, ["results/R1"]), false, "新任务未给 scope（=整个工作区）不提示");
  assert.equal(scopesOverlap(["results/R1"], undefined), false, "旧记录无 scope 不提示");
  const rt = { subagents: [], workers: new Set(), subagentLimits: [] } as unknown as SessionRuntime;
  assert.equal(dispatchNoteOf(rt, ["x"]), "（当前运行中子代理 0/3）");
  (rt as unknown as { subagents: unknown[] }).subagents.push({ subId: 1, name: "old", state: "idle", transcript: "t", at: "" }); // 旧记录：无 scope
  assert.ok(!dispatchNoteOf(rt, ["x"])!.includes("写入范围重叠"), "范围不明不提示");
  (rt as unknown as { subagents: Array<Record<string, unknown>> }).subagents[0]!.scope = ["x"];
  assert.ok(dispatchNoteOf(rt, ["x/sub"])!.includes("写入范围重叠"));
});

// ---------- 提供方限流（B4） ----------

test("docs/42 提供方限流：速率限制/用量上限的失败报告附对应建议并记入会话；subagent_status 表尾可查", async () => {
  const rate: LLMProvider = { name: "x", chat: async () => { throw new Error("已达到速率限制，请您控制请求频率"); } };
  const h1 = makeHarness(rate);
  try {
    assert.ok(subagentServiceFor(h1.sh, h1.rt).dispatch({ task: "t", description: "d", name: "fast" }).ok);
    const [report] = await waitForInbox(h1.rt);
    assert.ok(report.includes("提供方速率限制") && report.includes("调小 subagentMaxConcurrent") && report.includes("agent_followup 复活同一子代理续做"), report);
    assert.equal(h1.rt.subagentLimits?.[0]!.kind, "rate");
    assert.ok(!report.includes("用量上限"), "速率限制不带用量上限建议");
    assert.ok(subagentStatusText(h1.rt)!.includes("近期提供方限流 1 次") && subagentStatusText(h1.rt)!.includes("速率限制"), "状态表（不传 all）也列出限流");
  } finally {
    rmSync(h1.root, { recursive: true, force: true });
  }
  const cap: LLMProvider = { name: "x", chat: async () => { throw new Error("已达到 5 小时的使用上限，限额将在 18:41:01 重置"); } };
  const h2 = makeHarness(cap);
  try {
    assert.ok(subagentServiceFor(h2.sh, h2.rt).dispatch({ task: "t", description: "d", name: "capped" }).ok);
    const [report] = await waitForInbox(h2.rt);
    assert.ok(report.includes("提供方用量上限") && report.includes("立即重试无益") && report.includes("18:41:01 重置"), report);
    assert.equal(h2.rt.subagentLimits?.[0]!.kind, "cap");
    assert.ok(subagentStatusText(h2.rt)!.includes("用量上限"));
  } finally {
    rmSync(h2.root, { recursive: true, force: true });
  }
  // 普通失败（网络/超时）：不臆测为限流
  const plain: LLMProvider = { name: "x", chat: async () => { throw new Error("网络炸了"); } };
  const h3 = makeHarness(plain);
  try {
    assert.ok(subagentServiceFor(h3.sh, h3.rt).dispatch({ task: "t", description: "d" }).ok);
    const [report] = await waitForInbox(h3.rt);
    assert.ok(!report.includes("提供方速率限制") && !report.includes("提供方用量上限"));
    assert.equal(h3.rt.subagentLimits, undefined);
  } finally {
    rmSync(h3.root, { recursive: true, force: true });
  }
});

// ---------- 只读子代理（A6） ----------

test("docs/42 只读子代理：不装 write_file/edit_file 与 MCP、run_pwsh 钉死只读沙箱、系统提示说明；随记录/存档保存并在复活时还原", async () => {
  const modes: string[] = [];
  setSandboxRunner({
    name: "fake",
    available: () => true,
    run: async (_c, policy) => {
      modes.push(policy.mode);
      return { code: 0, timedOut: false, interrupted: false, overLimit: false, stdout: "ro-ok", stderr: "" };
    },
  });
  const llm = new ScriptProvider([
    tc("p1", "run_pwsh", { command: "Write-Output hi", description: "只读执行" }),
    tc("x1", "zz_echo", {}),
    tc("w1", "write_file", { path: "results/x.md", content: "y" }), // 幻觉调用：工具不存在
    done("报告：只读调查完成"),
    tc("p2", "run_pwsh", { command: "Write-Output again", description: "复活后再查" }),
    done("报告：复活后仍是只读"),
  ]);
  const h = makeHarness(llm);
  try {
    const svc = subagentServiceFor(h.sh, h.rt);
    assert.ok(svc.dispatch({ task: "只调查", description: "d", name: "ro", reusable: true, readOnly: true }).ok);
    await waitForInbox(h.rt);
    const first = llm.calls[0]!;
    const tools = (first.tools ?? []).map((t) => t.name);
    assert.ok(!tools.includes("write_file") && !tools.includes("edit_file"), `只读实例没有写入工具：${tools.join(",")}`);
    assert.ok(tools.includes("run_pwsh") && tools.includes("read_file") && tools.includes("zz_echo"), "读取与命令工具照常");
    assert.ok(!tools.some((n) => n.startsWith("mcp__")), "不装 MCP 工具（MCP 不走沙箱，无法保证只读）");
    assert.ok(String(first.messages[0]!.content).includes(READONLY_ROLE_SECTION), "系统提示说明只读约束");
    assert.deepEqual(modes, ["read-only"], "会话是 workspace-write，只读实例的 run_pwsh 仍按只读沙箱执行");
    const results = toolResultsOf(llm.calls[3]!);
    assert.ok(results[1]!.includes("echo:readonly=true"), `工具上下文带 readOnly：${results[1]}`);
    assert.ok(results[2]!.includes("未知工具") && results[2]!.includes("write_file"), `写入调用被结构性拒绝：${results[2]}`);
    assert.equal(h.rt.subagents[0]!.readOnly, true, "记录带只读标记");
    assert.ok(subagentStatusText(h.rt).includes("只读"), "状态表标注只读");
    const archiveFile = join(h.sh.sessions.spillDir(h.rt.id)!, h.rt.subagents[0]!.transcript!);
    const meta = (JSON.parse(readFileSync(archiveFile, "utf8")) as { subagent?: { readOnly?: boolean; progress?: string } }).subagent;
    assert.equal(meta?.readOnly, true, "存档 meta 带只读标记");
    assert.ok(meta?.progress?.includes("最后成功的命令：Write-Output hi"), `存档 meta 带进展速览：${meta?.progress}`);
    // 复活：只读约束随存档还原（装配前回填——工具裁剪生效）
    modes.length = 0;
    h.rt.activeSubagents.clear();
    assert.ok(subagentServiceFor(h.sh, h.rt).followup({ name: "ro" }, { task: "再查一下" }).ok);
    await waitForInbox(h.rt, 2);
    const revivedTools = (llm.calls[4]!.tools ?? []).map((t) => t.name);
    assert.ok(!revivedTools.includes("write_file") && !revivedTools.includes("edit_file"), "复活后仍无写入工具");
    assert.deepEqual(modes, ["read-only"], "复活后 run_pwsh 仍钉死只读沙箱");
  } finally {
    setSandboxRunner(noBackend);
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("docs/42 可写子代理不受只读裁剪影响（回归）：写入工具照常、工具上下文无 readOnly 字段", async () => {
  const llm = new ScriptProvider([tc("c1", "zz_echo", {}), tc("w1", "write_file", { path: "results/w.md", content: "ok\n" }), done("报告")]);
  const h = makeHarness(llm);
  try {
    assert.ok(subagentServiceFor(h.sh, h.rt).dispatch({ task: "t", description: "d" }).ok);
    await waitForInbox(h.rt);
    const tools = (llm.calls[0]!.tools ?? []).map((t) => t.name);
    assert.ok(tools.includes("write_file") && tools.includes("edit_file"));
    const results = toolResultsOf(llm.calls[2]!);
    assert.equal(results[0], "echo:readonly=false");
    assert.ok(results[1]!.startsWith("已写入"), results[1]);
    assert.equal(h.rt.subagents[0]!.readOnly, undefined, "可写实例记录不写只读标记");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

// ---------- 重复打断的状态通知去重（B6） ----------

test("docs/42 打断去重：收尾窗口内重复 stop（界面连点）只送达一条状态通知", async () => {
  // 让工具挂在一道审批上，制造「已打断、尚未结算」的窗口
  const slow: SystemToolDef = {
    name: "zz_slow",
    summary: "慢工具",
    create: () => ({
      name: "zz_slow",
      description: "测试",
      parameters: { type: "object", properties: {}, required: [] },
      async execute(_args, ctx) {
        return `decision:${await ctx.requestApproval({ toolName: "zz_slow", command: "slow", reasons: [] })}`;
      },
    }),
  };
  const llm = new ScriptProvider([tc("s1", "zz_slow", {}), done("不应到达")]);
  const h = makeHarness(llm);
  h.sh.ctx.tools.register(slow);
  try {
    assert.ok(subagentServiceFor(h.sh, h.rt).dispatch({ task: "t", description: "d", name: "slow", reusable: true }).ok);
    for (let i = 0; i < 300 && h.rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(h.rt.pendingApproval, "审批卡已挂上");
    const active = h.rt.activeSubagents.get(1)!;
    active.stop("ui");
    active.stop("ui");
    active.stop("ui"); // 界面连点三次
    // 打断的 abort 会让挂着的审批卡以 cancelled 收场（槽位已清）；迟到的决议（若有槽）不再改变结局
    h.rt.pendingApproval?.("allowed-once");
    await waitForInbox(h.rt, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.rt.inbox!.length, 1, `只应有一条状态通知：\n${h.rt.inbox!.join("\n---\n")}`);
    assert.ok(h.rt.inbox![0]!.includes("已被用户打断"));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

// ---------- subagent-brief 纯函数 ----------

test("docs/42 filesChangedSince：按 scope 过滤、跳过依赖目录、按修改时间倒序；扫描上限标记 capped", () => {
  const root = mkdtempSync(join(tmpdir(), "zqq-scan-"));
  try {
    const base = Date.now() - 100_000;
    const mk = (rel: string) => {
      const abs = join(root, rel);
      mkdirSync(abs.slice(0, abs.lastIndexOf(sep)), { recursive: true });
      writeFileSync(abs, rel);
      const d = new Date(base);
      utimesSync(abs, d, d); // 先统一压到「很久以前」
    };
    mk("results/R1/a.md");
    mk("results/R1/sub/b.md");
    mk("results/R2/c.md");
    mk("node_modules/pkg/d.js");
    mk(".git/HEAD");
    const since = Date.now() - 50_000;
    // 只把 results/R1/sub/b.md 与 node_modules 里的文件改到「之后」
    touchFuture(join(root, "results/R1/sub/b.md"));
    touchFuture(join(root, "node_modules/pkg/d.js"));
    const r1 = filesChangedSince(root, ["results/R1"], since);
    assert.deepEqual(r1.files.map((f) => f.rel), ["results/R1/sub/b.md"], "scope 外与依赖目录不入列；相对路径用正斜杠");
    assert.equal(r1.capped, false);
    assert.deepEqual(filesChangedSince(root, ["results"], since).files.map((f) => f.rel), ["results/R1/sub/b.md"]);
    assert.deepEqual(filesChangedSince(root, undefined, since).files.map((f) => f.rel), ["results/R1/sub/b.md"], "缺省 scope = 整个工作区（node_modules 仍跳过）");
    assert.deepEqual(filesChangedSince(root, ["not-exist"], since).files, [], "目录不存在静默跳过");
    assert.equal(filesChangedSince(root, ["results"], base - 1).capped, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docs/42 rehydrateLedger / wakeBriefOf：未变动回填、变动不回填；无基准/无工作区/无进展不造简报", () => {
  const root = mkdtempSync(join(tmpdir(), "zqq-ledger-"));
  try {
    // 两个文件都是「上次活动之前」写的：mtime 显式压到过去（文件 mtime 是操作系统实时钟，
    // 同一事件循环 tick 内的 Date.now() 可能仍是 tick 开头的缓存值——靠先后顺序不可靠）
    const past = new Date(Date.now() - 60_000);
    for (const f of ["same.md", "moved.md"]) {
      writeFileSync(join(root, f), `${f}\n`);
      utimesSync(join(root, f), past, past);
    }
    const since = Date.now(); // 基准 = 上次活动时刻
    writeFileSync(join(root, "moved.md"), "moved again\n"); // 此后被别人改了
    touchFuture(join(root, "moved.md"));
    const ledger = createFileLedger();
    const r = rehydrateLedger(ledger, ["same.md", "moved.md", "gone.md"], root, since);
    assert.deepEqual(r.seeded, ["same.md"]);
    assert.deepEqual(r.changed, ["moved.md"]);
    assert.ok(ledger.readStamp((process.platform === "win32" ? join(root, "same.md").toLowerCase() : join(root, "same.md"))), "未变动文件按当前指纹回填");
    const history = [
      { role: "user" as const, content: "任务书" },
      { role: "assistant" as const, content: null, toolCalls: [{ id: "1", name: "read_image", arguments: '{"path":"fig_1.png"}' }] },
      { role: "tool" as const, toolCallId: "1", content: "[已读取图片 fig_1.png] …" },
    ];
    assert.equal(wakeBriefOf(root, ledger, history, since, undefined, { rehydrate: true })!.includes("你此前查看过 1 张图：fig_1.png"), true, "已看图片清单入简报");
    assert.equal(wakeBriefOf(root, ledger, history, undefined, undefined, { rehydrate: true }), undefined, "无基准时刻不造简报（首派发）");
    assert.equal(wakeBriefOf("", ledger, history, since, undefined, { rehydrate: true }), undefined, "无工作区根不扫盘（空串会解析到 cwd）");
    assert.equal(wakeBriefOf(root, ledger, [{ role: "user", content: "任务书" }], since, undefined, { rehydrate: true }), undefined, "没有任何工具调用不造简报");
    assert.equal(progressFactsOf(history).images.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docs/42 filesChangedSince 深度上限：超过 12 层的嵌套目录不再下探（有界扫描，大工作区不会扫穿）", () => {
  const root = mkdtempSync(join(tmpdir(), "zqq-scan-depth-"));
  try {
    let dir = root;
    for (let i = 0; i < 16; i++) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir);
    }
    const deep = join(dir, "deep.md");
    writeFileSync(deep, "deep");
    touchFuture(deep);
    const shallow = join(root, "d0", "d1", "shallow.md");
    writeFileSync(shallow, "shallow");
    touchFuture(shallow);
    const out = filesChangedSince(root, undefined, Date.now() - 1_000);
    assert.deepEqual(out.files.map((f) => f.rel), ["d0/d1/shallow.md"], "浅层文件入列；16 层深的不下探");
    assert.equal(out.capped, false, "深度截断不算条目超限");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
