/**
 * Web UI 瘦壳（模块化架构重构 §4.10/P6）：只负责 bootstrap 装配、静态页、SSE 流、
 * /api/meta 与路由查表分发——全部 /api/* 端点由 modules/web-* 注册进 ctx.routes。
 * 会话装配在 web/session-runtime.ts，生命周期在 web/session-lifecycle.ts，
 * 共享单例收进 SessionShell；web-* 模块经 ctx.sessionHost（core/host.ts）触达会话机器。
 * 浏览器 ← SSE 推流（全部带 sessionId）；浏览器 → POST（消息/批准/设置/工作区）。
 */
import { createServer, type ServerResponse } from "node:http";
import { fstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { THRESHOLDS, initConfig, loadConfig, HARNESS_CONFIG } from "../config.ts";
import { ensureProvidersFile } from "../providers/store.ts";
import { SessionStore, sweepStaleSpill } from "./sessions.ts";
import { AttachmentStore } from "./attachments.ts";
import { loadRecentWorkspaces, workspacesFilePath } from "./workspaces.ts";
import { ensureUserDir, USER_DIR_LAYOUT as UDL } from "../userdir.ts";
import { setSandboxRunner } from "../sandbox/runner.ts";
import { sweepStaleSandboxTmp } from "../modules/sandbox/windows-acl/windows-acl.ts";
import { buildContext } from "../core/context.ts";
import { loadModules, loadExternalModules } from "../core/module.ts";
import { SSE_EVENTS } from "../core/events.ts";
import { json, toServerRequest, SSE_PING_MS } from "../core/http.ts";
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

// ---- 用户数据目录 ~/.ZQQ-harness；initConfig() 显式装载 harness.json 生效值（docs/23 D2）----
const USER_DIR = ensureUserDir(process.cwd());
const WORKSPACES_FILE = workspacesFilePath(USER_DIR);
initConfig(); // 须先于一切生效常量消费（loadConfig/HARNESS_CONFIG/清扫阈值；导入期为纯缺省）
const appConfig = loadConfig(process.cwd());

// ---- 内核上下文 + 宿主接缝 + 组合清单装配 ----
const ctx = buildContext(
  {
    userDir: USER_DIR,
    globalSkillsDir: join(USER_DIR, UDL.skills),
    globalMcpFile: join(USER_DIR, UDL.mcpFile),
    workspacesFile: WORKSPACES_FILE,
    sessionsDir: join(USER_DIR, UDL.sessions),
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
  join(USER_DIR, UDL.modules),
  enabledBuiltins.map((m) => m.name),
);
const externals = loadedExternals.filter((m) => !disabled.has(m.name));
for (const m of loadedExternals) if (disabled.has(m.name)) console.error(`[harness.json] 外部模块 ${m.name} 已被禁用，跳过`);
await loadModules(ctx, [...enabledBuiltins, ...externals]);
const providerFile = ensureProvidersFile(USER_DIR, process.cwd(), ctx.providerFormats);
const sessions = new SessionStore(USER_DIR);
const attachments = new AttachmentStore(USER_DIR); // docs/33：图片附件内容寻址库
shell = {
  ctx,
  sessions,
  attachments,
  providerFile,
  runtimes: new Map(),
  viewId: "",
  viewSeq: 0,
  recentWorkspaces: loadRecentWorkspaces(WORKSPACES_FILE),
  workspacesFile: WORKSPACES_FILE,
  userDir: USER_DIR,
  globalMcpFile: join(USER_DIR, UDL.mcpFile),
  sandboxTmpRoot: join(USER_DIR, UDL.tmp),
  broadcast,
};
// P8 预留 seam：子代理服务工厂挂上 ctx（同 sessionHost 模式；服务按会话取 provider/工作区）
ctx.subagent = (rt) => subagentServiceFor(shell, rt);

// ---- 沙箱后端选型（§4.9，只发生一次）：第一个可用后端注入接缝；全不可用（非 Windows/koffi 缺失）保持 fail-closed 缺省 ----
const sandboxBackend = ctx.sandboxBackends.all().find((b) => b.available());
if (sandboxBackend) {
  sweepStaleSandboxTmp(shell.sandboxTmpRoot, THRESHOLDS.sandboxTmpMaxAgeHours * 3600_000); // 生效值传参（docs/22 §4.2）
  setSandboxRunner(sandboxBackend.create());
}
sweepStaleSpill(sessions.spillRoot); // 启动清扫超龄 spill（docs/22 §4.2 spillMaxAgeHours；与沙箱 tmp 同策略）

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
  if (err.code === "EADDRINUSE") { // PORT=0 随机端口不会撞，显式端口才会
    console.error(`端口 ${PORT} 已被占用（可能是上一个还没退干净的服务进程）。\n  排查：netstat -ano | findstr :${PORT} 找到 PID，然后 taskkill /F /PID <PID>\n  或换个端口启动（PowerShell）：$env:PORT=8788; npm run web`);
    process.exit(1);
  }
  // EACCES：默认端口被 WinNAT 排除段圈住（Hyper-V 动态保留可漂移；netsh int ipv4 show excludedportrange protocol=tcp 可查）——未显式指定 PORT 才回退随机端口（显式 PORT 静默换口会拿到意外地址，照旧抛）
  if (err.code === "EACCES" && process.env.PORT === undefined) {
    console.warn(`端口 ${PORT} 被系统保留无法绑定（WinNAT 排除段）——已自动改用随机端口，实际地址见下方输出`);
    return void server.listen(0, process.env.ZQQ_HOST ?? "127.0.0.1");
  }
  throw err;
});

