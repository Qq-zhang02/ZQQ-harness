import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, ensureProvidersFile, newProviderId, type FormatLookup } from "./store.ts";
import { anthropicFormatDef } from "../modules/providers/anthropic/index.ts";
import { openaiFormatDef } from "../modules/providers/openai/index.ts";

/** 测试用格式白名单：与 modules.ts 注册的两种格式一致（create 走真实 def）。 */
const registeredFormats: FormatLookup = {
  get: (f) => (openaiFormatDef.format === f ? openaiFormatDef : anthropicFormatDef.format === f ? anthropicFormatDef : undefined),
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "zqq-prov-"));
}

function withEnv(key: string | undefined, fn: () => void): void {
  const prev = process.env.DEEPSEEK_API_KEY;
  if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = key;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prev;
  }
}

test("迁移：无 providers.json 时从 .credentials.yaml 生成并填好 DeepSeek", () => {
  withEnv(undefined, () => {
    const userDir = tempDir();
    const cwd = tempDir();
    try {
      writeFileSync(join(userDir, ".credentials.yaml"), "DEEPSEEK_API_KEY: sk-migrated\n", "utf8");
      const file = ensureProvidersFile(userDir, cwd, registeredFormats);
      assert.equal(file.data.active, "deepseek");
      assert.equal(file.data.providers.length, 1);
      const p = file.data.providers[0];
      assert.equal(p.id, "deepseek");
      assert.equal(p.name, "DeepSeek");
      assert.equal(p.format, "openai");
      assert.equal(p.baseUrl, "https://api.deepseek.com");
      assert.equal(p.model, "deepseek-flash");
      assert.equal(p.apiKey, "sk-migrated");
      assert.ok(existsSync(file.path)); // 已落盘
    } finally {
      rmSync(userDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("已有 providers.json 原样加载；损坏时重新生成", () => {
  withEnv(undefined, () => {
    const userDir = tempDir();
    const cwd = tempDir(); // 此前两处内联 tempDir() 从不清理——每跑一次漏两个 zqq-prov-*
    try {
      const file = join(userDir, "providers.json");
      writeFileSync(
        file,
        JSON.stringify({
          active: "my-llm",
          providers: [{ id: "my-llm", name: "My LLM", format: "anthropic", baseUrl: "http://x", apiKey: "k", model: "m1", contextLength: 200000, maxTokens: null }],
        }),
        "utf8",
      );
      const loaded = ensureProvidersFile(userDir, cwd, registeredFormats);
      assert.equal(loaded.data.providers[0].name, "My LLM");
      assert.equal(loaded.data.active, "my-llm");

      writeFileSync(file, "{broken", "utf8");
      const reseeded = ensureProvidersFile(userDir, cwd, registeredFormats);
      assert.equal(reseeded.data.providers[0].id, "deepseek");
    } finally {
      rmSync(userDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("createProvider：按 format 查注册表构建对应实例，未注册格式抛错", () => {
  const base = { apiKey: "k", baseUrl: "http://x", model: "m", effort: "default" as const, contextLength: 1000, maxTokens: null };
  const openai = createProvider({ ...base, id: "a", name: "a", format: "openai" }, registeredFormats);
  const anthropic = createProvider({ ...base, id: "b", name: "b", format: "anthropic" }, registeredFormats);
  assert.equal(openai.name, "openai");
  assert.equal(anthropic.name, "anthropic");
  assert.throws(() => createProvider({ ...base, id: "c", name: "c", format: "nope" }, registeredFormats), /未注册的接口格式/);
});

test("newProviderId：slug 化，重复时加随机后缀", () => {
  assert.equal(newProviderId("DeepSeek 官方", []), "deepseek"); // 空格/中文清洗
  const id = newProviderId("My LLM!", []);
  assert.equal(id, "my-llm");
  const dup = newProviderId("My LLM!", ["my-llm"]);
  assert.ok(dup.startsWith("my-llm-") && dup !== "my-llm");
});
