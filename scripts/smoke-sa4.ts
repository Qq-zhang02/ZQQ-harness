/**
 * SA4 隔离冒烟（docs/5 §6 SA4，零 token：全程不发 LLM 网络请求）：可观测性与打磨——
 * A) 进程内真实装配（BUILTIN_MODULES + createRuntime(kind=coordinator) + 真实系统工具）：
 *   1) SSE subagent 事件：agent_task 并行派 2 worker（docs/15：Promise.all 两个 agent_task 调用；docs/16：派发即回执，
 *      完成/失败报告经收件箱自动送达）→ spawned×2 先于 done/error（同步段广播），载荷带 sessionId/subId/name/phase/summary/rounds/usage/error；
 *   2) 配额拒绝不发事件（未启动不产生可观测性噪声）；
 *   3) 审计记录 + 存档往返：rt.subagents → toSessionData 落盘 → SessionStore.load 读回 →
 *      createRuntime(fromDisk) 恢复 rt.subagents 并按条数续期 subagentTotal（偏差 15）；
 *      currentState 下发 subagents（/status 与前端刷新恢复的数据源）；
 *   4) 配额续期行为：恢复后再派 1 个 worker，subagentTotal = 恢复值 + 1（而非归零重计）；
 * B) 前端三端同步双保险：index.html 的 SSE_HANDLERS 表含 subagent 键 + 渲染函数存在
 *    （契约测试已锁三端一致，冒烟运行时再读源码确认一次）；server.ts 行数哨兵复核。
 * C) docs/6 真机反馈修复：5) P2 worker 直调真 MCP（demo stdio 服务器全链路 + 协调者
 *    registry 仅两件/系统提示无 MCP 段红线）；6) P3 方案 A worker 全程 transcript 落盘
 *    （文件内容/记录/SSE 事件携带路径）+ 方案 B 实时过程流（tool/toolResult 事件序列）
 *    + 前端查看入口渲染链。
 * 全程临时目录，不触碰真实 ~/.ZQQ-harness。用法：node scripts/smoke-sa4.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../src/core/context.ts";
import { loadModules } from "../src/core/module.ts";
import { BUILTIN_MODULES } from "../src/modules.ts";
import { loadConfig, SUBAGENT_MAX_TOTAL } from "../src/config.ts";
import { SessionStore } from "../src/web/sessions.ts";
import { createRuntime, currentState, type SessionShell } from "../src/web/session-runtime.ts";
import { toSessionData } from "../src/web/session-lifecycle.ts";
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

// ---------- 脚本化提供方：按 worker 的 task 全文路由脚本（无 usage，验证载荷省略字段） ----------

function makeScriptedLlm(): { llm: LLMProvider; addScript(task: string, script: ChatResult[]): void } {
  const scripts = new Map<string, ChatResult[]>();
  const cursor = new Map<string, number>();
  return {
    llm: {
      name: "smoke-sa4-scripted",
      model: "stub-model",
      async chat(p: ChatParams): Promise<ChatResult> {
        const task = String(p.messages[1]?.content ?? "");
        const script = scripts.get(task);
        if (!script) return { content: `(冒烟脚本缺失: ${task.slice(0, 40)})`, toolCalls: [], usage: null };
        const i = cursor.get(task) ?? 0;
        cursor.set(task, i + 1);
        return script[i] ?? { content: "done", toolCalls: [], usage: null };
      },
    },
    addScript: (task, script) => void scripts.set(task, script),
  };
}

const final = (text: string, usage?: ChatResult["usage"]): ChatResult => ({ content: text, toolCalls: [], usage: usage ?? null });

/** subagent 事件载荷（SSE_HANDLERS 消费面）。 */
interface SubEv {
  sessionId: string;
  subId: number;
  name: string;
  phase: string;
  summary?: string;
  rounds?: number;
  usage?: { prompt: number; completion: number };
  error?: string;
}

const userDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa4-u-"));
const wsDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa4-ws-"));

