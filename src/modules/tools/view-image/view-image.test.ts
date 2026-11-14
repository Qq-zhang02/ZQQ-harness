/**
 * view_image 工具单元测试（docs/10 R3 + docs/12 R2）：magic bytes 识别、大小上限、
 * 视觉模型未配置指引、配置后经提供方工厂透传多模态请求、usage 上报（breakdown 全
 * other）、失败归一化为错误字符串；docs/12 R2：自身视觉优先（selfVision 接缝）与
 * 无自身视觉时的借用回退。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatParams, ChatResult, LLMProvider, UsageInfo } from "../../../llm/provider.ts";
import type { ProviderConfig } from "../../../providers/store.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { Tool, ToolContext } from "../../../tools/registry.ts";
import { toolViewImage } from "./index.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(8).fill(1)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(8).fill(1)]);
const NOT_IMG = Buffer.from("plain text file definitely not an image");

/** 桩格式工厂：记录收到的 cfg 与 chat 参数，回固定结果。 */
function makeDeps(opts?: { vision?: ProviderConfig | null; selfVision?: ProviderConfig | null; chatImpl?: (p: ChatParams) => Promise<ChatResult> }) {
  const chats: ChatParams[] = [];
  const usages: UsageInfo[] = [];
  const deps = {
    workspace: () => ({ root: process.cwd() }) as ReturnType<SystemToolDeps["workspace"]>,
    selfVision: () => opts?.selfVision ?? null,
    vision: () => opts?.vision ?? null,
    reportAuxUsage: (u: UsageInfo) => usages.push(u),
    ctx: {
      providerFormats: {
        get: () => ({
          format: "openai",
          label: "OpenAI 兼容",
          defaultEffort: () => "high",
          create: (cfg: ProviderConfig): LLMProvider => ({
            name: "stub",
            model: cfg.model,
            chat: (p) => {
              chats.push(p);
              return (
                opts?.chatImpl?.(p) ??
                Promise.resolve({
                  content: "图里是一个红色按钮",
                  reasoning: "",
                  toolCalls: [],
                  usage: { promptTokens: 800, completionTokens: 50 },
                })
              );
            },
          }),
        }),
      },
    },
  } as unknown as SystemToolDeps;
  return { deps, chats, usages };
}

const VISION_CFG: ProviderConfig = {
  id: "vlm", name: "视觉模型", format: "openai", baseUrl: "http://x", apiKey: "k",
  model: "vlm-1", effort: "default", contextLength: 32_000, maxTokens: null, vision: true,
};

const tctx: ToolContext = { workspace: { root: process.cwd() }, requestApproval: async () => "allowed-once" };

