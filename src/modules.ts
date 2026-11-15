/**
 * 组合清单（模块化架构重构 §4.2）：产品 = 这张表。增删能力的唯一登记处。
 * P3：系统工具两模块迁入。P4：提供方格式两模块迁入。P5：技能来源、MCP stdio 传输、
 * Windows ACL 沙箱后端迁入。P6：四个 web-* 路由模块迁入（server.ts 只剩瘦壳）。
 * docs/26 F1：web.static 迁入（/app/*.js 前端 ES 模块静态服务）。docs/25 DT3：web.desktop
 * 迁入（/api/desktop 桌面壳偏好，desktop.json）。
 * 依赖方向铁律：modules/* → core/* 允许；模块之间禁止互相 import。
 */
import type { HarnessModule } from "./core/module.ts";
import { toolAgentTask } from "./modules/tools/agent-task/index.ts";
import { mcpStdio } from "./modules/mcp/stdio/index.ts";
import { providerAnthropic } from "./modules/providers/anthropic/index.ts";
import { providerOpenai } from "./modules/providers/openai/index.ts";
import { sandboxWindowsAcl } from "./modules/sandbox/windows-acl/index.ts";
import { skillsFsSource } from "./modules/skills/fs-source/index.ts";
import { toolEditFile } from "./modules/tools/edit-file/index.ts";
import { toolViewImage } from "./modules/tools/view-image/index.ts";
import { toolLoadSkill } from "./modules/tools/load-skill/index.ts";
import { toolMcpManage } from "./modules/tools/mcp-manage/index.ts";
import { toolPwsh } from "./modules/tools/pwsh/index.ts";
import { toolReadFile } from "./modules/tools/read-file/index.ts";
import { toolReadArchive } from "./modules/tools/read-archive/index.ts";
import { toolWriteFile } from "./modules/tools/write-file/index.ts";
import { webApproval } from "./modules/web-approval/index.ts";
import { webDesktop } from "./modules/web-desktop/index.ts";
import { webProviders } from "./modules/web-providers/index.ts";
import { webSessions } from "./modules/web-sessions/index.ts";
import { webSettings } from "./modules/web-settings/index.ts";
import { webStatic } from "./modules/web-static/index.ts";
import { webWorkspaces } from "./modules/web-workspaces/index.ts";

export const BUILTIN_MODULES: HarnessModule[] = [
  providerOpenai,
  providerAnthropic,
  toolAgentTask,
  toolLoadSkill,
  toolPwsh,
  toolReadFile,
  toolReadArchive,
  toolWriteFile,
  toolEditFile,
  toolMcpManage,
  toolViewImage,
  skillsFsSource,
  mcpStdio,
  sandboxWindowsAcl,
  webApproval,
  webDesktop,
  webProviders,
  webSessions,
  webSettings,
  webStatic,
  webWorkspaces,
];
