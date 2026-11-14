/**
 * tools.pwsh 模块（模块化架构重构 §4.5）：run_pwsh 系统工具的注册入口。
 * 实现自 src/tools/pwsh.ts 迁入（pwsh.ts：守卫/审批/沙箱裁决 + per-session 升级额度）。
 * 新增系统工具的范式：本文件定义 SystemToolDef（name/summary/create）→ modules.ts 清单加一行。
 * 系统提示的"可用工具"行由 summary 自动生成，无需再改 agent/server。
 */
import type { HarnessModule } from "../../../core/module.ts";
import { createPwshTool } from "./pwsh.ts";

export const toolPwsh: HarnessModule = {
  name: "tools.pwsh",
  setup(ctx) {
    ctx.tools.register({
      name: "run_pwsh",
      summary: "在本机 PowerShell 7 中执行命令，工作目录为工作区根目录",
      create() {
        return createPwshTool();
      },
    });
  },
};
