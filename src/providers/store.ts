/**
 * 提供方（LLM Provider）配置存储：~/.ZQQ-harness/providers.json。
 * 首次启动自动从旧位置迁移填好 DeepSeek 提供方：
 *   key：DEEPSEEK_API_KEY 环境变量 → ~/.ZQQ-harness/.credentials.yaml → <cwd>/.credentials.yaml
 *   model/max_tokens/上下文长度：对应 DEEPSEEK_* 环境变量或内置默认值。
 * 之后一律以本文件为准（UI 可增删改切换），环境变量不再实时生效。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EffortSetting, LLMProvider } from "../llm/provider.ts";
import type { ProviderFormatDef } from "../core/types.ts";

export type { EffortSetting };
import { THRESHOLDS, parseCredentialsYaml, EFFORT_OPTIONS } from "../config.ts";

/**
 * 接口格式（模块化架构重构 §4.6）：不再是类型联合——合法值 = ctx.providerFormats
 * 已注册的 format，白名单由注册表承载（providers.* 模块声明）。
 */
export type ProviderFormat = string;

/** 格式白名单/工厂的查询接口（Registry<ProviderFormatDef, "format"> 结构性满足）。 */
export interface FormatLookup {
  get(format: string): ProviderFormatDef | undefined;
}

/** 思考档位合法值：由 config.ts 的 EFFORT_OPTIONS（UI 同源）派生，双清单不再各自漂移。 */
export const EFFORT_VALUES: EffortSetting[] = EFFORT_OPTIONS.map((o) => o.value);

/** 思考档位校验的单一出处：合法原样返回，缺省/野值返回 null（由调用方决定各自回退）。 */
export function normalizeEffort(raw: unknown): EffortSetting | null {
  return (EFFORT_VALUES as string[]).includes(String(raw)) ? (raw as EffortSetting) : null;
}

export interface ProviderConfig {
  id: string;
  /** 显示名（UI 用） */
  name: string;
  /** 接口格式 */
  format: ProviderFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 思考档位；"default"=不发送任何思考参数（适配不支持思考档位的模型，如 mimo） */
  effort: EffortSetting;
  /** 上下文长度（用于余量显示） */
  contextLength: number;
  /** 输出上限；null 用 API 默认 */
  maxTokens: number | null;
  /** 视觉能力声明（docs/10 R3）：true=该模型可直接看图（前端显示上传按钮，图片随消息
   *  发送）；缺省/false=无视觉（图片分析走 view_image 工具 + 视觉提供方）。 */
  vision?: boolean;
}

export interface ProviderStore {
  active: string;
  providers: ProviderConfig[];
  /** 视觉模型提供方 id（docs/10 R3）：view_image 工具用它分析图片（没有视觉能力的会话
   *  的出路）。可选——未设置时 view_image 报错指引在前端配置。 */
  visionProvider?: string;
}

export interface ProviderFile {
  path: string;
  data: ProviderStore;
}

// THRESHOLDS.defaultContextLength 自 P8 起从 config.ts 导入（harness.json 可覆盖），本地重复定义已消灭

/** 首启种子提供方（docs/21 §2.4 常量收敛）：id/名称/格式/接口地址/模型/思考档位集中一处，
 *  首启生成与旧档回填（validateProvider 的 deepseek 特例）共用，防漂移。 */
const DEFAULT_PROVIDER_SEED = {
  id: "deepseek",
  name: "DeepSeek",
  format: "openai",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  effort: "high",
} as const;

