/**
 * mcp.stdio 模块（模块化架构重构 §4.7）：stdio 传输的注册入口。
 * 实现自 src/mcp/client.ts 迁入（transport.ts：spawn/cmd /c 包装/UTF-8 注入/
 * 行分隔 JSON-RPC/握手与调用超时）。新增传输的范式：modules/mcp/<type>/
 * 实现 McpTransportDef → modules.ts 清单加一行；manager 按 mcp.json 的
 * cfg.type（缺省 "stdio"）查 ctx.mcpTransports 选路。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { McpTransportDef } from "../../../core/types.ts";
import { McpClient } from "./transport.ts";

export const stdioTransport: McpTransportDef = {
  type: "stdio",
  async connect(serverName, cfg) {
    const client = new McpClient(serverName, cfg);
    await client.start();
    return client;
  },
};

export const mcpStdio: HarnessModule = {
  name: "mcp.stdio",
  setup(ctx) {
    ctx.mcpTransports.register(stdioTransport);
  },
};
