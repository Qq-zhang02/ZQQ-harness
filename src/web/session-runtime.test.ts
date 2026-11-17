/**
 * createRuntime 单元测试（docs/5 SA1）+ 审批串行队列（docs/5 SA3 §5.2 C3）：
 * 会话形态分流（D1；docs/32 三值受众）——normal 会话装配 worker+front 受众的全部系统工具
 * （不含 agent_task）；coordinator 会话仅装 agent_task 等家族（docs/15 起 agent_tasks 退役；docs/32 增 subagent_status）且
 * 注入 deps.subagent（经 ctx.subagent 接缝）；SessionData.kind 旧档缺省 normal、
 * 显式 coordinator 恢复（不变量 6 向后兼容）。
 * SA4：fromDisk.subagents 审计记录回填与累计配额续期（偏差 15）、currentState 下发、
 * toSessionData 空记录不写字段（旧档形状不变）。
 * worker 运行机制（subagentServiceFor/runWorker）的测试在 subagents.test.ts。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../core/context.ts";
import { loadConfig } from "../config.ts";
import { toolAgentTask } from "../modules/tools/agent-task/index.ts";
import type { ProviderFormatDef, SystemToolDef, McpTransportDef } from "../core/types.ts";
import type { SubagentService } from "../core/types.ts";
import { SessionStore } from "./sessions.ts";
import { AttachmentStore } from "./attachments.ts";
import type { ProviderConfig, ProviderFile } from "../providers/store.ts";
import { createRuntime, currentState, requestApprovalFor, type SessionShell } from "./session-runtime.ts";
import { startTurn, toSessionData } from "./session-lifecycle.ts";
import type { ApprovalRequest } from "../approval/types.ts";
import type { SessionRuntime } from "../core/host.ts";

/** 桩提供方格式：createProvider 走注册表工厂，chat 永远返回一句固定回答。 */
const fakeFormat: ProviderFormatDef = {
  format: "fake",
  label: "桩格式",
  create: (cfg) => ({
    name: "fake",
    model: cfg.model,
    chat: async () => ({ content: "ok", toolCalls: [], usage: null }),
  }),
  defaultEffort: () => "high",
};

const fakeProvider: ProviderConfig = {
  id: "p1",
  name: "桩提供方",
  format: "fake",
  baseUrl: "http://localhost",
  apiKey: "",
  model: "fake-model",
  effort: "high",
  contextLength: 100_000,
  maxTokens: null,
};

/** 桩的普通（worker 受众）系统工具：普通会话应装配、协调者会话不应装配。 */
const fakeWorkerToolDef: SystemToolDef = {
  name: "zz_fake_tool",
  summary: "测试用普通工具",
  create: () => ({
    name: "zz_fake_tool",
    description: "测试用",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
  }),
};

/** 最小可用壳：真 SessionStore（tmpdir）+ 注册了 agent-task 与桩工具/格式的 ctx。
 *  overrides 可换桩格式/提供方（W2-L1 排空测试用记录型桩）。 */
function makeShell(
  userDir: string,
  subagent?: SubagentService,
  overrides?: { format?: ProviderFormatDef; provider?: ProviderConfig },
): SessionShell {
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
  ctx.providerFormats.register(overrides?.format ?? fakeFormat);
  ctx.tools.register(fakeWorkerToolDef);
  toolAgentTask.setup(ctx); // 真实 agent-task 模块（audience=coordinator）
  if (subagent) ctx.subagent = () => subagent;
  return {
    ctx,
    sessions: new SessionStore(userDir),
    attachments: new AttachmentStore(userDir), // docs/33
    providerFile: {
      path: join(userDir, "providers.json"),
      data: { active: "p1", providers: [overrides?.provider ?? fakeProvider] },
    } as ProviderFile,
    runtimes: new Map(),
    viewId: "",
    viewSeq: 0,
    recentWorkspaces: [],
    workspacesFile: join(userDir, "workspaces.json"),
    userDir,
    globalMcpFile: join(userDir, "mcp.json"),
    sandboxTmpRoot: join(userDir, "tmp"),
    broadcast: () => {},
  };
}

