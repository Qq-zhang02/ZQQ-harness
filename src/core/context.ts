/**
 * HarnessContext（模块化架构重构 §4.3）：各 Registry 的聚合根 + 路径/配置。
 * 模块只看见 ctx，不 import 其他模块——需要共享的东西要么下沉 core，要么经 ctx 交换。
 * P6 起 tools/providerFormats/skillSources/sandboxBackends/promptSections/mcpTransports/
 * routes 全部接线；sessionHost 由 web 壳在 loadModules 前挂上（web-* 模块触碰
 * 会话机器的唯一通道，见 core/host.ts）。
 */
import type { AppConfig } from "../config.ts";
import { Registry } from "./registry.ts";
import type { SessionHost } from "./host.ts";
import type {
  McpTransportDef,
  PromptSection,
  ProviderFormatDef,
  RouteDef,
  SandboxBackendDef,
  SkillSourceDef,
  SubagentSeam,
  SystemToolDef,
} from "./types.ts";
import { BUILTIN_PROMPT_SECTIONS } from "./sections.ts";

export interface HarnessPaths {
  userDir: string;
  globalSkillsDir: string;
  globalMcpFile: string;
  workspacesFile: string;
  sessionsDir: string;
}

export interface HarnessContext {
  paths: HarnessPaths;
  config: AppConfig;
  tools: Registry<SystemToolDef, "name">;
  providerFormats: Registry<ProviderFormatDef, "format">;
  skillSources: Registry<SkillSourceDef, "name">;
  sandboxBackends: Registry<SandboxBackendDef, "id">;
  mcpTransports: Registry<McpTransportDef, "type">;
  routes: Registry<RouteDef, "path">;
  promptSections: Registry<PromptSection, "name">;
  /** web 壳实现的宿主会话服务；buildContext 不创建，bootstrap 在 loadModules 前赋值 */
  sessionHost?: SessionHost;
  /** P8 预留 seam：子代理服务工厂（web 壳实现）；同 sessionHost，bootstrap 赋值，按会话取服务 */
  subagent?: SubagentSeam;
}

export function buildContext(paths: HarnessPaths, config: AppConfig): HarnessContext {
  const ctx: HarnessContext = {
    paths,
    config,
    tools: new Registry<SystemToolDef, "name">("name"),
    providerFormats: new Registry<ProviderFormatDef, "format">("format"),
    skillSources: new Registry<SkillSourceDef, "name">("name"),
    sandboxBackends: new Registry<SandboxBackendDef, "id">("id"),
    mcpTransports: new Registry<McpTransportDef, "type">("type"),
    routes: new Registry<RouteDef, "path">("path"),
    promptSections: new Registry<PromptSection, "name">("name"),
  };
  // 内置 sections 是装配规则本身，属 core：随 ctx 构建注册
  for (const section of BUILTIN_PROMPT_SECTIONS) ctx.promptSections.register(section);
  return ctx;
}
