/**
 * providers.openai 模块（模块化架构重构 §4.6）：openai 兼容格式的注册入口。
 * 实现自 src/llm/openai.ts 迁入（provider.ts，类名不变）；
 * 格式白名单、工厂、缺省思考档位由此声明，store/server 全部改查注册表。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { ProviderFormatDef } from "../../../core/types.ts";
import { OpenAICompatProvider } from "./provider.ts";

export const openaiFormatDef: ProviderFormatDef = {
  format: "openai",
  label: "OpenAI 兼容",
  defaultEffort: () => "default",
  create(cfg) {
    return new OpenAICompatProvider({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      effort: cfg.effort,
      maxTokens: cfg.maxTokens ?? undefined,
    });
  },
};

export const providerOpenai: HarnessModule = {
  name: "providers.openai",
  setup(ctx) {
    ctx.providerFormats.register(openaiFormatDef);
  },
};