test("createRuntime kind 分流：normal 装普通工具、不含 agent_task；系统提示照旧", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-normal-"));
  try {
    const sh = makeShell(dir);
    const rt = await createRuntime(sh, { workspaceRoot: dir });
    const names = rt.registry.list().map((t) => t.name);
    assert.ok(names.includes("zz_fake_tool"), "普通会话应装配 worker 受众工具");
    assert.ok(!names.includes("agent_task"), "普通会话不应装配 agent_task（字节等价现状）");
    assert.equal(rt.kind, "normal");
    const sys = String(rt.agent.messages[0]?.content);
    assert.ok(sys.includes("zz_fake_tool"));
    assert.ok(!sys.includes("agent_task"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRuntime kind 分流：coordinator 仅装 agent_task 家族（docs/32 起含 subagent_status）且注入 deps.subagent；无 MCP/普通工具", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-coord-"));
  try {
    let seamUsed = 0;
    const stub: SubagentService = {
      dispatch: () => {
        seamUsed++;
        return { ok: true, subId: 1, name: "sub-1" };
      },
      followup: () => ({ ok: false, error: "stub" }),
    };
    const sh = makeShell(dir, stub);
    // docs/20：两级 AGENTS.md 落地（测试里 userDir 与工作区同目录——同一文件喂两级，
    // 标题不同可分别计数）
    writeFileSync(join(dir, "AGENTS.md"), "测试规则：AGENTS 全文。", "utf8");
    const rt = await createRuntime(sh, { workspaceRoot: dir, kind: "coordinator" });
    const names = rt.registry.list().map((t) => t.name);
    assert.deepEqual(
      names.sort(),
      ["agent_followup", "agent_task", "archive_subagent", "stop_subagent", "subagent_status"],
      "协调者会话五件（docs/18 起 pause/resume 由 stop_subagent 一件取代；docs/32 增 subagent_status 状态查询）",
    );
    assert.equal(rt.kind, "coordinator");
    const sys = String(rt.agent.messages[0]?.content);
    assert.ok(sys.includes("agent_task"));
    assert.ok(!sys.includes("agent_tasks"), "系统提示不含已退役的 agent_tasks（docs/15）");
    assert.ok(sys.includes("在同一轮里发多个 agent_task 即并行派出"), "系统提示含同轮多调用并行说明（docs/16 派发纪律）");
    assert.ok(sys.includes("# 子代理（worker）系统提示词说明"), "docs/20：含子代理系统提示词说明段");
    assert.ok(sys.includes("zz_fake_tool —— 测试用普通工具"), "docs/20：子代理段重放 worker 工具行（引用自子代理侧）");
    assert.ok(sys.includes("你是被协调者派出的子代理"), "docs/20：子代理段含 worker 职责段（WORKER_ROLE_SECTION）");
    assert.ok(sys.includes("可用工具：agent_followup"), "协调者自身可用工具行仍以派发/控制家族开头（toolDocsOf 按名排序开头）");
    assert.equal(sys.split("# 全局指令（~/.ZQQ-harness/AGENTS.md）").length - 1, 1, "docs/20：全局 AGENTS.md 只在子代理段出现一次（协调者不重复注入）");
    assert.equal(sys.split("# 工作区指令（AGENTS.md）").length - 1, 1, "docs/20：工作区 AGENTS.md 同样只出现一次");
    assert.ok(!sys.includes("# MCP 服务器使用说明"), "MCP 未连接时不注入说明段（docs/20 懒加载，首连热更）");
    // agent_task 可执行且走注入的服务
    const out = await rt.registry.execute("agent_task", JSON.stringify({ description: "d", task: "t" }), {
      workspace: rt.workspace!,
      requestApproval: async () => "allowed-once",
    });
    assert.equal(seamUsed, 1);
    assert.ok(out.includes("[子代理"));
    assert.ok(rt.registry.list().every((t) => !t.name.startsWith("mcp__")), "协调者不注册 MCP 工具");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** docs/20 修订测试桩 MCP 传输：连接即握手成功，instructions 固定文本（无工具也行）。 */
const preloadStubTransport: McpTransportDef = {
  type: "stub",
  async connect() {
    return {
      instructions: "预热桩说明：MCP 预热验证。",
      serverInfo: { name: "stub-preload", version: "1" },
      listTools: () => [],
      callTool: async () => "ok",
      get alive() {
        return true;
      },
      stop: () => {},
    };
  },
};

test("docs/20 修订：协调者创建即预热 worker MCP——无需先派 worker，说明书热更进提示词", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-coord-mcp-"));
  try {
    const sh = makeShell(dir);
    sh.ctx.mcpTransports.register(preloadStubTransport);
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { demo: { type: "stub", command: "stub" } } }), "utf8");
    const rt = await createRuntime(sh, { workspaceRoot: dir, kind: "coordinator" });
    const before = String(rt.agent.messages[0]?.content);
    assert.ok(!before.includes("# MCP 服务器使用说明"), "预热完成前的创建快照无 MCP 段");
    await rt.workerMcp; // 预热 promise 已被 createRuntime 缓存（fire-and-forget）
    const after = String(rt.agent.messages[0]?.content);
    assert.ok(after.includes("# 子代理（worker）系统提示词说明"), "子代理说明段仍在");
    assert.ok(after.includes("# MCP 服务器使用说明"), "预热完成后热更出 MCP 说明段");
    assert.ok(after.includes("预热桩说明：MCP 预热验证。"), "说明书内容来自握手 instructions");
    assert.ok(rt.registry.list().every((t) => !t.name.startsWith("mcp__")), "红线不破：预热不给协调者 registry 装 mcp__ 工具");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs/28 P1-3：普通会话 MCP 后台装配——createRuntime 即返，mcpReady 后工具/说明书热更", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-mcp-async-"));
  try {
    // 本地桩：带一个工具（preloadStubTransport 的 listTools 为空，验不了注册侧）
    const stubWithTool: McpTransportDef = {
      type: "stub-async",
      async connect() {
        return {
          instructions: "异步装配桩说明。",
          serverInfo: { name: "stub-async", version: "1" },
          listTools: () => [
            { name: "demo_echo", description: "测试工具", inputSchema: { type: "object", properties: {}, required: [] } },
          ],
          callTool: async () => "ok",
          get alive() {
            return true;
          },
          stop: () => {},
        };
      },
    };
    const sh = makeShell(dir);
    sh.ctx.mcpTransports.register(stubWithTool);
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { demo: { type: "stub-async", command: "stub" } } }), "utf8");
    const rt = await createRuntime(sh, { workspaceRoot: dir });
    // 创建即返：MCP 连接尚未完成（工具未注册、说明书未注入）——这正是 P1-3 要的
    // 「会话创建不再阻塞在 stdio 握手上」
    assert.ok(rt.mcpReady, "mcpReady promise 挂上");
    assert.ok(!rt.registry.list().some((t) => t.name.startsWith("mcp__")), "创建即返时 MCP 工具尚未注册（后台装配中）");
    await rt.mcpReady;
    // 装配完成：工具进 registry、说明书热更进系统提示（startTurn 开跑前 await 即此语义）
    assert.ok(rt.registry.list().some((t) => t.name === "mcp__demo__demo_echo"), "mcpReady 后 mcp__ 工具已注册");
    assert.ok(String(rt.agent.messages[0]?.content).includes("异步装配桩说明。"), "MCP 说明书热更进系统提示");
    await rt.mcp.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRuntime 恢复：SessionData.kind=coordinator 旧档恢复为协调者；缺省 kind 恢复为 normal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-restore-"));
  try {
    const sh = makeShell(dir);
    const coord = await createRuntime(sh, {
      id: "0e0d8f8a-1111-4222-8333-444455556666",
      workspaceRoot: dir,
      fromDisk: {
        id: "0e0d8f8a-1111-4222-8333-444455556666",
        title: "旧档",
        updatedAt: new Date().toISOString(),
        workspace: dir,
        messageCount: 0,
        kind: "coordinator",
        messages: [],
        totals: { prompt: 0, completion: 0 },
      },
    });
    assert.equal(coord.kind, "coordinator");
    assert.deepEqual(
      coord.registry.list().map((t) => t.name).sort(),
      ["agent_followup", "agent_task", "archive_subagent", "stop_subagent", "subagent_status"],
    );
    const plain = await createRuntime(sh, {
      id: "0e0d8f8a-1111-4222-8333-444455557777",
      workspaceRoot: dir,
      fromDisk: {
        id: "0e0d8f8a-1111-4222-8333-444455557777",
        title: "普通旧档（无 kind 字段）",
        updatedAt: new Date().toISOString(),
        workspace: dir,
        messageCount: 0,
        messages: [],
        totals: { prompt: 0, completion: 0 },
      },
    });
    assert.equal(plain.kind, "normal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- SA4：subagents 审计记录的存档往返（docs/5 待办 ②；偏差 15 配额续期） ----------

test("SA4 存档往返：fromDisk.subagents 回填 rt.subagents 并续期 subagentTotal；缺省为空/0；toSessionData 非空才写字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-sa4-"));
  try {
    const sh = makeShell(dir);
    const restored = await createRuntime(sh, {
      id: "0e0d8f8a-2111-4222-8333-444455558888",
      workspaceRoot: dir,
      fromDisk: {
        id: "0e0d8f8a-2111-4222-8333-444455558888",
        title: "带子代理记录的旧档",
        updatedAt: new Date().toISOString(),
        workspace: dir,
        messageCount: 2,
        kind: "coordinator",
        messages: [],
        totals: { prompt: 0, completion: 0 },
        subagents: [
          { subId: 1, name: "a", description: "da", ok: true, rounds: 3, usage: { prompt: 100, completion: 20 }, at: "2026-11-12T00:00:00.000Z" },
          { subId: 2, name: "b", ok: false, error: "子代理超时（60000ms）", at: "2026-11-12T00:01:00.000Z" },
          { subId: 5, name: "c", ok: true, transcript: join("sub-5-c", "transcript.json"), at: "2026-11-12T00:02:00.000Z" },
        ],
      },
    });
    assert.equal(restored.subagents.length, 3);
    assert.equal(restored.subagentTotal, 3, "累计配额按记录条数续期（重启不重置，偏差 15）");
    assert.equal(restored.subagents[1]!.error, "子代理超时（60000ms）");
    assert.equal(restored.subagents[2]!.transcript, join("sub-5-c", "transcript.json"), "P3：transcript 字段往返无损（旧档无此字段=无存档，向后兼容）");
    assert.deepEqual(currentState(sh, restored).subagents, restored.subagents, "currentState 下发审计记录（/status 与前端数据源）");

    // toSessionData：非空写、空不写（旧档 JSON 形状不变）
    const withRecs = toSessionData(restored, "t", []);
    assert.equal(withRecs.subagents?.length, 3);
    const fresh = await createRuntime(sh, { workspaceRoot: dir });
    assert.equal(fresh.subagents.length, 0);
    assert.equal(fresh.subagentTotal, 0);
    assert.ok(!("subagents" in toSessionData(fresh, "t", [])), "空记录不写字段");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- SA3：审批串行队列（docs/5 §5.2 C3，requestApprovalFor 直测） ----------

/** 手动决议的桩会话：ask 挂起 pendingApproval，decide 逐张决议并记录弹卡顺序。 */
function approvalHarness(opts?: { signal?: AbortSignal }) {
  const cards: ApprovalRequest[] = [];
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-ap-"));
  const sh = makeShell(dir);
  const rt = {
    id: "0e0d8f8a-aaaa-cccc-cccc-dddddddddddd",
    settings: { alwaysConfirm: false, effort: "high", askMode: "ask", sandboxMode: "workspace-write" },
    auditEvents: [],
    pendingApproval: null,
    approvalChain: undefined,
  } as unknown as SessionRuntime;
  const ask = requestApprovalFor(sh, rt, opts?.signal ? { signal: opts.signal } : undefined);
  const settle = (d: "allowed-once" | "rejected" | "cancelled") => rt.pendingApproval!(d);
  return { sh, rt, ask, settle, cards, dir };
}

test("审批串行队列：并行请求按序决议——第一张决出前第二张不弹（无单槽覆盖）", async () => {
  const h = approvalHarness();
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] });
  const p2 = h.ask({ toolName: "t2", command: "cmd-2", reasons: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.rt.auditEvents.filter((e) => e.type === "approval/asked").length, 1, "只有第一张弹卡");
  h.settle("allowed-once");
  assert.equal(await p1, "allowed-once");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.rt.auditEvents.filter((e) => e.type === "approval/asked").length, 2, "前卡决议后第二张弹上");
  h.settle("rejected");
  assert.equal(await p2, "rejected");
  rmSync(h.dir, { recursive: true, force: true });
});

