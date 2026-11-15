/**
 * web.desktop 模块测试（docs/25 DT3）：desktop.json 的读写语义——
 * ① GET：文件缺失 → 全 false 缺省；已写值 → 原样返回；损坏 JSON → lenient 全缺省；
 * ② POST：布尔合并写 + 原子落盘；非布尔已知键 → 400 整体拒绝不落盘；未知键忽略不扩形状；
 * ③ 两键全量写出（文件形状由模块独占定义，历史杂键被清除）。
 * 被测目录 = 临时目录（buildContext 注入 userDir；desktop/main.mjs 侧的读取/应用属壳，
 * 按 §8-4 壳不进 npm test，归打包后手工冒烟）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../core/context.ts";
import { loadConfig } from "../../config.ts";
import { webDesktop } from "./index.ts";
import type { ServerRequest } from "../../core/http.ts";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "zqq-webdesktop-"));
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
  webDesktop.setup(ctx);
  return { ctx, dir, file: join(dir, "desktop.json") };
}

/** 模拟一次请求：GET → /api/desktop，POST → /api/desktop/save；捕获 json() 的状态与载荷。 */
async function call(ctx: ReturnType<typeof makeCtx>["ctx"], method: "GET" | "POST", body?: unknown) {
  const captured: { status?: number; payload?: unknown } = {};
  const r: ServerRequest = {
    req: {} as never,
    res: {} as never,
    url: new URL(method === "GET" ? "http://localhost/api/desktop" : "http://localhost/api/desktop/save"),
    body: async () => body ?? {},
    json: (status: number, payload: unknown) => {
      captured.status = status;
      captured.payload = payload;
    },
  } as never;
  const route = method === "GET" ? ctx.routes.get("/api/desktop") : ctx.routes.get("/api/desktop/save");
  await route!.handler(r);
  return captured;
}

test("GET：文件缺失 → 全 false 缺省（桌面壳缺席行为 = 全关）", async () => {
  const s = makeCtx();
  try {
    const r = await call(s.ctx, "GET");
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { autoStart: false, tray: false });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("POST：布尔合并 + 原子落盘 + 全量写出（未知历史键清除）；GET 回读一致", async () => {
  const s = makeCtx();
  try {
    // 预置：文件里带历史杂键 + 损坏外的合法两键
    writeFileSync(s.file, JSON.stringify({ autoStart: true, legacy: "x" }), "utf8");
    let r = await call(s.ctx, "POST", { tray: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { autoStart: true, tray: true }); // 未给的键保留现值
    assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), { autoStart: true, tray: true }); // 杂键被清（形状独占）
    r = await call(s.ctx, "GET");
    assert.deepEqual(r.payload, { autoStart: true, tray: true });
    // 单键更新：另一键不动
    r = await call(s.ctx, "POST", { autoStart: false });
    assert.deepEqual(r.payload, { autoStart: false, tray: true });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("POST：非布尔已知键 → 400 整体拒绝且不落盘；未知键忽略", async () => {
  const s = makeCtx();
  try {
    let r = await call(s.ctx, "POST", { autoStart: "yes" });
    assert.equal(r.status, 400);
    assert.ok(String((r.payload as { error: string }).error).includes("autoStart"));
    r = await call(s.ctx, "GET");
    assert.deepEqual(r.payload, { autoStart: false, tray: false }); // 未落盘
    r = await call(s.ctx, "POST", { whatever: 1 });
    assert.equal(r.status, 200); // 未知键忽略（不扩形状、不报错）
    assert.deepEqual(r.payload, { autoStart: false, tray: false });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("GET：损坏 JSON → lenient 全缺省（与 harness 读侧同款宽宥）", async () => {
  const s = makeCtx();
  try {
    writeFileSync(s.file, "{oops", "utf8");
    const r = await call(s.ctx, "GET");
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { autoStart: false, tray: false });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
