/**
 * providers.anthropic 模块（模块化架构重构 §4.6）：Anthropic Messages 格式的注册入口。
 * 实现自 src/llm/anthropic.ts 迁入（provider.ts，类名不变）；
 * 格式白名单、工厂、缺省思考档位由此声明，store/server 全部改查注册表。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { ProviderFormatDef } from "../../../core/types.ts";
import { AnthropicProvider } from "./provider.ts";

export const anthropicFormatDef: ProviderFormatDef = {
  format: "anthropic",
  label: "Anthropic 兼容",
  defaultEffort: () => "default",
  create(cfg) {
    return new AnthropicProvider({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      effort: cfg.effort,
      maxTokens: cfg.maxTokens ?? undefined,
    });
  },
};

export const providerAnthropic: HarnessModule = {
  name: "providers.anthropic",
  setup(ctx) {
    ctx.providerFormats.register(anthropicFormatDef);
  },
};