test("审批串行队列：前卡 cancelled（中断）链条不断，后卡继续弹出可决议", async () => {
  const h = approvalHarness();
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] });
  const p2 = h.ask({ toolName: "t2", command: "cmd-2", reasons: [] });
  await new Promise((r) => setTimeout(r, 10));
  h.settle("cancelled");
  assert.equal(await p1, "cancelled");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.rt.pendingApproval, "后卡已弹上（链条未断）");
  h.settle("allowed-once");
  assert.equal(await p2, "allowed-once");
  rmSync(h.dir, { recursive: true, force: true });
});

test("审批串行队列：signal 已中止时排队请求立即 cancelled，不弹卡（队列快速排空）", async () => {
  const ctl = new AbortController();
  const h = approvalHarness({ signal: ctl.signal });
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] }); // 已在等
  const p2 = h.ask({ toolName: "t2", command: "cmd-2", reasons: [] }); // 排队
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  assert.equal(await p1, "cancelled"); // P1 起：正在等的卡随 abort 自行决议（不再依赖手动收尾）
  assert.equal(await p2, "cancelled"); // 排队项发起前发现已中止，不弹卡直接 cancelled
  assert.equal(h.rt.auditEvents.filter((e) => e.type === "approval/asked").length, 1, "第二张从未弹卡");
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------- docs/30：auto 自动放行（askOnce 短路不弹卡）与审批策略 live 读 ----------