// ---- 启动：创建初始引导会话（未选择工作区，禁止对话） ----
const bootRt = await createRuntime(shell, { workspaceRoot: null });
shell.viewId = bootRt.id;
sessions.currentId = shell.viewId;
sweepEmptySessions(shell); // 清理历史积累的空占位档（无消息、非当前视图的都算）

process.on("exit", () => {
  for (const rt of shell.runtimes.values()) rt.mcp.stop(); // 幂等（stopped 闸）：exit 前统一停 MCP 子进程
});

// ---- DT0 服务端就绪化（docs/25 §5，桌面壳契约；浏览器模式同步受益） ----
let shuttingDown = false;
/** 优雅停机（DT0-3）：停接新连接 → 落盘各会话（每轮本已自动落盘，最坏丢在飞轮）→ 经 exit 钩子停 MCP。
 *  触发源：SIGINT/SIGTERM 与 stdin EOF（spawn 模式的父进程死亡感知——父进程关闭管道即触发）。 */
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  for (const rt of shell.runtimes.values()) { try { persistSession(shell, rt); } catch { /* 落盘失败不阻断退出 */ } }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown); // 终端 Ctrl+C / 进程树结束
// stdin EOF = 父进程死亡感知（桌面壳 spawn 的 stdio 管道关闭即触发）——**仅当 stdin 是管道**：
// TTY（交互终端，Ctrl+C 走 SIGINT）与 NUL/文件（`< NUL` 后台/nohup 场景）不装此钩子，
// 否则后台启动会因管道外的 EOF 即刻退出（实测：stdio pipe=fstat S_IFIFO，NUL=S_IFCHR，TTY=isTTY）。
if (!process.stdin.isTTY && (fstatSync(0).mode & 0o170000) === 0o10000 /* S_IFIFO */) {
  process.stdin.resume(); // 流动化后 EOF 才发 end（stdin 不承载任何输入，纯死亡感知）
  process.stdin.on("end", shutdown); // 桌面壳关窗/父 shell 关闭管道 → 本进程即刻自退
}

// ---- 监听（DT0-1：默认只听 127.0.0.1，局域网不可达；ZQQ_HOST 显式覆盖回 0.0.0.0 自担风险） ----
server.listen(PORT, process.env.ZQQ_HOST ?? "127.0.0.1", () => {
  const addr = server.address(); // DT0-2：PORT=0 时为内核分配的随机端口
  const actual = typeof addr === "object" && addr ? addr.port : PORT;
  const url = `http://localhost:${actual}`;
  const v = viewRt(shell);
  const mcp = v.mcp.status();
  console.log(`ZQQ-READY ${actual}`); // DT0-2：机器可读握手行（desktop 壳逐行解析取端口；浏览器模式打印无害）
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
