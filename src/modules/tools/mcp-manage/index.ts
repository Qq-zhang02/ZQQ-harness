/**
 * tools.mcp-manage 模块：manage_mcp 系统工具的注册入口——替代原 mcp-setup 全局技能。
 * 技能方案的缺陷：模型经 run_pwsh 手改 mcp.json，纯靠提示词约定合并与校验，有概率
 * 格式出错连累已装好的服务器。系统工具方案：严格层（src/mcp/config.ts，损坏文件
 * fail-closed 拒改）+ 原子写 + 条目校验 + 写入后自动重连本会话（SystemToolDeps.reloadMcp），
 * 连接成败当场回传给模型形成闭环。原技能的 Windows 适配知识收进工具 description。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createManageMcpTool } from "./mcp-manage.ts";

const def: SystemToolDef = {
  name: "manage_mcp",
  summary: "管理 MCP 服务器（查看/安装/卸载 mcp.json，写入后自动重连本会话并回报连接结果）",
  create: createManageMcpTool,
};

export const toolMcpManage: HarnessModule = {
  name: "tools.mcp-manage",
  setup(ctx) {
    ctx.tools.register(def);
  },
};