test("auto 自动放行：普通卡不弹直接 allowed-once，审计记 asked+decided(auto:true)；策略切换即生效（live 读）", async () => {
  const h = approvalHarness();
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] }); // ask 模式：正常弹卡
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.rt.pendingApproval, "ask 模式先正常弹卡");
  h.settle("rejected");
  assert.equal(await p1, "rejected");
  h.rt.settings.askMode = "auto"; // 运行中切换（docs/30）：下一次 ask 即生效
  const r2 = await h.ask({ toolName: "t2", command: "cmd-2", reasons: [] });
  assert.equal(r2, "allowed-once");
  assert.equal(h.rt.pendingApproval, null, "auto 短路不占单槽（无卡在等）");
  const decided = h.rt.auditEvents.filter((e) => e.type === "approval/decided");
  const autoEvent = decided[decided.length - 1]!;
  assert.equal(autoEvent.decision, "allowed-once");
  assert.equal(autoEvent.auto, true, "审计带 auto 标注");
  assert.equal(h.rt.auditEvents.filter((e) => e.type === "approval/asked").length, 2, "审计形状一致（auto 也记 asked+decided 对）");
  rmSync(h.dir, { recursive: true, force: true });
});

test("auto + justification 提权卡不短路：照常弹卡由人工决议（模型自我升权保留人工关口）", async () => {
  const h = approvalHarness();
  h.rt.settings.askMode = "auto";
  const p = h.ask({ toolName: "run_pwsh", command: "cmd", reasons: ["上一条命令刚被沙箱拒绝"], justification: "需要写工作区外配置" });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.rt.pendingApproval, "提权卡仍弹出");
  h.settle("allowed-once");
  assert.equal(await p, "allowed-once");
  const last = h.rt.auditEvents[h.rt.auditEvents.length - 1]!;
  assert.ok(!("auto" in last), "人工决议不带 auto 标注");
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------- P1：审批卡挂起死锁修复（docs/6 §1，doAsk 的 abort 监听） ----------

test("P1 abort 解锁：正在等的卡随 signal abort 立即 resolved cancelled（无需手动决议），排队后卡快速排空", async () => {
  const ctl = new AbortController();
  const h = approvalHarness({ signal: ctl.signal });
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] }); // 已在等
  const p2 = h.ask({ toolName: "t2", command: "cmd-2", reasons: [] }); // 排队
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.rt.pendingApproval, "第一张卡在等（死锁场景成立）");
  ctl.abort(); // 按「停止」：不点卡片——正在等的卡必须自行解锁，这正是死锁修复点
  assert.equal(await p1, "cancelled");
  assert.equal(await p2, "cancelled"); // 排队项发起前发现已中止，不弹卡直接 cancelled
  const decided = h.rt.auditEvents.filter((e) => e.type === "approval/decided");
  assert.deepEqual(decided.map((e) => e.decision), ["cancelled"], "审计记 decided/cancelled（决议语义零新增）");
  assert.equal(h.rt.pendingApproval, null, "单槽已清空（轮结束 finally 的迟到收尾为空操作）");
  rmSync(h.dir, { recursive: true, force: true });
});

