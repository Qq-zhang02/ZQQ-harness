/**
 * Web UI 瘦壳（模块化架构重构 §4.10/P6）：只负责 bootstrap 装配、静态页、SSE 流、
 * /api/meta 与路由查表分发——全部 /api/* 端点由 modules/web-* 注册进 ctx.routes。
 * 会话装配在 web/session-runtime.ts，生命周期在 web/session-lifecycle.ts，
 * 共享单例收进 SessionShell；web-* 模块经 ctx.sessionHost（core/host.ts）触达会话机器。
 * 浏览器 ← SSE 推流（全部带 sessionId）；浏览器 → POST（消息/批准/设置/工作区）。
 */
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, HARNESS_CONFIG } from "../config.ts";
import { ensureProvidersFile } from "../providers/store.ts";
import { SessionStore } from "./sessions.ts";
import { loadRecentWorkspaces, workspacesFilePath } from "./workspaces.ts";
import { ensureUserDir } from "../userdir.ts";
import { setSandboxRunner } from "../sandbox/runner.ts";
import { sweepStaleSandboxTmp } from "../modules/sandbox/windows-acl/windows-acl.ts";
import { buildContext } from "../core/context.ts";
import { loadModules, loadExternalModules } from "../core/module.ts";
import { SSE_EVENTS } from "../core/events.ts";
import { json, toServerRequest } from "../core/http.ts";
import type { SessionHost } from "../core/host.ts";
import {
  applyProvider,
  createRuntime,
  currentState,
  metaSnapshot,
  rescanSkillsFor,
  subagentServiceFor,
  viewRt,
  type SessionShell,
} from "./session-runtime.ts";
import {
  bindWorkspace,
  doCompact,
  newSessionForView,
  persistSession,
  sessionsPayload,
  startTurn,
  sweepEmptySessions,
  switchToBlankRuntime,
  switchView,
} from "./session-lifecycle.ts";
import { BUILTIN_MODULES } from "../modules.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- 用户数据目录 ~/.ZQQ-harness ----
const USER_DIR = ensureUserDir(process.cwd());
const WORKSPACES_FILE = workspacesFilePath(USER_DIR);
const appConfig = loadConfig(process.cwd());

// ---- 内核上下文 + 宿主接缝 + 组合清单装配 ----
const ctx = buildContext(
  {
    userDir: USER_DIR,
    globalSkillsDir: join(USER_DIR, "skills"),
    globalMcpFile: join(USER_DIR, "mcp.json"),
    workspacesFile: WORKSPACES_FILE,
    sessionsDir: join(USER_DIR, "sessions"),
  },
  appConfig,
);

/** 壳侧共享单例袋（session-runtime/-lifecycle 的显式首参）；providerFile 等就绪后赋值。 */
let shell: SessionShell;
const sessionHost: SessionHost = {
  runtimes: () => shell.runtimes,
  viewId: () => shell.viewId,
  viewRt: () => viewRt(shell),
  busyIds: () => [...shell.runtimes.values()].filter((rt) => rt.busy).map((rt) => rt.id),
  switchView: (id) => switchView(shell, id),
  newSessionForView: (ws, kind) => newSessionForView(shell, ws, kind),
  switchToBlankRuntime: () => switchToBlankRuntime(shell),
  bindWorkspace: (rt, p) => bindWorkspace(shell, rt, p),
  startTurn: (rt, text, images) => startTurn(shell, rt, text, images), // docs/12 R2：修复适配器丢参——两参箭头曾把 /api/chat 的 images 静默丢弃（模型从未收到图）
  compact: (rt, opts) => doCompact(shell, rt, opts),
  persistSession: (rt) => persistSession(shell, rt),
  sweepEmptySessions: () => sweepEmptySessions(shell),
  rescanSkills: (rt) => rescanSkillsFor(shell, rt),
  applyProvider: (rt, cfg) => applyProvider(shell, rt, cfg),
  currentState: (rt) => currentState(shell, rt),
  sessionsPayload: () => sessionsPayload(shell),
  sessions: () => shell.sessions,
  providerFile: () => shell.providerFile,
  recentWorkspaces: () => shell.recentWorkspaces,
  setRecentWorkspaces: (list) => {
    shell.recentWorkspaces = list;
  },
  broadcast: (event, data) => broadcast(event, data),
};
ctx.sessionHost = sessionHost;

