/**
 * web.settings 模块测试（docs/24）：GET 下发 schema/生效值/文件存在性；
 * POST 严格校验 fail-closed（400 指名键、不落盘、不动内存配置）→ 原子写纯 JSON →
 * initConfig 热应用（live binding 断言）→ disabledModules 透传。
 * 路径隔离：harness.json 取 ctx.paths.userDir（临时目录），不触真机用户文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../core/context.ts";
import {
  COMPACTION_PRESSURE,
  HARNESS_CONFIG,
  initConfig,
  loadConfig,
  resolveThresholds,
  stripJsonComments,
} from "../../config.ts";
import { webSettings } from "./index.ts";
import type { ServerRequest } from "../../core/http.ts";

function makeSetup() {
  const dir = mkdtempSync(join(tmpdir(), "zqq-webset-"));
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
  webSettings.setup(ctx);
  const call = async (path: string, body: Record<string, unknown>) => {
    const responses: Array<{ status: number; data: unknown }> = [];
    const r: ServerRequest = {
      req: {} as never,
      res: {} as never,
      url: new URL("http://localhost" + path),
      body: async () => body,
      json: (status, data) => responses.push({ status, data }),
    };
    await ctx.routes.get(path)!.handler(r);
    return responses[0]!;
  };
  return { dir, ctx, call, harnessFile: join(dir, "harness.json") };
}

test("GET：schema 35 键七组、effective=缺省（导入态）、fileExists=false；POST 后翻 true", async () => {
  const s = makeSetup();
  try {
    const g = await s.call("/api/settings/harness", {});
    assert.equal(g.status, 200);
    const d = g.data as { config: unknown; effective: Record<string, number>; schema: { entries: unknown[]; groups: unknown[] }; fileExists: boolean };
    assert.equal(d.schema.entries.length, 35);
    assert.equal(d.schema.groups.length, 7);
    assert.equal(d.effective.compactionPressure, resolveThresholds({}).compactionPressure);
    assert.equal(d.fileExists, false, "临时目录无 harness.json");
    assert.deepEqual(d.config, { disabledModules: [], thresholds: {} });

    const p = await s.call("/api/settings/harness/save", { thresholds: { maxToolRounds: 9 } });
    assert.equal(p.status, 200);
    const g2 = await s.call("/api/settings/harness", {});
    assert.equal((g2.data as { fileExists: boolean }).fileExists, true, "保存后文件存在");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} }); // 恢复导入态，不泄漏给同进程其他测试
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("POST：合法保存 → 纯 JSON 落盘 + initConfig 热应用 + disabledModules 透传", async () => {
  const s = makeSetup();
  try {
    // 预置一个 disabledModules（透传验证：POST 只改 thresholds）
    initConfig({ disabledModules: ["demo.x"], thresholds: { compactionPressure: 0.9 } });
    const p = await s.call("/api/settings/harness/save", { thresholds: { compactionPressure: 0.5, subagentMaxConcurrent: 5 } });
    assert.equal(p.status, 200);
    const d = p.data as { config: { disabledModules: string[]; thresholds: Record<string, number> }; effective: Record<string, number> };
    assert.deepEqual(d.config.thresholds, { compactionPressure: 0.5, subagentMaxConcurrent: 5 }, "thresholds 整体替换");
    assert.deepEqual(d.config.disabledModules, ["demo.x"], "disabledModules 原样透传");
    assert.equal(d.effective.subagentMaxConcurrent, 5);
    // 热应用：live binding 立即见新值（initConfig 是唯一出口，POST 内部调用）
    assert.equal(COMPACTION_PRESSURE, 0.5);
    assert.deepEqual(HARNESS_CONFIG, d.config);
    // 落盘：纯 JSON（无需剥注释即可解析）且内容一致
    const text = readFileSync(s.harnessFile, "utf8");
    assert.deepEqual(JSON.parse(text), { disabledModules: ["demo.x"], thresholds: { compactionPressure: 0.5, subagentMaxConcurrent: 5 } });
    assert.equal(text, stripJsonComments(text), "写回应是纯 JSON（无注释语法）");
    assert.ok(!existsSync(s.harnessFile + ".tmp"), "临时文件已随 rename 消失");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("POST：越界/未知键 → 400 指名该键、文件与内存配置均未被破坏（fail-closed）", async () => {
  const s = makeSetup();
  try {
    initConfig({ disabledModules: [], thresholds: { compactionPressure: 0.9 } });
    const bad = await s.call("/api/settings/harness/save", {
      thresholds: { compactionPressure: 0.5, subagentMaxConcurrent: 0 },
    });
    assert.equal(bad.status, 400);
    const d = bad.data as { error: string; errors: Array<{ key: string; message: string }> };
    assert.equal(d.errors.length, 1);
    assert.equal(d.errors[0]!.key, "subagentMaxConcurrent");
    assert.ok(d.error.includes("subagentMaxConcurrent"), "顶层 error 指名非法键");
    // 整体拒绝：合法键 0.5 未被部分采纳，文件未创建，内存仍为 0.9
    assert.equal(existsSync(s.harnessFile), false, "校验失败不落盘");
    assert.equal(COMPACTION_PRESSURE, 0.9);
    const unk = await s.call("/api/settings/harness/save", { thresholds: { nope: 1 } });
    assert.equal(unk.status, 400);
    assert.ok(((unk.data as { errors: Array<{ key: string }> }).errors[0]!.key) === "nope");
    const noBody = await s.call("/api/settings/harness/save", {});
    assert.equal(noBody.status, 400, "缺 thresholds 整体拒绝");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
    rmSync(s.dir, { recursive: true, force: true });
  }
});
