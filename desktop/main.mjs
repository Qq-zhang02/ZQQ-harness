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
import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, Menu, nativeImage, powerMonitor, Tray } from "electron";

const APP_ROOT = join(import.meta.dirname, ".."); // desktop/ 的上级 = 项目根（src/、node_modules/ 所在）
const READY_PREFIX = "ZQQ-READY ";
const BOOT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
// DT3-②（docs/25 §6/§8-1）：桌面壳偏好文件——壳对业务数据目录的**唯一例外**（只读这一个；
// 由服务端 web.desktop 模块维护〔端点经页面调用，壳不直接访问〕，路径不得 import src/** 故本地拼写）。
const DESKTOP_JSON = join(app.getPath("home"), ".ZQQ-harness", "desktop.json");
/** 托盘图标（DT3-③）：32×32 PNG 内嵌 base64（圆角蓝底白 Z）——desktop/ ≤2 文件铁律，不落第二个文件。 */
const TRAY_ICON_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABc0lEQVR42u2XvUsDQRDFf3sGE9AgKIqIRKsQsLJQEBNQxMZGxN4q2FpEwSZ+FVqqvf+DYiVIAipaiVgqVomooDFg/OAiZ85iPSIxIRHjXpQcHMzsDby3b+Zmd8DmRxT64Gr0mOUG05NxUZSABTy8Hiv7bnenOr4QEbngvwGcj4hFQlMNbqlrKa1VRBGq3H1uKmxXwPGd4I0xaKkrLTa4BbdPxeNsV+BvpSC4mX+9zwOzARAfXeUgBnfPihTwNUOoPwt+egOrh2CaCgi0uSE8ALU10r+4h+U9MDIKaqDBBQtD4HZK/yoFi1HQDQVF6HRAeBBa66WfeIG5CKTSCv4CTcCMH7xN0n98hflI6UX3YwKTPdDbLu20AUtRuHxQ1AfGu2DEK+23DKzsw3lCUSMKdMJEt7RNYO0ITq4VNqJRX/b2IoCQX74Fz41j2D6rngVlTMH0zj9VoEpAswYFa2hQeSHVk3FROSlQqcLnyaiyZkM7puN3TQV15+x2jzoAAAAASUVORK5CYII=";

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
/** @type {import("electron").BrowserWindow | null} */
let win = null;
/** @type {import("electron").Tray | null} DT3-③：非 null = 托盘常驻开启（关窗=隐藏） */
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit(); // 已有实例：锁被占用 → 退出（second-instance 在首实例里唤回窗口）
} else {
  app.on("second-instance", () => {
    // 真机反馈修复（2026-11-16）：托盘模式下窗口是 hidden 不是 minimized——旧代码只
    // restore+focus，隐藏窗口 focus 不可见 → 用户「双击没反应」。统一走 showMainWindow
    // （restore+show+focus），隐藏/最小化/后台一律唤回前台。
    if (win) showMainWindow();
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
  // 服务日志逐行转发（dev 下直接可见——docs/25 §10 主信息源）。打包版从图标启动时本进程
  // 无控制台（GUI 子系统），process.stdout 是无效句柄——写失败只丢转发，绝不能炸主进程。
  const fwd = (c) => {
    try {
      process.stdout.write("[svc] " + String(c));
    } catch { /* 无控制台：静默丢弃（加 --enable-logging 可见） */ }
  };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", fwd);

  const port = await waitForReady(child);
  if (!port) {
    if (!quitting) {
      dialog.showErrorBox("ZQQ-harness 启动失败", `服务进程 ${BOOT_TIMEOUT_MS / 1000}s 内未就绪（或已退出）。\n从终端运行 npm run desktop 可查看服务日志。`);
    }
    app.quit();
    return;
  }
  openWindow(`http://127.0.0.1:${port}`);
  applyDesktopPrefs(); // DT3-②/③：服务已就绪（userDir 已建）→ 读 desktop.json 应用自启/托盘
  watchDesktopJson(); // DT3-③：此后 web 端保存偏好即时生效（fs.watch 去抖重读）
  // DT3-④（默认开）：系统休眠唤醒后 SSE 连接已静默断开——整页 reload 走 init 快照恢复
  // （前端本身有刷新恢复能力，这是兜底；docs/25 §9 风险行「系统休眠后 SSE 静默断开」）。
  powerMonitor.on("resume", () => {
    if (win && !win.isDestroyed()) win.webContents.reload();
  });

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

/** DT3-②/③：读 desktop.json 并应用（开机自启 + 托盘）。读侧 lenient——缺失/损坏=全关缺省。 */
function applyDesktopPrefs() {
  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(DESKTOP_JSON, "utf8"));
  } catch { /* 文件缺失/损坏：保持缺省（web.desktop 读侧同款宽宥） */ }
  try {
    if (prefs.autoStart === true) {
      // 仅打包版注册：dev 的 electron.exe 进注册表会污染系统自启项；显式 false 同时清理旧注册
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
      else console.log("[shell] 开机自启=开（dev 模式不注册，打包版生效）");
    } else if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: false });
    }
  } catch (e) {
    console.log(`[shell] 自启设置应用失败：${e instanceof Error ? e.message : String(e)}`);
  }
  setTray(prefs.tray === true);
}

