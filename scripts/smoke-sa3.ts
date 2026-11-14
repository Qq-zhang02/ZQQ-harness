/**
 * SA3 隔离冒烟（docs/5 §6 SA3，零 token：全程不发 LLM 网络请求）：并行派发 + 冲突治理——
 * A) 进程内真实装配（BUILTIN_MODULES + createRuntime(kind=coordinator) + 真实系统工具）：
 *   1) 协调者 registry 四件（docs/15 起 agent_tasks 退役，仅 agent_task 单发；docs/18 起 pause/resume→stop）；系统提示含派发纪律（docs/16）与 scope 用法；
 *   2) 三个 agent_task 调用并行派 3 个 worker（docs/16 非阻塞：即时回执 + 报告自动送达收件箱；真实 write_file 各写不同目录）；
 *   3) 同文件冲突（§5.3）：B 先读 → A 写入 → B 写被拒（旧快照失效）→ B 重读后写入成功（一成一拒 + 自愈）；
 *   4) 并发上限（C7）：3 个挂起 worker 占满槽位 → 第 4 个派发同步拒绝（未启动，不排队）；
 *   5) 并行审批（C3/§5.2）：两个 worker 并行写工作区外文件 → 串行队列一次一卡，
 *      [子代理 name] 标注 + subagent 字段，按序决议后两个文件就位；
 *   6) 中途 stop（C8）：两个 agent_task 派挂起 worker，abort 后失败报告送达（无悬空）；
 *   7) P1 死锁修复（docs/6 §1）：审批卡挂起时 abort——正在等的卡立即 cancelled、
 *      失败报告送达、卡片不残留；
 *   8) W2-S 暂停→恢复→完成（docs/7 §2.3；docs/16 派发即回执）：pause 后 worker 停在轮边界
 *      docs/18 改写：打断即终结（stop：请求中止、任务结算归档、并发槽释放；打断报告不送达，中止报告照常送达）；
 *   9) docs/16 协调者真实轮次：同轮两个 agent_task 即时回执（不阻塞轮次）→ 协调者当轮收尾 →
 *      两份完成报告自动送达收件箱（W2-L2 的 agent_task 等待窗口随非阻塞派发消失，interject
 *      机制由 agent.test.ts 单测锁定）。
 * 全程临时目录，不触碰真实 ~/.ZQQ-harness。用法：node scripts/smoke-sa3.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../src/core/context.ts";
import { loadModules } from "../src/core/module.ts";
import { BUILTIN_MODULES } from "../src/modules.ts";
import { loadConfig } from "../src/config.ts";
import { SessionStore } from "../src/web/sessions.ts";
import { createRuntime, type SessionShell } from "../src/web/session-runtime.ts";
import { subagentServiceFor } from "../src/web/subagents.ts";
import type { ProviderFormatDef } from "../src/core/types.ts";
import type { ChatParams, ChatResult, LLMProvider } from "../src/llm/provider.ts";
import type { ToolContext } from "../src/tools/registry.ts";

const results: { name: string; ok: boolean; note: string }[] = [];
function record(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? " — " + note : ""}`);
}
const fail = () => results.filter((r) => !r.ok).length;

// ---------- 可编排的桩提供方：按 worker 的 task 文本路由脚本；挂起任务支持 abort ----------

interface ScriptedLlm extends LLMProvider {
  /** 登记一段脚本（task 全文 → ChatResult 序列，按轮次推进） */
  addScript(task: string, script: ChatResult[]): void;
  /** 登记挂起任务（task 前缀匹配）：chat 挂到 signal abort（验证中止级联） */
  addHanging(prefix: string): void;
  /** 在 task 的第 round 轮挂起，直到 releaseGate() —— 并行时序的确定性编排 */
  addGate(task: string, round: number): Promise<void>;
  releaseGate(): void;
  /** 全部 chat 调用的参数（按到达序；场景 9 断言协调者第二次主轮请求形状用） */
  allCalls(): ChatParams[];
  /** W2-L2 interim 旁路请求（识别口径见 chat 内）：固定文本回应，不消耗脚本 cursor */
  interimRequests(): ChatParams[];
}