test("P1 abort 迟到为空操作：卡正常决议后 signal 再触发，不产生第二份 decided 审计", async () => {
  const ctl = new AbortController();
  const h = approvalHarness({ signal: ctl.signal });
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] });
  await new Promise((r) => setTimeout(r, 10));
  h.settle("allowed-once"); // 用户先点了「允许」
  assert.equal(await p1, "allowed-once");
  ctl.abort(); // 迟到的 abort：不得重复决议/重复记审计
  await new Promise((r) => setTimeout(r, 10));
  const decided = h.rt.auditEvents.filter((e) => e.type === "approval/decided");
  assert.deepEqual(decided.map((e) => e.decision), ["allowed-once"]);
  rmSync(h.dir, { recursive: true, force: true });
});

test("P1 信号隔离：前卡已决议后其信号触发（如该 worker 超时）不误伤后卡——后卡可正常决议", async () => {
  const sigA = new AbortController();
  const sigB = new AbortController();
  const h = approvalHarness({ signal: sigA.signal });
  const askB = requestApprovalFor(h.sh, h.rt, { signal: sigB.signal }); // 另一个 worker 的审批闭包
  const p1 = h.ask({ toolName: "t1", command: "cmd-1", reasons: [] });
  await new Promise((r) => setTimeout(r, 10));
  h.settle("rejected"); // 前卡正常决议（监听器仍挂在 sigA 上）
  assert.equal(await p1, "rejected");
  const p2 = askB({ toolName: "t2", command: "cmd-2", reasons: [] });
  for (let i = 0; i < 100 && h.rt.pendingApproval === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.rt.pendingApproval, "后卡已弹上单槽");
  sigA.abort(); // 前卡所属 worker 的迟到超时触发：后卡属于另一个 worker，不能被连带取消
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.rt.pendingApproval, "后卡仍在等待（未被前卡信号误伤）");
  h.settle("allowed-once");
  assert.equal(await p2, "allowed-once");
  rmSync(h.dir, { recursive: true, force: true });
});