test("view_image：PNG/JPEG 识别并透传多模态请求（image base64 + question）+ usage 上报", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-vimg-"));
  try {
    const png = join(dir, "a.png");
    writeFileSync(png, PNG);
    const { deps, chats, usages } = makeDeps({ vision: VISION_CFG });
    let def: { create(d: SystemToolDeps): Tool } | undefined;
    toolViewImage.setup({ tools: { register: (d: unknown) => (def = d as { create(d: SystemToolDeps): Tool }) } } as never);
    const out = await def!.create(deps).execute({ path: png, question: "图里有什么" }, tctx);
    assert.ok(out.startsWith("图里是一个红色按钮"), out);
    assert.ok(out.includes("由视觉模型 视觉模型 分析"), "标注视觉模型名（cfg.name）");
    assert.ok(out.includes("输入 800 / 输出 50"), "用量附在结果尾部");
    assert.equal(chats.length, 1);
    const msgs = chats[0]!.messages;
    assert.equal(msgs[0]!.role, "user");
    assert.equal((msgs[0] as { images?: { mime: string; data: string }[] }).images![0]!.mime, "image/png");
    assert.ok((msgs[0] as { content: string }).content.includes("图里有什么"));
    // usage 守恒：上报且 breakdown 全归 other
    assert.equal(usages.length, 1);
    assert.equal(usages[0]!.breakdown!.other, 800);
    assert.equal(usages[0]!.breakdown!.messages, 0);

    const jpeg = join(dir, "b.jpg");
    writeFileSync(jpeg, JPEG);
    await def!.create(deps).execute({ path: jpeg, question: "?" }, tctx);
    assert.equal(chats.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("view_image：非图片文件 / 参数校验的明确报错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-vimg-"));
  try {
    const notImg = join(dir, "c.txt");
    writeFileSync(notImg, NOT_IMG);
    const { deps } = makeDeps({ vision: VISION_CFG });
    let def: { create(d: SystemToolDeps): Tool } | undefined;
    toolViewImage.setup({ tools: { register: (d: unknown) => (def = d as { create(d: SystemToolDeps): Tool }) } } as never);
    assert.ok((await def!.create(deps).execute({ path: notImg, question: "?" }, tctx)).includes("不支持的图片格式"));
    assert.ok((await def!.create(deps).execute({ path: join(dir, "no.png"), question: "?" }, tctx)).includes("读取失败"));
    assert.ok((await def!.create(deps).execute({ path: notImg }, tctx)).includes("question 不能为空"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("view_image：视觉模型未配置（且无自身视觉）→ 指引文案（不抛错）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-vimg-"));
  try {
    const png = join(dir, "a.png");
    writeFileSync(png, PNG);
    const { deps } = makeDeps({ vision: null });
    let def: { create(d: SystemToolDeps): Tool } | undefined;
    toolViewImage.setup({ tools: { register: (d: unknown) => (def = d as { create(d: SystemToolDeps): Tool }) } } as never);
    const out = await def!.create(deps).execute({ path: png, question: "?" }, tctx);
    assert.ok(out.includes("无法看图"));
    assert.ok(out.includes("提供方管理"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("view_image：自身视觉优先（docs/12 R2）——会话模型有视觉时用它自己读，配置的视觉模型退居后备", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-vimg-"));
  try {
    const png = join(dir, "a.png");
    writeFileSync(png, PNG);
    // selfVision 与 vision 都配置：走 selfVision（结果标注「本会话模型 … 自身视觉」）
    const self: ProviderConfig = { ...VISION_CFG, id: "self", name: "当前会话模型" };
    const { deps, chats } = makeDeps({ vision: VISION_CFG, selfVision: self });
    let def: { create(d: SystemToolDeps): Tool } | undefined;
    toolViewImage.setup({ tools: { register: (d: unknown) => (def = d as { create(d: SystemToolDeps): Tool }) } } as never);
    const out = await def!.create(deps).execute({ path: png, question: "?" }, tctx);
    assert.ok(out.includes("由本会话模型 当前会话模型 自身视觉 分析"), out);
    assert.equal(chats.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("view_image：无自身视觉时照旧借用配置的视觉模型（docs/12 R2 回退路径）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-vimg-"));
  try {
    const png = join(dir, "a.png");
    writeFileSync(png, PNG);
    const { deps, chats } = makeDeps({ vision: VISION_CFG, selfVision: null });
    let def: { create(d: SystemToolDeps): Tool } | undefined;
    toolViewImage.setup({ tools: { register: (d: unknown) => (def = d as { create(d: SystemToolDeps): Tool }) } } as never);
    const out = await def!.create(deps).execute({ path: png, question: "?" }, tctx);
    assert.ok(out.includes("由视觉模型 视觉模型 分析"), out);
    assert.equal(chats.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("view_image：视觉提供方 chat 失败 → 错误字符串回传（含提供方名）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-vimg-"));
  try {
    const png = join(dir, "a.png");
    writeFileSync(png, PNG);
    const { deps } = makeDeps({
      vision: VISION_CFG,
      chatImpl: () => Promise.reject(new Error("HTTP 401")),
    });
    let def: { create(d: SystemToolDeps): Tool } | undefined;
    toolViewImage.setup({ tools: { register: (d: unknown) => (def = d as { create(d: SystemToolDeps): Tool }) } } as never);
    const out = await def!.create(deps).execute({ path: png, question: "?" }, tctx);
    assert.ok(out.startsWith("错误：视觉分析失败"));
    assert.ok(out.includes("HTTP 401"));
    assert.ok(out.includes("视觉模型"), "指引检查视觉提供方配置");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
