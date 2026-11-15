/**
 * web.static 模块（docs/26 F1/§3.2-1）：前端 ES 模块 `public/app/*.js` 的静态服务——
 * 「无构建 ≠ 单文件」路线的静态半边（浏览器原生 <script type="module"> 加载、node:test
 * 直接 import 单测）。setup 时 readdirSync 枚举 app 目录，**逐文件精确注册** `/app/<name>`
 * 路由（Registry 是精确匹配无通配）；响应 `text/javascript; charset=utf-8` + `Cache-Control:
 * no-cache`（与 index.html 同款——改完刷新即生效）。
 * 取舍（README 开发节已注明）：新增模块文件需重启服务才注册（改文件内容不需要）；
 * *.test.js 不注册（node:test 专用，不属于浏览器加载面）。
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessModule } from "../../core/module.ts";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public", "app");

/** 枚举 app 目录的可下发模块文件（非测试 .js），resolve 后校验仍在目录内（禁穿越，防御性） */
function listAppModules(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const ent of readdirSync(APP_DIR, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".js") || ent.name.endsWith(".test.js")) continue;
    const file = resolve(APP_DIR, ent.name);
    const rel = relative(APP_DIR, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 1) continue;
    out.push({ name: ent.name, file });
  }
  return out;
}

export const webStatic: HarnessModule = {
  name: "web.static",
  setup(ctx) {
    for (const { name, file } of listAppModules()) {
      ctx.routes.register({
        method: "GET",
        path: `/app/${name}`,
        async handler(r) {
          // 静态 JS 走原生响应（内容类型非 JSON，不经 r.json）；no-cache 与 index.html 一致
          r.res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
          r.res.end(await readFile(file, "utf8"));
        },
      });
    }
  },
};