function makeScriptedLlm(): ScriptedLlm {
  const scripts = new Map<string, ChatResult[]>();
  const hanging = new Set<string>();
  const cursor = new Map<string, number>();
  const gates = new Map<string, number>(); // task -> 挂起轮次
  // 闸门等待者按次登记（addGate 每次新建）：releaseGate 放行当前全部——早先场景的
  // releaseGate 不会把后来场景的闸门也一并永久放行（W2-S 场景 8 曾踩中）
  const gateWaiters = new Set<() => void>();
  const calls: ChatParams[] = [];
  const interims: ChatParams[] = [];
  const llm: LLMProvider = {
    name: "smoke-sa3-scripted",
    model: "stub-model",
    async chat(p: ChatParams): Promise<ChatResult> {
      calls.push(p);
      // W2-L2（docs/8 §1.4-8）：interim 旁路请求的 messages[1] 与主轮相同（task 路由失效）——
      // 按「含合成状态占位消息」识别（docs/16 文案），固定文本回应、不消耗脚本 cursor
      if (p.messages.some((m) => m.role === "tool" && m.content.startsWith("[子代理已派发、正在后台执行"))) {
        interims.push(p);
        return { content: "（interim）任务在跑，请稍候", toolCalls: [], usage: null };
      }
      // 路由键（docs/9）：优先「最后一条 user 消息」（可复用 worker 的追加任务是历史末尾的
      // 新 user——messages[1] 仍是首任务），未命中脚本则回退 messages[1]（协调者轮次合并
      // interim 后最后一条 user 是插话消息，真实锚点仍是首条 goal）。
      const lastUser = String([...p.messages].reverse().find((m) => m.role === "user")?.content ?? "");
      const task = scripts.has(lastUser) ? lastUser : String(p.messages[1]?.content ?? "");
      for (const prefix of hanging) {
        if (task.startsWith(prefix)) {
          // 预检 + 监听双保险：abort 先于请求到达（装配窗口中止）时 addEventListener 不回放（docs/9 桩坑）
          if (p.signal?.aborted) throw new Error("aborted");
          await new Promise<never>((_, reject) => {
            p.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
      }
      const script = scripts.get(task);
      if (!script) return { content: `(冒烟脚本缺失: ${task.slice(0, 40)})`, toolCalls: [], usage: null };
      const i = cursor.get(task) ?? 0;
      cursor.set(task, i + 1);
      if (gates.get(task) === i) {
        // 编排点：主线程决定何时放行；挂起期间信号 abort 即拒绝（与真实 provider 契约一致——
        // docs/18 打断/外部中止都要能打断挂在编排点上的请求）
        if (p.signal?.aborted) throw new Error("aborted"); // 预检（同 hanging 桩坑）
        await new Promise<void>((res, rej) => {
          gateWaiters.add(res);
          p.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        });
      }
      return script[i] ?? { content: "done", toolCalls: [], usage: null };
    },
  };
  return {
    ...llm,
    addScript: (task, script) => void scripts.set(task, script),
    addHanging: (prefix) => void hanging.add(prefix),
    addGate: (task, round) => {
      gates.set(task, round);
      return new Promise<void>(() => {}); // 等待发生在 chat 内；返回形状保留（调用方仅 void）
    },
    releaseGate: () => {
      for (const res of gateWaiters) res();
      gateWaiters.clear();
    },
    allCalls: () => calls,
    interimRequests: () => interims,
  };
}

const tc = (id: string, name: string, args: Record<string, unknown>): ChatResult => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: null,
});
const final = (text: string): ChatResult => ({ content: text, toolCalls: [], usage: null });

// ---------- 装配 ----------

const userDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa3-u-"));
const wsDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa3-ws-"));
const outsideDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa3-out-"));
const scripted = makeScriptedLlm();
const fakeFormat: ProviderFormatDef = {
  format: "fake",
  label: "冒烟桩",
  create: () => scripted,
  defaultEffort: () => "high",
};

try {
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
  ctx.providerFormats.register(fakeFormat);
  await loadModules(ctx, BUILTIN_MODULES);
  const sh = {
    ctx,
    sessions: new SessionStore(userDir),
    providerFile: {
      path: join(userDir, "providers.json"),
      data: {
        active: "p1",
        providers: [
          { id: "p1", name: "冒烟桩", format: "fake", baseUrl: "http://localhost", apiKey: "", model: "stub-model", effort: "high", contextLength: 100_000, maxTokens: null },
        ],
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
    broadcast: () => {},
  } as unknown as SessionShell;
  // server.ts bootstrap 的同款接线（冒烟里手动挂）：createRuntime 对 coordinator 注入给 agent_task(s)
  ctx.subagent = (rt) => subagentServiceFor(sh, rt);

  const rt = await createRuntime(sh, { workspaceRoot: wsDir, kind: "coordinator" });
  const approvalDecisions: string[] = [];
  const toolCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    workspace: rt.workspace!,
    requestApproval: async () => "allowed-once",
    ...over,
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // docs/16：任务结算报告统一经收件箱送达（冒烟桩壳无 sessionHost → 只入队）。按 FIFO 消费 n 条
  // ——每个场景收齐自己的报告再进入下一场景，队首必然属于当前场景。
  const waitReports = async (n: number): Promise<string[]> => {
    for (let i = 0; i < 400 && (rt.inbox?.length ?? 0) < n; i++) await sleep(5);
    return (rt.inbox ?? []).splice(0, n);
  };

  // ---------- 1) 协调者 registry 与系统提示 ----------
  {
    const names = rt.registry.list().map((t) => t.name).sort();
    const sys = String(rt.agent.messages[0]?.content ?? "");
    record(
      "coordinator 装配：registry 四件（agent_task+stop_subagent+agent_followup/archive_subagent；docs/18 起 pause/resume 退役），提示词含派发纪律(docs/16)/scope/工具参考/执行纪律/可复用",
      names.length === 4 &&
        names.join(",") === "agent_followup,agent_task,archive_subagent,stop_subagent" &&
        sys.includes("派发纪律") &&
        sys.includes("自动送达") &&
        sys.includes("scope") &&
        sys.includes("子代理工具参考") &&
        sys.includes("执行纪律") &&
        sys.includes("可复用子代理"),
      `tools=[${names.join(",")}]；派发纪律=${sys.includes("派发纪律")}`,
    );
  }

  // ---------- 2) 并行派 3 个 worker（docs/15 同轮三调用；docs/16 非阻塞回执 + 报告自动送达；真实 write_file） ----------
  {
    for (const [task, dir] of [
      ["写 dirA", "dirA"],
      ["写 dirB", "dirB"],
      ["写 dirC", "dirC"],
    ] as const) {
      scripted.addScript(task, [tc("c1", "write_file", { path: `${dir}/out.txt`, content: `${task} 的产出` }), final(`${task} 完成`)]);
    }
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const outs = await Promise.all(
      ([
        { name: "wa", description: "写 A", task: "写 dirA" },
        { name: "wb", description: "写 B", task: "写 dirB" },
        { name: "wc", description: "写 C", task: "写 dirC" },
      ] as const).map((r) => agentTask.execute(r, toolCtx())),
    );
    const reports = await waitReports(3);
    const filesOk = ["dirA", "dirB", "dirC"].every((d) => {
      try {
        return readFileSync(join(wsDir, d, "out.txt"), "utf8").endsWith("的产出");
      } catch {
        return false;
      }
    });
    record(
      "agent_task 并行 3 调用：三笔「已派发」回执即时返回，三份完成报告自动送达，各目录文件全部就位",
      outs.every((o) => o.includes("已派发")) &&
        reports.length === 3 &&
        reports.every((r) => r.includes("[子代理任务报告 · 自动送达]") && r.includes("完成]")) &&
        filesOk,
      `回执=${outs.length}；送达=${reports.length}；${filesOk ? reports.map((r) => r.split("\n")[1]?.slice(0, 24)).join(" | ") : "文件缺失"}`,
    );
  }

  // ---------- 3) 同文件冲突：一成一拒 + 拒方重读后自愈（§5.3 per-reader 快照） ----------
  {
    writeFileSync(join(wsDir, "shared.txt"), "v0");
    // B 的完整生命周期 = 一次 runWorker（真实形态）：读 → [编排点：等 A 写完] → 写（期望拒）→ 重读 → edit（期望成）。
    // edit 命中 "A 的 v1" 当且仅当 w2 真被拒——终态即证据（乐观锁失效时文件会是 "B 的 v1"，edit 不命中，终态停在 B 的 v1）
    scripted.addScript("B 全流程", [
      tc("r0", "read_file", { path: "shared.txt" }), // 快照 v0
      tc("w2", "write_file", { path: "shared.txt", content: "B 的 v1" }), // 期望：拒（B 快照 v0 ≠ 磁盘 A v1）
      tc("r2", "read_file", { path: "shared.txt" }), // 重读（快照刷新为 A 的 v1）
      tc("e3", "edit_file", { path: "shared.txt", old_string: "A 的 v1", new_string: "B 的最终" }), // 期望：成
      final("B 完成"),
    ]);
    scripted.addScript("A 读后写共享文件", [
      tc("ra", "read_file", { path: "shared.txt" }),
      tc("wa", "write_file", { path: "shared.txt", content: "A 的 v1" }),
      final("A 完成"),
    ]);
    void scripted.addGate("B 全流程", 1); // B 的第 1 轮（write 轮）挂起，等 A 写完再放行
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const run = (task: string, name: string) => agentTask.execute({ description: "d", task, name }, toolCtx());

    const bAck = await run("B 全流程", "b"); // docs/16：派发即时回执（B 在后台跑，闸门挂起）
    // 等 B 的 read 轮完成、write 轮请求已到闸门挂起（快照建立）——派发即时回执后不再有
    // 「A 跑完才放行」的隐式等待，必须显式等 B 到达编排点再派 A（确定性替代固定 sleep）
    const bRounds = () => scripted.allCalls().filter((c) => String(c.messages[1]?.content ?? "") === "B 全流程").length;
    for (let i = 0; i < 200 && bRounds() < 2; i++) await sleep(5);
    const aAck = await run("A 读后写共享文件", "a-writer"); // A 并行写入成功（磁盘=A v1）
    await sleep(80); // 等 A 的 read+write 两轮走完（磁盘=A v1）
    scripted.releaseGate(); // 放行 B 的写入轮——此刻 B 手里的快照已过期
    const [reportA, reportB] = await waitReports(2);
    const healed = readFileSync(join(wsDir, "shared.txt"), "utf8");
    const aDone = (reportA ?? "") + (reportB ?? "");
    record(
      "同文件冲突：B 旧快照写入被拒（A 的产出未丢）→ 重读后 edit 成功（自愈）；两份报告自动送达",
      bAck.includes("已派发") && aAck.includes("已派发") &&
        aDone.includes("[子代理 a-writer 完成]") && aDone.includes("[子代理 b 完成]") && healed === "B 的最终",
      `终态=${JSON.stringify(healed)}（=最终版 ⇔ w2 被拒且 edit 命中 A 的产出）`,
    );
  }

  // ---------- 4) 并发上限：3 个挂起 worker → 第 4 个派发同步拒绝（C7；docs/16 回执即拒） ----------
  {
    for (const task of ["slow-1", "slow-2", "slow-3", "slow-4"]) scripted.addHanging(task);
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const ctl = new AbortController(); // 场景收尾时 abort，释放槽位给后续场景
    for (const task of ["slow-1", "slow-2", "slow-3"]) {
      const ack = await agentTask.execute({ description: "d", task }, toolCtx({ signal: ctl.signal }));
      if (!ack.includes("已派发")) record("并发上限：占槽派发受理", false, ack.split("\n")[0]!);
    }
    await sleep(100); // 等前三个进入挂起（占满槽位）
    const fourth = await agentTask.execute({ description: "d", task: "slow-4" }, toolCtx());
    record(
      "并发上限：满 3 槽后第 4 个派发立即拒绝回执（未启动不排队）",
      fourth.includes("并发上限") && fourth.includes("未启动"),
      fourth.split("\n")[0],
    );
    ctl.abort();
    const fails = await waitReports(3); // 挂起 worker 全部收尾（中止路径），失败报告送达、槽位清空给后续场景
    record("并发上限收尾：三个中止 worker 的失败报告自动送达（无悬空）", fails.length === 3 && fails.every((r) => r.includes("中止")), `${fails.length} 条`);
  }

  // ---------- 5) 并行审批：两 worker 并行写工作区外文件，串行队列一次一卡（C3/§5.2） ----------
  {
    const o1 = join(outsideDir, "w1.txt");
    const o2 = join(outsideDir, "w2.txt");
    scripted.addScript("审批写区外1", [tc("c1", "write_file", { path: o1, content: "外1" }), final("w1 完成")]);
    scripted.addScript("审批写区外2", [tc("c2", "write_file", { path: o2, content: "外2" }), final("w2 完成")]);
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const broadcasts: { event: string; data: unknown }[] = [];
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = (event, data) => broadcasts.push({ event, data });

    const a1 = await agentTask.execute({ description: "d", task: "审批写区外1", name: "w-one" }, toolCtx());
    const a2 = await agentTask.execute({ description: "d", task: "审批写区外2", name: "w-two" }, toolCtx());
    // 轮询逐张决议（串行队列：同时至多一张在等）
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 200 && rt.pendingApproval === null; i++) await sleep(5);
      if (!rt.pendingApproval) break;
      rt.pendingApproval!("allowed-once");
      approvalDecisions.push("allowed-once");
    }
    const reports = await waitReports(2);
    const cards = broadcasts.filter((b) => b.event === "approval").map((b) => b.data as { command: string; subagent?: string });
    const bothDone = existsSync(o1) && existsSync(o2);
    record(
      "并行审批：一次一卡按序决议，卡带 [子代理 name] 前缀 + subagent 字段，两文件就位、报告送达",
      cards.length === 2 && bothDone && cards.every((c) => c.command.startsWith("[子代理 w-") && c.subagent) &&
        a1.includes("已派发") && a2.includes("已派发") && reports.every((r) => r.includes("完成]")),
      `cards=${cards.length}（${cards.map((c) => c.subagent).join("/")}）files=${bothDone} 送达=${reports.length}`,
    );
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = () => {};
  }

  // ---------- 6) 中途 stop：两个 agent_task 派挂起 worker，abort 后失败报告送达（C8） ----------
  {
    scripted.addHanging("stop-");
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const ctl = new AbortController();
    const acks: string[] = [];
    for (const name of ["s1", "s2"] as const) {
      acks.push(await agentTask.execute({ name, description: "d", task: `stop-${name === "s1" ? "one" : "two"}` }, toolCtx({ signal: ctl.signal })));
    }
    await sleep(100); // 两个 worker 都进入挂起
    ctl.abort();
    const reports = await waitReports(2); // 必须能收尾（不能永悬）
    record(
      "中途 stop：abort 级联到全部 worker，两份中止失败报告自动送达（无悬空；派发本就即时回执）",
      acks.every((o) => o.includes("已派发")) && reports.length === 2 && reports.every((r) => r.includes("中止")),
      reports.map((r) => r.split("\n")[1]?.slice(0, 30)).join(" | "),
    );
  }

  // ---------- 7) P1 死锁修复（docs/6 §1）：审批卡挂起时 stop——卡立即 cancelled、失败报告送达、卡片不残留 ----------
  {
    const o1 = join(outsideDir, "p1-stop-1.txt");
    const o2 = join(outsideDir, "p1-stop-2.txt");
    scripted.addScript("stop卡1", [tc("k1", "write_file", { path: o1, content: "x" }), final("不该到这")]);
    scripted.addScript("stop卡2", [tc("k2", "write_file", { path: o2, content: "x" }), final("不该到这")]);
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const broadcasts: { event: string; data: unknown }[] = [];
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = (event, data) => broadcasts.push({ event, data });
    const ctl = new AbortController();
    const acks: string[] = [];
    for (const name of ["k-one", "k-two"] as const) {
      acks.push(await agentTask.execute({ name, description: "d", task: name === "k-one" ? "stop卡1" : "stop卡2" }, toolCtx({ signal: ctl.signal })));
    }
    // 等第一张卡挂上
    for (let i = 0; i < 200 && rt.pendingApproval === null; i++) await sleep(5);
    if (rt.pendingApproval) {
      ctl.abort(); // 按「停止」：不点卡片——正在等的卡必须随信号自行取消
      const reports = await waitReports(2);
      const auditDecided = rt.auditEvents.filter((e) => e.type === "approval/decided").map((e) => (e as { decision?: string }).decision);
      const p1Cards = auditDecided.filter((d) => d === "cancelled").length;
      record(
        "P1 死锁修复：审批卡挂起时 stop——正在等的卡立即 cancelled、中止失败报告送达、卡片不残留",
        acks.every((o) => o.includes("已派发")) && reports.length === 2 && reports.every((r) => r.includes("中止")) &&
          p1Cards >= 1 && rt.pendingApproval === null && !existsSync(o1) && !existsSync(o2),
        `送达 ${reports.length} 条；cancelled 决议 ${p1Cards} 张；单槽=${rt.pendingApproval === null ? "已清" : "残留"}`,
      );
    } else {
      record("P1 死锁修复：审批卡挂起时 stop", false, "审批卡未挂上（前置条件不成立）");
    }
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = () => {};
  }

  // ---------- 8) docs/18：打断即终结（stop；暂停/恢复机制退役） ----------
  {
    const broadcasts: { event: string; data: unknown }[] = [];
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = (event, data) => broadcasts.push({ event, data });
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    // 编排：worker 三轮 = 工具 → [addGate 挂起第 1 轮（第二次 chat）] → 工具 → 报告
    scripted.addScript("cut-me", [
      tc("p1", "write_file", { path: "pause/w1.txt", content: "第一步" }),
      tc("p2", "write_file", { path: "pause/w2.txt", content: "第二步" }),
      final("不会到达的报告"),
    ]);
    void scripted.addGate("cut-me", 1); // task 名避开既有 hanging 前缀 "stop-"（场景 5 的全局登记不清场） // 第二次 chat 挂起，等编排放行
    const ack = await agentTask.execute({ description: "d", task: "cut-me", name: "stopper" }, toolCtx());
    // 等第一轮工具产物落盘（w1.txt）——此刻 worker 必在第二次 chat 的闸门上，打断会中止该请求
    for (let i = 0; i < 200 && !existsSync(join(wsDir, "pause", "w1.txt")); i++) {
      await sleep(5);
    }
    const entry = [...rt.activeSubagents.values()].find((a) => a.name === "stopper");
    if (!entry || !existsSync(join(wsDir, "pause", "w1.txt"))) {
      record("docs/18 打断即终结", false, "worker 未到达第二次 chat 的编排点");
    } else {
      entry.stop(); // 打断发生在第二次 chat 挂起期间：请求被中止，任务随即结算（没有恢复）
      for (let i = 0; i < 100 && rt.activeSubagents.size > 0; i++) await sleep(5);
      await sleep(60); // 收尾（记录/事件）落定
      const rec = rt.subagents.find((r) => r.name === "stopper");
      const phases = broadcasts
        .filter((b) => b.event === "subagent" && (b.data as { name?: string }).name === "stopper")
        .map((b) => (b.data as { phase: string }).phase);
      const stoppedOk =
        ack.includes("已派发") &&
        rt.activeSubagents.size === 0 && // 打断即结算注销（不再站着并发空位）
        !existsSync(join(wsDir, "pause", "w2.txt")) && // 被打断轮的工具未执行
        rec?.ok === false && String(rec.error ?? "").includes("任务被用户停止") &&
        phases[0] === "spawned" && phases[phases.length - 1] === "error";
      // 打断结算的失败报告不送达（通知/工具文案已覆盖）；并发槽立即释放——新派发可受理
      scripted.addHanging("slot-x");
      const ctl = new AbortController();
      const reaccept = await agentTask.execute({ description: "d", task: "slot-x" }, toolCtx({ signal: ctl.signal }));
      ctl.abort();
      const slotFail = await waitReports(1); // slot-x 中止收尾，失败报告照常送达（中止≠打断）
      const inboxClean = !(rt.inbox ?? []).some((r) => r.includes("stopper"));
      record(
        "docs/18 打断即终结（stop：请求中止、任务结算归档、并发槽释放；打断报告不送达；中止报告照常送达）",
        stoppedOk && reaccept.includes("已派发") && slotFail.length === 1 && slotFail[0]!.includes("中止") && inboxClean,
        `打断结算=${stoppedOk}；槽释放再派=${reaccept.includes("已派发")}；中止报告=${slotFail.length}；打断报告未送达=${inboxClean}；phases=${phases.join("→")}`,
      );
    }
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = () => {};
  }

  // ---------- 9) docs/16：协调者真实轮次非阻塞派发——同轮两个 agent_task 即时回执、当轮收尾、报告送达收件箱 ----------
  {
    const goal = "场景9：派出慢任务";
    const workerTaskA = "场景9慢任务A";
    const workerTaskB = "场景9慢任务B";
    scripted.addScript(goal, [
      // docs/15：同轮两个 agent_task 调用——真实走 agent.ts 工具循环的协调者并行分支
      {
        content: "",
        toolCalls: [
          { id: "cz9a", name: "agent_task", arguments: JSON.stringify({ name: "slow-nine", description: "慢任务", task: workerTaskA }) },
          { id: "cz9b", name: "agent_task", arguments: JSON.stringify({ name: "slow-ten", description: "慢任务", task: workerTaskB }) },
        ],
        usage: null,
      },
      final("场景9最终报告"),
    ]);
    scripted.addScript(workerTaskA, [final("慢任务A完成")]);
    scripted.addScript(workerTaskB, [final("慢任务B完成")]);
    const out = await rt.agent.run(goal);
    // 协调者第 2 轮请求：两条 tool 消息都是「已派发」回执——派发不再阻塞轮次（docs/16 的核心形态）
    const mainReqs = scripted.allCalls().filter((c) => c.messages.some((m) => m.role === "user" && m.content === goal));
    const second = mainReqs[1];
    const toolMsgs = (second?.messages ?? []).filter((m) => m.role === "tool");
    const acksOk = toolMsgs.length === 2 && toolMsgs.every((m) => m.content.includes("已派发"));
    const reports = await waitReports(2);
    record(
      "docs/16 协调者真实轮次：同轮两个 agent_task 即时回执（不阻塞轮次）→ 协调者当轮收尾；两份完成报告自动送达收件箱",
      out?.finalText === "场景9最终报告" &&
        acksOk &&
        reports.length === 2 &&
        reports.every((r) => r.includes("[子代理任务报告 · 自动送达]")) &&
        reports.some((r) => r.includes("慢任务A完成")) &&
        reports.some((r) => r.includes("慢任务B完成")),
      `报告=${out?.finalText ?? "无"}；回执全为已派发=${acksOk}；送达=${reports.length} 条`,
    );
  }

  // ---------- 10) docs/9 可复用子代理：reusable 派发 → idle 待命（记录 upsert）→ followup 追加（历史延续）→ 归档 → 再派被拒 ----------
  {
    const broadcasts: { event: string; data: unknown }[] = [];
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = (event, data) => broadcasts.push({ event, data });
    scripted.addScript("场景10首任务", [final("场景10首任务报告：产出 A")]);
    scripted.addScript("场景10追加任务", [final("场景10追加报告：产出 B")]);
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const followup = rt.registry.list().find((t) => t.name === "agent_followup")!;
    const archiveTool = rt.registry.list().find((t) => t.name === "archive_subagent")!;

    // 首任务（reusable 派发）：派发即回执；结算报告送达收件箱（待命提示 = 协调者感知存活状态的唯一事实源）
    const r1 = await agentTask.execute({ name: "spec", description: "场景10专家", task: "场景10首任务", reusable: true }, toolCtx());
    const [report1] = await waitReports(1); // 等结算（记录/句柄/idle 事件定型后再断言）
    const spawned = broadcasts.find((b) => b.event === "subagent" && (b.data as { name?: string }).name === "spec");
    const subId = (spawned?.data as { subId?: number } | undefined)?.subId;
    const rec1 = rt.subagents.find((r) => r.subId === subId);
    const phase1 = broadcasts
      .filter((b) => b.event === "subagent" && (b.data as { subId?: number }).subId === subId)
      .map((b) => (b.data as { phase: string }).phase);
    const spawnOk =
      r1.includes("已派发") &&
      r1.includes(`spec#${subId}`) &&
      (report1 ?? "").includes(`[子代理 spec 完成]`) &&
      (report1 ?? "").includes("已保留待命") &&
      subId !== undefined &&
      (spawned?.data as { reusable?: boolean }).reusable === true &&
      phase1.join("→") === "spawned→idle" &&
      rec1?.reusable === true &&
      rec1?.state === "idle" &&
      rec1?.tasks === 1 &&
      rt.activeSubagents.get(subId!)?.status === "idle";

    // 追加任务：派发即回执；第 2 份报告带「第 2 次任务」；请求含首任务上下文（历史延续 = 复用价值）
    const r2 = await followup.execute({ name: "spec", description: "场景10追加", task: "场景10追加任务" }, toolCtx());
    const [report2] = await waitReports(1);
    const followupReq = scripted
      .allCalls()
      .filter((c) => c.messages.some((m) => m.role === "user" && m.content === "场景10追加任务"))
      .at(-1);
    const continuityOk =
      followupReq !== undefined &&
      followupReq.messages.some((m) => m.role === "user" && m.content === "场景10首任务") &&
      followupReq.messages.some((m) => m.role === "assistant" && m.content === "场景10首任务报告：产出 A");
    const rec2 = rt.subagents.find((r) => r.subId === subId);
    const followupOk =
      r2.includes("已派发") &&
      (report2 ?? "").includes("[子代理 spec 完成]") &&
      (report2 ?? "").includes("第 2 次任务") &&
      (report2 ?? "").includes("已保留待命") &&
      continuityOk &&
      rec2?.state === "idle" &&
      rec2?.tasks === 2 &&
      rt.activeSubagents.get(subId!)?.status === "idle";

    // 归档：记录定格 state:"archived"、句柄注销、archived 事件；归档后再派被拒
    const archMsg = await archiveTool.execute({ subId }, toolCtx());
    const rec3 = rt.subagents.find((r) => r.subId === subId);
    const r3 = await followup.execute({ subId, task: "场景10再派" }, toolCtx());
    const miss = await followup.execute({ name: "不存在的", task: "场景10幽灵" }, toolCtx());
    const phaseAll = broadcasts
      .filter((b) => b.event === "subagent" && (b.data as { subId?: number }).subId === subId)
      .map((b) => (b.data as { phase: string }).phase);
    const archOk =
      archMsg.includes("已归档子代理：spec#") &&
      archMsg.includes("共完成 2 次任务") &&
      rec3?.state === "archived" &&
      rec3?.tasks === 2 &&
      !rt.activeSubagents.has(subId!) &&
      r3.includes("已归档") &&
      miss.includes("没有找到这个子代理") &&
      phaseAll.join("→") === "spawned→idle→task→idle→archived";
    record(
      "docs/9 可复用生命周期：reusable 派发→idle（记录 upsert state:idle/tasks）；followup 历史延续+第 2 次任务；归档定格 archived+句柄注销+再派被拒",
      spawnOk && followupOk && archOk,
      `派发=${spawnOk}；追加=${followupOk}（历史延续=${continuityOk}）；归档=${archOk}；phases=${phaseAll.join("→")}`,
    );
    (sh as { broadcast: (e: string, d: unknown) => void }).broadcast = () => {};
  }

  rmSync(userDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
} catch (e) {
  record("SA3 冒烟执行", false, e instanceof Error ? `${e.message}` : String(e));
}

console.log(`\nSA3 冒烟：${results.length - fail()}/${results.length} 项通过`);
process.exit(fail() > 0 ? 1 : 0);
