/**
 * web.desktop 模块（docs/25 DT3-②/③）：/api/desktop（读）与 /api/desktop/save（写）维护
 * ~/.ZQQ-harness/desktop.json——
 * 桌面壳偏好（开机自启 autoStart / 托盘常驻 tray）的唯一存储，独立于 harness.json
 * （不污染阈值 schema，settings 表单不硬编码阈值键的哨兵不受影响）。
 * 读 = lenient（文件缺失/损坏/字段缺省 → 全 false 缺省，桌面壳在文件缺席时行为 = 关）；
 * 写 = 类型严格（已知键必须 boolean，任一非法整体 400 拒绝不落盘）→ 原子写整文件
 * （两键全量写出，未知历史键清除——文件由本模块独占定义）。
 * 桌面壳侧（desktop/main.mjs）启动时读 + fs.watch 活应用（§8-1：壳只读这一个业务文件）。
 * 浏览器模式下端点照常可用（双入口零漂移；设置界面仅 Electron 渲染进程展示该区块）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "../../core/file-tools.ts";
import { USER_DIR_LAYOUT } from "../../userdir.ts";
import type { HarnessModule } from "../../core/module.ts";

/** 桌面偏好键清单（单一出处：模块独占定义 desktop.json 的形状）。 */
const DESKTOP_KEYS = ["autoStart", "tray"] as const;
type DesktopKey = (typeof DESKTOP_KEYS)[number];

/** lenient 读取：文件缺失/损坏/字段非布尔 → 对应键取 false。 */
function readPrefs(file: string): Record<DesktopKey, boolean> {
  const out: Record<DesktopKey, boolean> = { autoStart: false, tray: false };
  if (!existsSync(file)) return out;
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const k of DESKTOP_KEYS) if (typeof d[k] === "boolean") out[k] = d[k];
  } catch { /* 损坏：全缺省（与 harness 读侧同款宽宥） */ }
  return out;
}

export const webDesktop: HarnessModule = {
  name: "web.desktop",
  setup(ctx) {
    const file = () => join(ctx.paths.userDir, USER_DIR_LAYOUT.desktopFile);

    ctx.routes.register({
      method: "GET",
      path: "/api/desktop",
      handler(r) {
        r.json(200, readPrefs(file()));
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/desktop/save", // 路由表以 path 为键（GET/POST 不共用路径）——沿 /api/settings/harness/save 先例
      async handler(r) {
        const body = (await r.body()) as Record<string, unknown>;
        // 类型严格（fail-closed）：已知键给了就必须是 boolean；未知键忽略（不扩形状）
        for (const k of DESKTOP_KEYS) {
          if (k in body && typeof body[k] !== "boolean") {
            r.json(400, { error: `"${k}" 应为布尔值` });
            return;
          }
        }
        const cur = readPrefs(file());
        const next = { ...cur };
        for (const k of DESKTOP_KEYS) if (k in body) next[k] = body[k] as boolean;
        writeTextAtomic(file(), JSON.stringify(next, null, 2) + "\n");
        r.json(200, next);
      },
    });
  },
};