function readKeyFromYaml(path: string): string {
  try {
    return parseCredentialsYaml(readFileSync(path, "utf8"))["DEEPSEEK_API_KEY"]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** 从旧配置位置迁移 DeepSeek 连接信息（env > 用户目录 yaml > cwd yaml）。 */
function legacyDeepseek(cwd: string, userDir: string): Pick<ProviderConfig, "apiKey" | "model" | "maxTokens" | "contextLength"> {
  const apiKey =
    process.env.DEEPSEEK_API_KEY?.trim() ||
    readKeyFromYaml(join(userDir, ".credentials.yaml")) ||
    readKeyFromYaml(join(cwd, ".credentials.yaml")) ||
    "";
  const model = process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_PROVIDER_SEED.model;
  const maxEnv = Number(process.env.DEEPSEEK_MAX_TOKENS);
  const ctxEnv = Number(process.env.DEEPSEEK_CONTEXT_LENGTH);
  return {
    apiKey,
    model,
    maxTokens: Number.isFinite(maxEnv) && maxEnv > 0 ? maxEnv : null,
    contextLength: Number.isFinite(ctxEnv) && ctxEnv > 0 ? ctxEnv : THRESHOLDS.defaultContextLength,
  };
}

function validateProvider(p: unknown, formats: FormatLookup): ProviderConfig | null {
  if (!p || typeof p !== "object") return null;
  const v = p as Record<string, unknown>;
  const str = (k: string): string => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  const format = str("format");
  const contextLength = Number(v.contextLength);
  const maxTokens = v.maxTokens === null || v.maxTokens === undefined ? null : Number(v.maxTokens);
  if (!str("id") || !str("name") || !str("baseUrl") || !str("model")) return null;
  // 白名单查注册表：未注册的 format = 校验失败（该提供方被丢弃）
  if (formats.get(format) === undefined) return null;
  if (!(Number.isFinite(contextLength) && contextLength > 0)) return null;
  if (maxTokens !== null && !(Number.isFinite(maxTokens) && maxTokens > 0)) return null;
  // 旧文件缺 effort：deepseek 保持 high，其他（如不支持思考档位的模型）回退 default
  const effort = normalizeEffort(v.effort) ?? (str("id") === DEFAULT_PROVIDER_SEED.id ? DEFAULT_PROVIDER_SEED.effort : "default");
  return {
    id: str("id"),
    name: str("name"),
    format,
    baseUrl: str("baseUrl"),
    apiKey: str("apiKey"),
    model: str("model"),
    effort,
    contextLength,
    maxTokens,
    ...(v.vision === true ? { vision: true } : {}), // docs/10 R3：仅显式 true 才带（空不写）
  };
}

function validateStore(data: unknown, formats: FormatLookup): ProviderStore | null {
  if (!data || typeof data !== "object") return null;
  const v = data as Record<string, unknown>;
  if (!Array.isArray(v.providers)) return null;
  const providers = v.providers
    .map((x) => validateProvider(x, formats))
    .filter((p): p is ProviderConfig => p !== null);
  if (providers.length === 0) return null;
  const active = typeof v.active === "string" && providers.some((p) => p.id === v.active)
    ? v.active
    : providers[0].id;
  // docs/10 R3：visionProvider 必须指向存在的提供方，否则丢弃（工具侧按未配置处理）
  const visionProvider =
    typeof v.visionProvider === "string" && providers.some((p) => p.id === v.visionProvider)
      ? v.visionProvider
      : undefined;
  return { active, providers, ...(visionProvider !== undefined ? { visionProvider } : {}) };
}

/** 读取（或迁移生成）providers.json。formats = 已注册格式白名单（ctx.providerFormats）。 */
export function ensureProvidersFile(userDir: string, cwd: string, formats: FormatLookup): ProviderFile {
  const path = join(userDir, "providers.json");
  if (existsSync(path)) {
    try {
      const store = validateStore(JSON.parse(readFileSync(path, "utf8")) as unknown, formats);
      if (store) return { path, data: store };
      console.warn("[providers] providers.json 内容无效，已重新生成默认配置（旧文件内容已丢弃）");
    } catch {
      console.warn("[providers] providers.json 解析失败，已重新生成默认配置（旧文件内容已丢弃）");
    }
  }
  const legacy = legacyDeepseek(cwd, userDir);
  const seed = DEFAULT_PROVIDER_SEED;
  const data: ProviderStore = {
    active: seed.id,
    providers: [
      {
        ...seed,
        apiKey: legacy.apiKey,
        model: legacy.model,
        contextLength: legacy.contextLength,
        maxTokens: legacy.maxTokens,
      },
    ],
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return { path, data };
}

export function saveProviderFile(file: ProviderFile): void {
  writeFileSync(file.path, JSON.stringify(file.data, null, 2), "utf8");
}

/**
 * 由配置构建 LLMProvider：查注册表分发（§4.6）——白名单与工厂都在 providers.* 模块的
 * ProviderFormatDef 里。未注册格式抛错（调用方应在入口校验：不在注册表 = 校验失败）。
 */
export function createProvider(cfg: ProviderConfig, formats: FormatLookup): LLMProvider {
  const def = formats.get(cfg.format);
  if (!def) {
    throw new Error(`未注册的接口格式：${cfg.format}（请在 src/modules.ts 组合清单登记对应 providers.* 模块）`);
  }
  return def.create(cfg);
}

/** 由显示名生成唯一 id（slug + 必要时随机后缀）。 */
export function newProviderId(name: string, existing: string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "provider";
  return existing.includes(slug) ? `${slug}-${randomUUID().slice(0, 8)}` : slug;
}
