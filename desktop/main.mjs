/**
 * ZQQ-harness 桌面壳（docs/25 §4 方案 A：Electron 薄壳）——只管「起服务进程 + 开窗口 + 管生命周期」。
 * 铁律（docs/25 §8-1）：壳不进业务——不 import src/**、不读写用户业务数据目录、desktop/ ≤2 文件。
 *
 * 进程模型：主进程 spawn **自身 exe**（ELECTRON_RUN_AS_NODE=1 → 纯 Node 运行时，内置 Node ≥22.18
 * 免 flag 跑 .ts；koffi N-API 只在此子进程加载）跑 src/web/server.ts，逐行读 stdout 解析
 * "ZQQ-READY <port>" 握手行（docs/25 DT0-2），再开 BrowserWindow 加载 http://127.0.0.1:<port>
 * （渲染进程 = 现有前端零改动；contextIsolation 默认开、nodeIntegration 默认关）。
 *
 * 生命周期：关窗/退出 → 销毁 stdin 管道 → 服务子进程 stdin-EOF 优雅停机（DT0-3：落盘+停 MCP）
 * → 子进程退出后 app.quit()；5s 未退硬杀兜底。单实例：二次启动聚焦已有窗口后退出。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";

const APP_ROOT = join(import.meta.dirname, ".."); // desktop/ 的上级 = 项目根（src/、node_modules/ 所在）
const READY_PREFIX = "ZQQ-READY ";
const BOOT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
/** @type {import("electron").BrowserWindow | null} */
let win = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit(); // 已有实例：锁被占用 → 退出（second-instance 在首实例里聚焦窗口）
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

async function start() {
  child = spawn(process.execPath, [join(APP_ROOT, "src", "web", "server.ts")], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // 本进程 exe 即完整 Node 运行时（服务子进程语义，非 Electron）
      PORT: "0", // DT0-2：随机端口，消灭端口冲突
      ZQQ_NO_BROWSER: "1", // 桌面版自带窗口，不再弹系统浏览器
      ZQQ_HOST: "127.0.0.1", // DT0-1：本机回环（显式声明，与 server 缺省一致）
    },
    stdio: ["pipe", "pipe", "pipe"], // stdin 管道 = 父死亡感知通道（关窗即优雅停机）
  });
  // 服务日志逐行转发（打包版无控制台也有 stderr 可收集；dev 下直接可见——docs/25 §10 主信息源）
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (c) => process.stdout.write("[svc] " + String(c)));
  }

  const port = await waitForReady(child);
  if (!port) {
    if (!quitting) {
      dialog.showErrorBox("ZQQ-harness 启动失败", `服务进程 ${BOOT_TIMEOUT_MS / 1000}s 内未就绪（或已退出）。\n从终端运行 npm run desktop 可查看服务日志。`);
    }
    app.quit();
    return;
  }
  openWindow(`http://127.0.0.1:${port}`);

  child.on("exit", (code) => {
    if (!quitting) {
      dialog.showErrorBox("ZQQ-harness 服务意外退出", `服务进程退出（code=${code}）。窗口即将关闭，重新启动应用即可。`);
      app.quit();
    }
  });
}

/** 逐行解析服务 stdout，等 DT0-2 握手行；超时/子进程先退返回 0。 */
function waitForReady(proc) {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => done(0), BOOT_TIMEOUT_MS);
    const onData = (c) => {
      buf += String(c);
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith(READY_PREFIX)) {
          const p = Number(line.slice(READY_PREFIX.length).trim());
          done(Number.isInteger(p) && p > 0 ? p : 0);
          return;
        }
      }
    };
    const onExit = () => done(0);
    function done(p) {
      clearTimeout(timer);
      proc.stdout.off("data", onData);
      proc.off("exit", onExit);
      resolve(p);
    }
    proc.stdout.on("data", onData);
    proc.on("exit", onExit);
  });
}

function openWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "ZQQ-harness",
    show: false, // 就绪后再 show：避免白屏期闪现（loadURL 完成回调里显示）
    webPreferences: {
      contextIsolation: true, // 默认值，显式声明（页面 = 纯 Web，无 node 集成）
      nodeIntegration: false, // 同上
    },
  });
  win.setAutoHideMenuBar(true); // 本地工具不需要菜单栏（Alt 可呼出；Ctrl+R 刷新照常可用）
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win && win.show());
  void win.loadURL(url);
  win.on("closed", () => {
    win = null;
  });
}

// 关窗即退（docs/25 §2-2）：Windows 桌面应用惯例，不留后台
app.on("window-all-closed", () => stopService());

// 退出总闸（含任务栏关闭/Cmd+Q 等不经 window-all-closed 的路径）：先优雅停机再退出
app.on("before-quit", (e) => {
  if (child && child.exitCode === null) {
    e.preventDefault(); // 等服务子进程退出后再 quit（下方 stopService 完成）
    stopService();
  }
});

/** 优雅停机：销毁 stdin → 服务 DT0-3 shutdown()（落盘+停 MCP）→ 退出后 app.quit；超时硬杀兜底。 */
function stopService() {
  if (!child || child.exitCode !== null) {
    app.quit();
    return;
  }
  quitting = true;
  const killer = setTimeout(() => child && child.kill(), KILL_GRACE_MS);
  child.once("exit", () => {
    clearTimeout(killer);
    app.quit();
  });
  try {
    child.stdin.destroy();
  } catch {
    child.kill(); // stdin 已坏（极罕见）：直接硬杀
  }
}
