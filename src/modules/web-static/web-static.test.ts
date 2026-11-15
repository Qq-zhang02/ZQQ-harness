/**
 * web.static 模块测试（docs/26 F1）：/app/<name> 精确注册与内容下发——
 * ① 每个非测试 .js 模块各有一条 GET 路由，内容与磁盘文件逐字节一致、Content-Type 为
 * text/javascript + no-cache（改完刷新即生效）；② *.test.js 不注册（node:test 专用，
 * 不属于浏览器加载面）；③ 未注册名（含不存在/穿越形态）查表为空。
 * 被测目录 = 真实 public/app（模块相对定位，无需注入；repo 内文件即测试夹具）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { buildContext } from "../../core/context.ts";
import { loadConfig } from "../../config.ts";
import { webStatic } from "./index.ts";
import type { ServerRequest } from "../../core/http.ts";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "zqq-webstatic-"));
  const ctx = buildContext(
    {
      userDir: dir,
      globalSkillsDir: join(dir, "skills"),
      globalMcpFile: join(dir, "mcp.json"),
      workspacesFile: join(dir, "workspaces.json"),
      sessionsDir: join(dir, "sessions"),
    },
    loadConfig(),
  );
  webStatic.setup(ctx);
  return { ctx, dir };
}

/** 模拟一次 GET：捕获 writeHead/end 的状态、头与体 */
async function get(ctx: ReturnType<typeof makeCtx>["ctx"], path: string) {
  const captured: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const r: ServerRequest = {
    req: {} as never,
    res: {
      writeHead(status: number, headers: Record<string, string>) {
        captured.status = status;
        captured.headers = headers;
      },
      end(body?: string) {
        captured.body = body;
      },
    } as never,
    url: new URL("http://localhost" + path),
    body: async () => ({}),
    json: () => {
      throw new Error("静态模块不应走 JSON 应答");
    },
  };
  await ctx.routes.get(path)!.handler(r);
  return captured;
}

test("每个 app 模块精确注册：内容逐字节一致 + text/javascript + no-cache", async () => {
  const s = makeCtx();
  try {
    const route = await get(s.ctx, "/app/replay.js");
    assert.equal(route.status, 200);
    assert.equal(route.headers!["Content-Type"], "text/javascript; charset=utf-8");
    assert.equal(route.headers!["Cache-Control"], "no-cache");
    const replaySrc = readFileSync(new URL("../../web/public/app/replay.js", import.meta.url), "utf8");
    assert.equal(route.body, replaySrc, "下发内容与磁盘文件一致");
    const turns = await get(s.ctx, "/app/turns.js");
    assert.equal(turns.status, 200);
    assert.ok((turns.body ?? "").includes("export function groupTurns"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("*.test.js 不注册：测试文件不属于浏览器加载面；未注册名查表为空", () => {
  const s = makeCtx();
  try {
    assert.equal(s.ctx.routes.get("/app/replay.test.js"), undefined);
    assert.equal(s.ctx.routes.get("/app/nope.js"), undefined);
    assert.equal(s.ctx.routes.get("/app/../config.ts"), undefined, "穿越形态不在精确注册表");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