test("P1 前台路径：未传 opts.signal 时挂当前轮信号（rt.abortCtl）——按停止同样解锁普通会话的卡", async () => {
  const h = approvalHarness();
  const ctl = new AbortController();
  h.rt.abortCtl = ctl; // startTurn 每轮新建的 AbortController（ask 时刻动态读取）
  const ask = requestApprovalFor(h.sh, h.rt); // 前台 agent / 系统工具的装配形态（无 opts）
  const p1 = ask({ toolName: "t1", command: "cmd-1", reasons: [] });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.rt.pendingApproval, "卡已挂上");
  ctl.abort(); // /api/stop 只做 abortCtl.abort()——卡必须自行解锁
  assert.equal(await p1, "cancelled");
  assert.equal(h.rt.pendingApproval, null);
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------- W2-L1：协调者 busy 期消息排队（docs/7 §2.3；路由层入队在 web-sessions.test.ts） ----------

test("W2-L1 排队消费：startTurn 轮末自动按 FIFO 处理 inbox（各开一轮），全部处理完不再空转", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-l1-"));
  try {
    const seen: string[] = [];
    const recFormat: ProviderFormatDef = {
      format: "fake-rec",
      label: "记录桩",
      create: () => ({
        name: "rec",
        model: "rec-model",
        // 无工具单轮即终：每轮 run 的唯一一次请求，末条消息即该轮 user 文本
        chat: async (p) => {
          seen.push(String(p.messages[p.messages.length - 1]?.content ?? ""));
          return { content: "ok", toolCalls: [], usage: null };
        },
      }),
      defaultEffort: () => "high",
    };
    const sh = makeShell(dir, undefined, { format: recFormat, provider: { ...fakeProvider, format: "fake-rec" } });
    const rt = await createRuntime(sh, { workspaceRoot: dir, kind: "coordinator" });
    rt.inbox = ["排队1", "排队2"];
    startTurn(sh, rt, "首轮");
    for (let i = 0; i < 400 && (rt.busy || (rt.inbox?.length ?? 0) > 0); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 30)); // 确认排空后不再开新轮（无空转）
    assert.deepEqual(seen, ["首轮", "排队1", "排队2"], "FIFO：首轮 → 队首逐条各开一轮");
    assert.equal(rt.busy, false);
    assert.equal(rt.inbox!.length, 0);
    assert.ok(rt.agent.messages.filter((m) => m.role === "user").length >= 3, "每条消息都进了会话历史");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/18：stop_subagent 工具接线（机制测试在 subagents.test.ts） ----------

test("工具接线：协调者可执行 stop_subagent（经 rt.activeSubagents）；普通会话不装配", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-rt-ctl-"));
  try {
    const sh = makeShell(dir);
    const rt = await createRuntime(sh, { workspaceRoot: dir, kind: "coordinator" });
    const out = await rt.registry.execute("stop_subagent", JSON.stringify({ name: "nobody" }), {
      workspace: rt.workspace!,
      requestApproval: async () => "allowed-once",
    });
    assert.ok(out.includes("没有匹配") && out.includes("当前活动：无"), out);
    const plain = await createRuntime(sh, { workspaceRoot: dir });
    assert.ok(!plain.registry.list().some((t) => t.name === "stop_subagent"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
