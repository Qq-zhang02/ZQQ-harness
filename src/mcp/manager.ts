/**
 * MCP 管理器：读取 mcp.json，按配置的传输类型（cfg.type，缺省 "stdio"）经
 * ctx.mcpTransports 注册表建立连接，把工具以 mcp__<服务器>__<工具名> 注册进
 * 工具注册表。注意：MCP 工具视为用户显式配置的可信工具，不走 pwsh 的工作区守卫。
 * （§10 远期去向 web/mcp-manager.ts 随 P6 web 目录重组一并处理，本阶段保留原位。）
 */
import { readFile } from "node:fs/promises";
import { MCP_TOOL_PREFIX, type McpConnection, type McpServerConfig, type McpToolInfo, type McpTransportDef } from "../core/types.ts";
import type { Registry } from "../core/registry.ts";
import type { Tool, ToolRegistry } from "../tools/registry.ts";

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export async function loadMcpConfig(paths: string[]): Promise<McpConfigFile> {
  for (const p of paths) {
    try {
      const parsed = JSON.parse(await readFile(p, "utf8")) as Partial<McpConfigFile>;
      if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
        return { mcpServers: parsed.mcpServers };
      }
    } catch {
      // 文件不存在或格式不对，找下一个
    }
  }
  return { mcpServers: {} };
}

export class McpManager {
  private transports: Registry<McpTransportDef, "type">;
  private clients = new Map<string, { client: McpConnection; source: "global" | "workspace" }>();
  private failures: { name: string; error: string }[] = [];
  private registered: string[] = [];

  constructor(transports: Registry<McpTransportDef, "type">) {
    this.transports = transports;
  }

  /**
   * 应用 MCP 配置（全局 + 工作区同名覆盖全局）：
   * 先断开现有连接并注销旧工具，再按合并结果启动、注册。
   * 切换工作区时重复调用即可完成"动态重连"。
   */
  async apply(
    globalCfg: McpConfigFile,
    wsCfg: McpConfigFile,
    registry: ToolRegistry,
  ): Promise<void> {
    this.stopAll(registry);
    const merged = new Map<string, { cfg: McpServerConfig; source: "global" | "workspace" }>();
    for (const [name, cfg] of Object.entries(globalCfg.mcpServers ?? {})) {
      merged.set(name, { cfg, source: "global" });
    }
    for (const [name, cfg] of Object.entries(wsCfg.mcpServers ?? {})) {
      merged.set(name, { cfg, source: "workspace" });
    }
    for (const [name, { cfg, source }] of merged) {
      try {
        const transport = this.transports.require(cfg.type ?? "stdio");
        const client = await transport.connect(name, cfg);
        this.clients.set(name, { client, source });
        for (const t of client.listTools()) {
          const tool = McpManager.toTool(name, client, t);
          registry.register(tool);
          this.registered.push(tool.name);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.failures.push({ name, error: msg });
        console.warn(`[mcp] 服务器 "${name}"（${source === "global" ? "全局" : "工作区"}）启动失败：${msg}`);
      }
    }
  }

  /** 断开全部连接并从注册表注销所有 mcp__ 工具 */
  stopAll(registry: ToolRegistry): void {
    for (const name of this.registered) registry.remove(name);
    this.registered = [];
    for (const { client } of this.clients.values()) client.stop();
    this.clients.clear();
    this.failures = [];
  }

  private static toTool(server: string, client: McpConnection, t: McpToolInfo): Tool {
    return {
      name: `${MCP_TOOL_PREFIX}${server}__${t.name}`,
      description: `[MCP:${server}] ${t.description || "(无描述)"}`,
      parameters: t.inputSchema,
      async execute(args) {
        return await client.callTool(t.name, args);
      },
    };
  }

  /** 供 /status 展示 */
  status(): string[] {
    const lines: string[] = [];
    for (const [name, { client, source }] of this.clients) {
      lines.push(
        `${name}（${source === "global" ? "全局" : "工作区"}，${client.listTools().length} 个工具${client.alive ? "" : "，连接已断开"}）`,
      );
    }
    for (const f of this.failures) lines.push(`${f.name}（启动失败：${f.error}）`);
    return lines;
  }

  /**
   * 汇总全部已连接服务器的 instructions（按服务器分节标注来源），
   * 供注入系统提示；没有任何服务器提供时返回 null。
   */
  instructionsText(): string | null {
    const parts: string[] = [];
    for (const [name, { client, source }] of this.clients) {
      if (client.instructions) {
        parts.push(`【${name}（${source === "global" ? "全局" : "工作区"}）】\n${client.instructions}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /** 启动失败的服务器清单（docs/32）：workerMcpToolsOf 的失败重试判据 + 协调者
   *  「子代理系统提示词说明」段的未连接警示行。返回拷贝，调用方可安全持有。 */
  failedServers(): { name: string; error: string }[] {
    return this.failures.map((f) => ({ ...f }));
  }

  /**
   * 已连接服务器的 MCP 工具能力清单（docs/32）：按服务器分组的「mcp__服务器__工具 —— 描述
   * (截~120字)」行。供协调者的「子代理系统提示词说明」段兜底——服务器不提供 instructions
   * 时协调者也能看到子代理有哪些 MCP 工具可派。没有任何已连接客户端时返回 null。
   */
  toolInventoryText(): string | null {
    const parts: string[] = [];
    for (const [name, { client, source }] of this.clients) {
      const tools = client.listTools();
      if (tools.length === 0) continue;
      const lines = tools.map((t) => {
        const desc = t.description.trim();
        const clipped = desc.length > 120 ? desc.slice(0, 120) + "…" : desc;
        return `- ${MCP_TOOL_PREFIX}${name}__${t.name}${clipped ? ` —— ${clipped}` : ""}`;
      });
      parts.push(`【${name}（${source === "global" ? "全局" : "工作区"}，${tools.length} 个工具）】\n${lines.join("\n")}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  toolCount(): number {
    let n = 0;
    for (const { client } of this.clients.values()) n += client.listTools().length;
    return n;
  }

  stop(): void {
    for (const { client } of this.clients.values()) client.stop();
  }
}