// ---- 组合清单装配（P8：harness.json 模块启停 + 外部模块目录 ~/.ZQQ-harness/modules）----
const disabled = new Set(HARNESS_CONFIG.disabledModules);
for (const name of HARNESS_CONFIG.disabledModules) {
  // 打字错误提示（不存在于内置清单的禁用项也可能是想禁的外部模块，仅提醒不阻断）
  if (!BUILTIN_MODULES.some((m) => m.name === name)) {
    console.error(`[harness.json] 禁用的模块 "${name}" 不在内置清单中（外部模块禁用请在 modules/ 放置同名文件后确认）`);
  }
}
const enabledBuiltins = BUILTIN_MODULES.filter((m) => !disabled.has(m.name));
const loadedExternals = await loadExternalModules(
  join(USER_DIR, "modules"),
  enabledBuiltins.map((m) => m.name),
);
const externals = loadedExternals.filter((m) => !disabled.has(m.name));
for (const m of loadedExternals) if (disabled.has(m.name)) console.error(`[harness.json] 外部模块 ${m.name} 已被禁用，跳过`);
await loadModules(ctx, [...enabledBuiltins, ...externals]);
const providerFile = ensureProvidersFile(USER_DIR, process.cwd(), ctx.providerFormats);
const sessions = new SessionStore(USER_DIR);
shell = {
  ctx,
  config: appConfig,
  sessions,
  providerFile,
  runtimes: new Map(),
  viewId: "",
  viewSeq: 0,
  recentWorkspaces: loadRecentWorkspaces(WORKSPACES_FILE),
  workspacesFile: WORKSPACES_FILE,
  userDir: USER_DIR,
  globalMcpFile: join(USER_DIR, "mcp.json"),
  sandboxTmpRoot: join(USER_DIR, "tmp"),
  broadcast,
};
// P8 预留 seam：子代理服务工厂挂上 ctx（同 sessionHost 模式；服务按会话取 provider/工作区）
ctx.subagent = (rt) => subagentServiceFor(shell, rt);

// ---- 沙箱后端选型（§4.9，只发生一次）：注册表里第一个可用的后端注入接缝； ----
// 全都不可用（非 Windows / koffi 缺失）时保持 runner.ts 的 fail-closed 缺省，受约束模式一律拒
const sandboxBackend = ctx.sandboxBackends.all().find((b) => b.available());
if (sandboxBackend) {
  sweepStaleSandboxTmp(shell.sandboxTmpRoot);
  setSandboxRunner(sandboxBackend.create());
}

// ---- SSE ----
const sseClients = new Set<ServerResponse>();

function send(res: ServerResponse, event: string, data: unknown): void {
  // 已断开/销毁的连接 write 会同步抛错：剔除客户端并继续，绝不让广播炸掉调用方
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}
function broadcast(event: string, data: unknown): void {
  for (const res of [...sseClients]) send(res, event, data);
}

function sseHandler(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");
  sseClients.add(res);
  // 初始快照：当前查看会话的历史 + 会话列表 + 状态（页面刷新后恢复显示；思考流不入历史，刷新后不重现）
  const rt = viewRt(shell);
  send(res, SSE_EVENTS.init, { sessionId: rt.id, messages: rt.agent.messages, state: currentState(shell, rt) });
  send(res, SSE_EVENTS.sessions, sessionsPayload(shell));
  const ping = setInterval(() => res.write(":ping\n\n"), 20_000);
  res.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// ---- HTTP 分发：静态页 → SSE → meta → 路由查表（web-* 模块注册）→ 404 ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      // 无构建单文件前端：禁止缓存，保证前端修复刷新即生效（否则浏览器跑旧 JS 排查无门）
      const html = await readFile(join(HERE, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      sseHandler(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      json(res, 200, metaSnapshot(shell));
      return;
    }
    const route = ctx.routes.get(url.pathname);
    if (route && route.method === req.method) {
      await route.handler(toServerRequest(req, res, url));
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    // 双重故障防护：广播/响应中途出错时 headers 可能已发出，此时只能断流不能再写头
    try {
      if (res.headersSent) res.end();
      else json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    } catch {
      /* 连接已死，放弃 */
    }
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用（可能是上一个还没退干净的服务进程）。`);
    console.error(`  排查：netstat -ano | findstr :${PORT}  找到 PID，然后 taskkill /F /PID <PID>`);
    console.error(`  或换个端口启动（PowerShell）：$env:PORT=8788; npm run web`);
    process.exit(1);
  }
  throw err;
});

// ---- 启动：创建初始引导会话（未选择工作区，禁止对话） ----
const bootRt = await createRuntime(shell, { workspaceRoot: null });
shell.viewId = bootRt.id;
sessions.currentId = shell.viewId;
sweepEmptySessions(shell); // 清理历史积累的空占位档（无消息、非当前视图的都算）

process.on("exit", () => {
  for (const rt of shell.runtimes.values()) rt.mcp.stop();
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  const v = viewRt(shell);
  const mcp = v.mcp.status();
  console.log(`ZQQ-harness Web UI 已启动：${url}`);
  console.log(`  模型：${shell.providerFile.data.providers.find((p) => p.id === v.providerId)?.model ?? "?"}  工作区：${v.workspace ? v.workspace.root : "未选择（启动后在界面选择）"}`);
  console.log(`  MCP：${mcp.length > 0 ? mcp.join("、") : "未配置"}`);
  console.log(`  技能：${v.skills.length > 0 ? v.skills.map((s) => s.name).join("、") : "未配置"}`);
  const notes: string[] = [];
  if (HARNESS_CONFIG.disabledModules.length > 0) notes.push(`禁用 ${HARNESS_CONFIG.disabledModules.join("、")}`);
  if (externals.length > 0) notes.push(`外部 ${externals.map((m) => m.name).join("、")}`);
  if (notes.length > 0) console.log(`  模块：${notes.join("；")}`);
  try {
    if (!process.env.ZQQ_NO_BROWSER) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); // 自动开浏览器（失败不影响使用；ZQQ_NO_BROWSER=1 跳过，供脚本/测试环境）
  } catch {
    /* ignore */
  }
});
