/**
 * SA2 隔离冒烟（docs/5 §6 SA2，零 token：全程不发 LLM 网络请求）：协调者会话产品化——
 * A) 进程内真实装配（BUILTIN_MODULES + createRuntime/newSessionForView）：
 *   1) newSessionForView(kind=coordinator)：rt.kind、registry 仅 agent_task、
 *      系统提示 = 协调者 base 新文案 + 「子代理（worker）系统提示词说明」段（docs/20：
 *      run_pwsh 等 worker 工具行只在该段内；MCP 未连接无说明段）；
 *   2) currentState 下发 kind；SessionStore 列表项带 kind（侧边栏 🎯 徽标数据源）；
 *   3) 磁盘恢复：清 runtimes 缓存后 switchView 装载，kind 与系统提示还原（不变量 6）；
 *   4) normal 对照：缺省 newSessionForView 走普通 base 文案（字节等价现状）；
 *   5) bindWorkspace 边界：协调者引导会话绑工作区不装 MCP（registry 不被 mcp__ 污染）。
 * B) HTTP 端到端（真实 server.ts 子进程，临时 USERPROFILE + 独立端口；补做 SA1 遗留的
 *    「curl 建协调者会话」验证，等价用 fetch）：绑工作区 → /api/sessions/new kind 白名单 →
 *    /api/sessions 列表带 kind → /api/sessions/load 的 state.kind 与 system 提示。
 * 全程临时目录，不触碰真实 ~/.ZQQ-harness。用法：node scripts/smoke-sa2.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext } from "../src/core/context.ts";
import { loadModules } from "../src/core/module.ts";
import { BUILTIN_MODULES } from "../src/modules.ts";
import { loadConfig } from "../src/config.ts";
import { SessionStore } from "../src/web/sessions.ts";
import { createRuntime, currentState, type SessionShell } from "../src/web/session-runtime.ts";
import { bindWorkspace, newSessionForView, switchView } from "../src/web/session-lifecycle.ts";
import { subagentServiceFor } from "../src/web/subagents.ts";
import type { ProviderFormatDef } from "../src/core/types.ts";
import type { ChatParams, ChatResult, LLMProvider } from "../src/llm/provider.ts";

const results: { name: string; ok: boolean; note: string }[] = [];
function record(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? " — " + note : ""}`);
}
const fail = () => results.filter((r) => !r.ok).length;

const stubLlm: LLMProvider = {
  name: "smoke-stub",
  model: "stub-model",
  chat: async (p: ChatParams) => {
    const r: ChatResult = { content: "stub", toolCalls: [], usage: null };
    if (p.onTextDelta) p.onTextDelta(r.content);
    return r;
  },
};
const fakeFormat: ProviderFormatDef = {
  format: "fake",
  label: "冒烟桩",
  create: () => stubLlm,
  defaultEffort: () => "high",
};

// ---------- Part A：进程内装配验证 ----------

const userDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa2-u-"));
const wsDir = mkdtempSync(join(tmpdir(), "zqq-smoke-sa2-ws-"));
const wsDir2 = mkdtempSync(join(tmpdir(), "zqq-smoke-sa2-ws2-"));
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
    config: loadConfig(),
    sessions: new SessionStore(userDir),
    providerFile: {
      path: join(userDir, "providers.json"),
      data: {
        active: "p1",
        providers: [
          {
            id: "p1",
            name: "冒烟桩",
            format: "fake",
            baseUrl: "http://localhost",
            apiKey: "",
            model: "stub-model",
            effort: "high",
            contextLength: 100_000,
            maxTokens: null,
          },
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
  } as SessionShell;
  ctx.subagent = (rt) => subagentServiceFor(sh, rt);

  // 1) 协调者会话（经产品入口 newSessionForView，而非直接 createRuntime）
  const coord = await newSessionForView(sh, wsDir, "coordinator");
  record("newSessionForView(kind) 建协调者会话", coord?.kind === "coordinator");
  const names = coord!.registry.list().map((t) => t.name);
  record(
    "registry 四件：agent_task + stop_subagent + agent_followup/archive_subagent（docs/18 起 pause/resume 退役）",
    names.join(",") === "agent_followup,agent_task,archive_subagent,stop_subagent",
    names.join("、"),
  );
  const coordSys = String(coord!.agent.messages[0]?.content ?? "");
  record(
    "系统提示 = 协调者 base 新文案 + 子代理系统提示词说明段（docs/20：run_pwsh 等 worker 工具行只在该段内；MCP 未连接无说明段）",
    coordSys.includes("任务协调者") &&
      coordSys.includes("agent_task") &&
      coordSys.includes("# 子代理（worker）系统提示词说明") &&
      coordSys.includes("run_pwsh ——") && // docs/20：子代理段重放 worker 工具行
      coordSys.includes("可用工具：agent_followup") && // 协调者自身工具行仍只有四件（按名排序开头）
      !coordSys.includes("# MCP 服务器使用说明"),
  );

  // 2) currentState 下发 kind；列表项带 kind
  record("currentState 下发 kind=coordinator", currentState(sh, coord!).kind === "coordinator");
  coord!.agent.restore([{ role: "user", content: "冒烟：让协调者规划一个任务" }]); // 有消息才不被空占位清扫
  const { persistSession } = await import("../src/web/session-lifecycle.ts");
  persistSession(sh, coord!);
  const meta = sh.sessions.list().find((s) => s.id === coord!.id);
  record("SessionStore 列表项带 kind（侧边栏 🎯 数据源）", meta?.kind === "coordinator");

  // 3) 磁盘恢复：清缓存后 switchView 走 fromDisk 路径
  sh.runtimes.delete(coord!.id);
  const restored = await switchView(sh, coord!.id);
  record(
    "磁盘恢复：kind 与系统提示还原",
    restored?.kind === "coordinator" && String(restored?.agent.messages[0]?.content ?? "").includes("任务协调者"),
  );

  // 4) normal 对照：缺省入口字节等价现状
  const plain = await newSessionForView(sh, wsDir);
  const plainSys = String(plain!.agent.messages[0]?.content ?? "");
  record(
    "normal 对照：普通 base 文案（agent 助手 + 安全规则），无协调者文案",
    plainSys.includes("agent 助手") && plainSys.includes("安全规则") && !plainSys.includes("任务协调者"),
  );
  record("normal currentState.kind=normal", currentState(sh, plain!).kind === "normal");

  // 5) bindWorkspace 边界：协调者引导会话绑工作区不装 MCP
  const coordBlank = await createRuntime(sh, { workspaceRoot: null, kind: "coordinator" });
  await bindWorkspace(sh, coordBlank, wsDir2);
  const blankNames = coordBlank.registry.list().map((t) => t.name);
  const blankSys = String(coordBlank.agent.messages[0]?.content ?? "");
  record(
    "bindWorkspace：协调者绑工作区后 registry 仍六件（无 mcp__ 污染）、系统提示无 MCP 段",
    blankNames.join(",") === "agent_followup,agent_task,archive_subagent,stop_subagent" && !blankSys.includes("# MCP 服务器使用说明"),
  );
} catch (e) {
  record("Part A 执行", false, e instanceof Error ? `${e.message}\n${e.stack?.split("\n")[1] ?? ""}` : String(e));
} finally {
  rmSync(userDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(wsDir2, { recursive: true, force: true });
}

// ---------- Part B：HTTP 端到端（真实 server.ts 子进程） ----------

const PORT = 18891;
const httpHome = mkdtempSync(join(tmpdir(), "zqq-smoke-sa2-http-"));
const httpWs = mkdtempSync(join(tmpdir(), "zqq-smoke-sa2-httpws-"));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
let child: ReturnType<typeof spawn> | null = null;
try {
  child = spawn(process.execPath, ["src/web/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, USERPROFILE: httpHome, PORT: String(PORT), ZQQ_NO_BROWSER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverErr: string[] = [];
  child.stderr?.on("data", (d) => serverErr.push(String(d)));

  const base = `http://127.0.0.1:${PORT}`;
  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  // 等 server ready（/api/meta 200）
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(base + "/api/meta");
      up = r.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  record("HTTP：server.ts 子进程启动（临时 USERPROFILE 隔离）", up, serverErr.join(" ").slice(0, 120));

  if (up) {
    // 绑工作区（引导会话）→ 建协调者（SA1 遗留的 curl 验证，等价 fetch）
    const ws = await post("/api/workspace", { path: httpWs });
    record("HTTP：绑定工作区", ws.status === 200, `state.kind=${String(ws.data.kind)}`);
    const created = await post("/api/sessions/new", { kind: "coordinator" });
    record("HTTP：POST /api/sessions/new {kind:coordinator} → 202", created.status === 202 && created.data.ok === true);

    const list = (await (await fetch(base + "/api/sessions")).json()) as {
      current: string;
      groups: { workspace: string; items: { id: string; kind?: string }[] }[];
    };
    const item = list.groups.flatMap((g) => g.items).find((s) => s.id === list.current);
    record("HTTP：会话列表项带 kind=coordinator", item?.kind === "coordinator");

    const loaded = await post("/api/sessions/load", { id: list.current });
    const state = loaded.data.state as { kind?: string } | undefined;
    const msgs = loaded.data.messages as { role: string; content: string }[] | undefined;
    record(
      "HTTP：load 下发 state.kind 与协调者系统提示",
      state?.kind === "coordinator" && !!msgs?.[0] && msgs[0].role === "system" && msgs[0].content.includes("任务协调者"),
    );

    // 野值白名单：不报错、归一 normal
    const wild = await post("/api/sessions/new", { kind: "evil" });
    const list2 = (await (await fetch(base + "/api/sessions")).json()) as {
      current: string;
      groups: { workspace: string; items: { id: string; kind?: string }[] }[];
    };
    const item2 = list2.groups.flatMap((g) => g.items).find((s) => s.id === list2.current);
    record("HTTP：野值 kind 归一 normal（白名单）", wild.status === 202 && item2?.kind === undefined);
  }
} catch (e) {
  record("Part B 执行", false, e instanceof Error ? `${e.message}` : String(e));
} finally {
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(httpHome, { recursive: true, force: true });
  rmSync(httpWs, { recursive: true, force: true });
}

console.log(`\n${fail() === 0 ? "全部通过" : `${fail()} 项失败`}`);
process.exit(fail() === 0 ? 0 : 1);
