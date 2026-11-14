/**
 * web.providers 模块测试（docs/10 R3）：/api/providers/save 的 vision 透传与
 * /api/providers/vision-provider 路由（设置/清空/坏 id/未勾视觉）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../core/context.ts";
import { loadConfig } from "../../config.ts";
import { webProviders } from "./index.ts";
import type { ServerRequest } from "../../core/http.ts";
import type { SessionHost } from "../../core/host.ts";
import type { ProviderFile } from "../../providers/store.ts";

function makeSetup() {
  const dir = mkdtempSync(join(tmpdir(), "zqq-webprov-"));
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
  ctx.providerFormats.register({
    format: "openai",
    label: "OpenAI 兼容（测试桩）",
    defaultEffort: () => "high",
    create: () => {
      throw new Error("测试不调 chat");
    },
  });
  const host = {
    viewRt: () => ({ id: "n1", providerId: "vlm", busy: false }),
    runtimes: () => new Map(),
    applyProvider: () => {},
    persistSession: () => {},
    broadcast: () => {},
    currentState: () => ({}),
    providerFile: () => pfRef.pf!,
  } as unknown as SessionHost;
  ctx.sessionHost = host;
  webProviders.setup(ctx);
  // 注入一个带数据的 ProviderFile（保存走 saveProviderFile 落盘验证）
  const pfRef: { pf?: ProviderFile } = {};
  const pf: ProviderFile = {
    path: join(dir, "providers.json"),
    data: {
      active: "vlm",
      providers: [
        { id: "vlm", name: "视觉模型", format: "openai", baseUrl: "http://x", apiKey: "k", model: "m", effort: "high", contextLength: 32_000, maxTokens: null },
        { id: "txt", name: "纯文本", format: "openai", baseUrl: "http://y", apiKey: "k", model: "t", effort: "high", contextLength: 64_000, maxTokens: null },
      ],
    },
  };
  pfRef.pf = pf;
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
  return { dir, ctx, pf, call };
}

test("save：vision 勾选透传（true 才带字段）；vision-provider 路由设置/校验/清空并落盘", async () => {
  const { dir, pf, call } = makeSetup();
  try {
    // save：勾视觉 → cfg.vision=true；不勾 → 字段不带
    const r1 = await call("/api/providers/save", {
      provider: { id: "vlm", name: "视觉模型", format: "openai", baseUrl: "http://x", apiKey: "k", model: "m", effort: "high", contextLength: 32000, maxTokens: null, vision: true },
    });
    assert.equal(r1.status, 200);
    assert.equal(pf.data.providers.find((p) => p.id === "vlm")!.vision, true);
    const r2 = await call("/api/providers/save", {
      provider: { id: "txt", name: "纯文本", format: "openai", baseUrl: "http://y", apiKey: "k", model: "t", effort: "high", contextLength: 64000, maxTokens: null, vision: false },
    });
    assert.equal(r2.status, 200);
    assert.equal("vision" in pf.data.providers.find((p) => p.id === "txt")!, false, "false 不写字段（空不写惯例）");

    // vision-provider：坏 id 404；未勾视觉 400；合法设置 ok 且落盘；空清空
    assert.equal((await call("/api/providers/vision-provider", { id: "nope" })).status, 404);
    const badVision = await call("/api/providers/vision-provider", { id: "txt" });
    assert.equal(badVision.status, 400, "未勾视觉能力的提供方不能当视觉模型");
    const okSet = await call("/api/providers/vision-provider", { id: "vlm" });
    assert.equal(okSet.status, 200);
    assert.equal(pf.data.visionProvider, "vlm");
    assert.equal(JSON.parse(readFileSync(pf.path, "utf8")).visionProvider, "vlm", "落盘持久化");
    const okClear = await call("/api/providers/vision-provider", { id: null });
    assert.equal(okClear.status, 200);
    assert.equal(pf.data.visionProvider, undefined, "清空");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