try {
  const scripted = makeScriptedLlm();
  const fakeFormat: ProviderFormatDef = {
    format: "fake",
    label: "冒烟桩",
    create: () => scripted.llm,
    defaultEffort: () => "high",
  };
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
  const broadcasts: { event: string; data: unknown }[] = [];
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
    broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
  } as unknown as SessionShell;
  ctx.subagent = (rt) => subagentServiceFor(sh, rt); // server.ts bootstrap 的同款接线

  const rt = await createRuntime(sh, { workspaceRoot: wsDir, kind: "coordinator" });
  const toolCtx = (): ToolContext => ({ workspace: rt.workspace!, requestApproval: async () => "allowed-once" });
  const subEvs = () => broadcasts.filter((b) => b.event === "subagent").map((b) => b.data as SubEv);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // docs/16：任务结算报告统一进收件箱（冒烟桩壳无 sessionHost → 只入队）。按 FIFO 消费 n 条
  //（每个场景收齐自己的报告再前进，队首必然属于当前场景）。
  const waitReports = async (box: { inbox?: string[] }, n: number): Promise<string[]> => {
    for (let i = 0; i < 400 && (box.inbox?.length ?? 0) < n; i++) await sleep(5);
    return (box.inbox ?? []).splice(0, n);
  };

  // ---------- 1) SSE subagent 事件：并行 2 worker（一成一败）的 spawned→done/error ----------
  {
    scripted.addScript("成功任务", [final("报告：完成", { promptTokens: 1200, completionTokens: 400 })]);
    scripted.addScript("空回复任务", [final("   ")]); // 空回复 → 失败路径
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    // docs/15：agent_tasks 退役——并行派发 = 同时发出两个 agent_task 调用（同轮多调用并行执行）
    const [outOk, outBad] = await Promise.all([
      agentTask.execute({ name: "impl-auth", description: "实现认证", task: "成功任务" }, toolCtx()),
      agentTask.execute({ name: "impl-bad", description: "注定失败", task: "空回复任务" }, toolCtx()),
    ]);
    const reports = await waitReports(rt, 2); // docs/16：一成一败两份报告送达收件箱（收尾定型后再断言事件）
    const evs = subEvs();
    const phases = evs.map((e) => `${e.phase}:${e.name}`);
    const spawnedFirst = evs.slice(0, 2).every((e) => e.phase === "spawned"); // 同步段广播：两个 spawned 先于任何收尾
    const ok = evs.length === 4 &&
      spawnedFirst &&
      evs[0]!.sessionId === rt.id && evs[0]!.subId === 1 && evs[0]!.name === "impl-auth" && evs[0]!.summary === "实现认证" &&
      evs[2]!.phase === "done" && evs[2]!.rounds === 1 && evs[2]!.usage?.prompt === 1200 && evs[2]!.usage?.completion === 400 &&
      evs[3]!.phase === "error" && (evs[3]!.error ?? "").includes("空回复") && evs[3]!.usage === undefined;
    record(
      "SSE subagent 事件：并行派发生成 spawned×2 → done/error，载荷含 sessionId/subId/name/summary/rounds/usage/error；完成/失败报告自动送达",
      ok && outOk.includes("已派发") && outBad.includes("已派发") &&
        reports.length === 2 &&
        reports.some((r) => r.includes("[子代理 impl-auth 完成]")) &&
        reports.some((r) => r.includes("[子代理 impl-bad 失败]") && r.includes("空回复")),
      `序列=[${phases.join(" → ")}]；送达=${reports.length}`,
    );
  }

  // ---------- 2) 配额拒绝不发事件（未启动不进可观测性时间线） ----------
  {
    const before = subEvs().length;
    const beforeRecs = rt.subagents.length;
    rt.subagentTotal = SUBAGENT_MAX_TOTAL; // 顶到累计上限
    const agentTask = rt.registry.list().find((t) => t.name === "agent_task")!;
    const out = await agentTask.execute({ description: "d", task: "超限任务" }, toolCtx());
    record(
      "配额拒绝：立即报错回传，不产生 subagent 事件、不产生审计记录",
      out.includes("累计上限") && out.includes("未启动") && subEvs().length === before && rt.subagents.length === beforeRecs,
      out.split("\n")[0]!,
    );
    rt.subagentTotal -= 1; // 回退本场景的手动顶格，恢复真实计数（2 条记录）
  }

  // ---------- 3) 审计记录 + 存档往返：落盘 → 读回 → createRuntime 恢复 + currentState 下发 ----------
  {
    const data = toSessionData(rt, "协调者会话", [{ role: "user", content: "开工" }]);
    sh.sessions.save(data);
    const disk = sh.sessions.load(rt.id);
    const diskOk = disk !== null && disk.subagents?.length === 2 &&
      disk.subagents![0]!.name === "impl-auth" && disk.subagents![0]!.ok === true && disk.subagents![0]!.usage?.prompt === 1200 &&
      disk.subagents![1]!.ok === false && (disk.subagents![1]!.error ?? "").includes("空回复");

    sh.runtimes.delete(rt.id); // 模拟重启：运行态丢弃，走磁盘恢复
    const restored = await createRuntime(sh, { id: rt.id, fromDisk: sh.sessions.load(rt.id)! });
    const state = currentState(sh, restored) as { subagents: unknown[] };
    record(
      "存档往返：SessionData.subagents 落盘读回无损；createRuntime 恢复记录并按条数续期 subagentTotal；currentState 下发",
      diskOk && restored.subagents.length === 2 && restored.subagentTotal === 2 && state.subagents.length === 2,
      `磁盘=${diskOk ? "无损" : "损坏"}；恢复后 total=${restored.subagentTotal}（=记录条数）`,
    );

    // ---------- 4) 配额续期行为：恢复后再派 1 个，累计从恢复值继续（而非归零重计） ----------
    scripted.addScript("续期验证任务", [final("又完成一个")]);
    const agentTask = restored.registry.list().find((t) => t.name === "agent_task")!;
    const out = await agentTask.execute({ description: "d", task: "续期验证任务", name: "resume-check" }, {
      workspace: restored.workspace!,
      requestApproval: async () => "allowed-once",
    });
    const [report] = await waitReports(restored, 1); // docs/16：等结算报告送达（记录定型）
    record(
      "配额续期：恢复的会话再派 worker，subagentTotal = 恢复值+1（重启不重置累计闸）；完成报告自动送达",
      out.includes("已派发") && report.includes("[子代理 resume-check 完成]") && restored.subagentTotal === 3 && restored.subagents.length === 3,
      `total=${restored.subagentTotal}、记录=${restored.subagents.length}`,
    );
  }

  // ---------- B) 前端三端同步双保险 + server.ts 哨兵复核（契约测试之外运行时再读一次源码） ----------
  {
    const html = readFileSync(join(import.meta.dirname, "..", "src", "web", "public", "index.html"), "utf8");
    const serverLines = readFileSync(join(import.meta.dirname, "..", "src", "web", "server.ts"), "utf8").split("\n").length;
    const start = html.indexOf("const SSE_HANDLERS = {");
    const end = html.indexOf("\n};", start);
    const hasKey = html.slice(start, end).includes("\n  subagent(");
    record(
      "前端三端：SSE_HANDLERS 含 subagent 键 + onSubagent 渲染函数 + /status 子代理行；server.ts 零改动（≤270 行，DT0 调整）",
      hasKey && html.includes("function onSubagent") && html.includes("🎯 子代理 ") && serverLines <= 270, // docs/25 DT0：250→270（进程生命周期代码合法进壳）
      `handler=${hasKey}；server.ts=${serverLines} 行`,
    );
    // docs/22 §4.1：图片规则单一出处——前端校验/按钮 title 全走 meta.imageRules（imgRules()），
    // 不再有 IMG_MIMES/规则字面量散落；HTML 静态 accept/title 保留作无 JS 降级（带注释指向 config.ts）。
    record(
      "图片规则单一出处（docs/22 §4.1）：前端校验走 meta.imageRules（imgRules），无 IMG_MIMES/4 张/5MB 校验字面量；静态 accept 降级保留且注释指向 config.ts",
      !html.includes("IMG_MIMES") &&
        html.includes("const imgRules = () => metaOf().imageRules") &&
        html.includes("r.maxCount") && html.includes("r.maxBytes") && html.includes("r.mimes.includes") &&
        !/(pendingImages\.length >= 4|f\.size > 5 \* 1024 \* 1024)/.test(html) &&
        html.includes('id="imgFile" accept="image/png,image/jpeg,image/gif,image/webp"') &&
        /<!-- accept 的 mime 清单 = config\.ts IMAGE_RULES\.mimes/.test(html),
      "",
    );
  }

  // ---------- 5) P2：worker 直调真 MCP（demo stdio 服务器全链路，docs/6 §2.3 路线 A） ----------
  {
    writeFileSync(
      join(wsDir, "mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [join(process.cwd(), "scripts", "demo-mcp-server.mjs")] } } }),
      "utf8",
    );
    scripted.addScript("MCP 查询", [
      { content: "", toolCalls: [{ id: "m1", name: "mcp__demo__add", arguments: '{"a":20,"b":22}' }], usage: null },
      final("报告：MCP 工具调用完成"),
    ]);
    // 全新协调者运行态：worker MCP 配置懒加载只在首个 worker 时读一次（会话语义，与普通会话
    // createRuntime 读一次一致）——上面的 rt 已在无 mcp.json 时初始化过（缓存 null），换新会话验
    const rt2 = await createRuntime(sh, { workspaceRoot: wsDir, kind: "coordinator" });
    const approvalsBefore = broadcasts.filter((b) => b.event === "approval").length;
    const agentTask = rt2.registry.list().find((t) => t.name === "agent_task")!;
    const out = await agentTask.execute({ description: "d", task: "MCP 查询", name: "mcp-user" }, {
      workspace: rt2.workspace!,
      requestApproval: async () => "allowed-once",
    });
    const coordNames = rt2.registry.list().map((t) => t.name);
    const [mcpReport] = await waitReports(rt2, 1); // docs/16：等结算报告送达（收尾定型后再断言存档与事件）
    record(
      "P2 worker MCP：worker 直调 mcp__demo__add 全链路不弹审批；协调者 registry 仍五件、系统提示仍无 MCP 段（红线）；完成报告自动送达",
      out.includes("已派发") &&
        mcpReport.includes("[子代理 mcp-user 完成]") &&
        broadcasts.filter((b) => b.event === "approval").length === approvalsBefore &&
        coordNames.join(",") === "agent_followup,agent_task,archive_subagent,stop_subagent" &&
        !String(rt2.agent.messages[0]?.content ?? "").includes("mcp__demo"),
      `结果=${mcpReport.split("\n")[1]?.slice(0, 40)}；registry=${coordNames.join("、")}`,
    );
    rt2.mcp.stop(); // 回收 worker 共享连接（demo 服务器进程）；下一段直接读盘上 transcript
    rmSync(join(wsDir, "mcp.json"), { force: true });

    // ---------- 6) P3：worker 全程 transcript 落盘（docs/6 §3 方案 A；读取 API 的单测在 web-sessions.test.ts） ----------
    const rec = rt2.subagents[rt2.subagents.length - 1]!; // 上面刚跑完的 mcp-user worker
    const file = rec.transcript ? join(sh.sessions.spillDir(rt2.id)!, rec.transcript) : "";
    let parsed: { messages?: { role: string; content?: unknown }[] } = {};
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
    } catch {
      /* 留空 → 断言失败 */
    }
    const subDone = broadcasts.filter((b) => b.event === "subagent").map((b) => b.data as { transcript?: string }).at(-1);
    record(
      "P3 过程存档：worker 收尾落 transcript.json（任务书/mcp 工具结果 42/报告、无系统提示），记录与 SSE done 事件携带路径",
      !!rec.transcript &&
        existsSync(file) &&
        parsed.messages?.[0]?.role === "user" &&
        String(parsed.messages?.[0]?.content).includes("MCP 查询") &&
        parsed.messages?.some((m) => m.role === "tool" && String(m.content).includes("42")) &&
        parsed.messages?.some((m) => m.role === "assistant" && m.content === "报告：MCP 工具调用完成") &&
        parsed.messages?.every((m) => m.role !== "system") &&
        subDone?.transcript === rec.transcript,
      rec.transcript ?? "（未落盘）",
    );

    // ---------- 7) P3 方案 B：实时过程流（worker 工具调用/结果穿透 subagent 事件） ----------
    const stream = broadcasts
      .filter((b) => b.event === "subagent")
      .map((b) => b.data as { sessionId?: string; subId?: number; phase: string; toolName?: string; output?: string; id?: string })
      .filter((e) => e.sessionId === rt2.id && e.subId === 1);
    record(
      "P3 实时过程流：mcp-user 的 spawned→tool→toolResult→done 事件序列（带工具名/callId/截断输出，无 delta 级）",
      JSON.stringify(stream.map((e) => e.phase)) === JSON.stringify(["spawned", "tool", "toolResult", "done"]) &&
        stream[1]!.toolName === "mcp__demo__add" &&
        stream[1]!.id === "m1" &&
        (stream[2]!.output ?? "").includes("42") &&
        stream[2]!.id === "m1",
      stream.map((e) => e.phase).join(" → "),
    );
  }

  // ---------- P3 前端查看入口源码检查（需求三 docs/8 §3 + 第三棒后改锁抽屉渲染面；契约测试锁事件名，这里锁 P3 的 UI 链） ----------
  {
    const html = readFileSync(join(import.meta.dirname, "..", "src", "web", "public", "index.html"), "utf8");
    record(
      "P3 前端入口（需求三抽屉版 + 第三棒实时轮询 + docs/9 可复用/归档）：A=抽屉容器/开关/详情页 + [[过程档案#N]]→linkify 进抽屉；B=onSubagent 改道抽屉缓存（不依赖 curTool）+ makeTimeline；C=运行中详情页轮询服务端实时历史（pollLiveDetail）；D=idle/archived 相位 + 归档按钮（drwArchBtn）",
      html.includes('id="subDrawer"') && html.includes('id="subDrwBtn"') && html.includes('id="drwBody"') &&
        html.includes("function linkifyTranscriptTags") && html.includes("[[过程档案#") &&
        html.includes("function makeTimeline") && html.includes('phase === "tool"') &&
        html.includes("function ensureDrawerRow") && html.includes("function pollLiveDetail") &&
        html.includes('phase === "idle"') && html.includes('phase === "archived"') && html.includes("function drwArchBtn") &&
        !html.includes("if (!curTool) return;") && !html.includes('id="subModal"'),
      "",
    );
  }

  rmSync(userDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
} catch (e) {
  record("SA4 冒烟执行", false, e instanceof Error ? `${e.message}` : String(e));
}

console.log(`\nSA4 冒烟：${results.length - fail()}/${results.length} 项通过`);
process.exit(fail() > 0 ? 1 : 0);