/** desktop.json 活应用（DT3-③）：web 端保存（原子写=rename 替换）触发目录事件 → 去抖重读应用。
 *  目录缺失（服务未建 userDir 的窗口期）只记日志跳过——退化为启动时读一次，不致命。 */
function watchDesktopJson() {
  try {
    let timer = null;
    watch(dirname(DESKTOP_JSON), (_ev, fname) => {
      if (fname !== "desktop.json") return;
      clearTimeout(timer);
      timer = setTimeout(applyDesktopPrefs, 150);
    });
  } catch (e) {
    console.log(`[shell] desktop.json 监听未建立（退化为启动读一次）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** DT3-③ 托盘常驻（默认关——会话运行态常驻内存被放大，docs/25 §1.2-⑤）：开启 = 创建托盘 +
 *  关窗改隐藏（close 事件在 openWindow 里查 tray 标记）；关闭 = 销毁托盘 + 唤回隐藏窗（不留不可见孤儿）。
 *  真机反馈加固（2026-11-16）：①Tray 创建包 try——失败保持 tray=null，关窗走正常退出（隐藏若无托盘
 *  = 隐形死亡陷阱）；②首次隐藏 displayBalloon 提示（Win11 默认把新程序托盘图标收进溢出折叠区 ^，
 *  主托盘区看不见是常态而非故障）；③双击托盘图标也唤回（Windows 惯例）。 */
function setTray(on) {
  if (on && !tray) {
    try {
      tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_URL));
    } catch (e) {
      tray = null;
      console.log(`[shell] 托盘创建失败（本次会话关窗=正常退出）：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    tray.setToolTip("ZQQ-harness（正在运行）");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showMainWindow() },
      { type: "separator" },
      { label: "退出", click: () => stopService() }, // 走优雅停机总闸（stdin-EOF → 落盘 → quit）
    ]));
    tray.on("click", () => showMainWindow()); // 左键单击 = 显示/聚焦
    tray.on("double-click", () => showMainWindow()); // Windows 双击惯例
    console.log("[shell] 托盘常驻=开（关闭按钮将隐藏到托盘；退出经托盘菜单）");
  } else if (!on && tray) {
    tray.destroy();
    tray = null;
    console.log("[shell] 托盘常驻=关");
    if (win && !win.isVisible()) showMainWindow();
  }
}

/** 每会话只提示一次的「已进托盘」气泡（displayBalloon = Windows 通知区气泡；Win11 呈现为 toast）。 */
let trayTipShown = false;
function trayHideNotice() {
  if (trayTipShown || !tray) return;
  trayTipShown = true;
  try {
    tray.displayBalloon({
      title: "ZQQ-harness 仍在运行",
      content: "窗口已隐藏到托盘。注意：Win11 默认把托盘图标收进溢出区（任务栏 ^ 折叠箭头）；双击程序图标或点托盘图标即可恢复窗口，退出请用托盘图标右键菜单。",
      iconType: "info",
    });
  } catch { /* 气泡失败无碍 */ }
}

function showMainWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "ZQQ-harness",
    icon: join(import.meta.dirname, "icon.ico"), // c1-energy 图标（打包版 exe/安装器图标由 builder 同源嵌入；此处覆盖 dev 模式窗口/任务栏默认图标）
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
  win.on("close", (e) => {
    // DT3-③：托盘常驻时关窗=隐藏到托盘（会话后台继续）；真正退出走托盘菜单的 stopService 总闸
    if (tray && !quitting) {
      e.preventDefault();
      win.hide();
      trayHideNotice(); // 真机反馈：Win11 托盘图标默认在溢出区——首次隐藏给一次气泡指路
    }
  });
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
