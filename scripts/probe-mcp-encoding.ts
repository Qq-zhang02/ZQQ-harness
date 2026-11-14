/**
 * MCP 中文编码探针：连接全局 mcp.json 里的 ref-database，用中文 query 调一次
 * search_literature，打印回显的 query——验证子进程 stdio 是否已是 UTF-8（无乱码）。
 * 用法：node scripts/probe-mcp-encoding.ts [中文查询]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { McpClient } from "../src/modules/mcp/stdio/transport.ts";

const mcpFile = join(homedir(), ".ZQQ-harness", "mcp.json");
const cfg = JSON.parse(readFileSync(mcpFile, "utf8")) as {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }>;
};
const name = process.argv[3] ?? "ref-database";
const scfg = cfg.mcpServers[name];
if (!scfg) {
  console.error(`mcp.json 里没有 ${name}（现有：${Object.keys(cfg.mcpServers).join(", ")}）`);
  process.exit(1);
}
const query = process.argv[2] ?? "病毒 宿主范围 预测 方法 CRISPR spacer";
console.log(`发送 query：${query}`);
const client = new McpClient(name, scfg);
await client.start();
try {
  const raw = await client.callTool("search_literature", { query, n_results: 3 });
  const r = JSON.parse(raw) as { query?: string; results?: unknown[] };
  console.log(`回显 query：${r.query}`);
  console.log(`结果条数：${r.results?.length ?? 0}`);
  const garbled = /[鐥呮瘨瀹夸富]|[\uFFFD]/.test(r.query ?? "");
  const intact = (r.query ?? "").includes("病毒");
  console.log(garbled || !intact ? "❌ 中文在链路上被编码损坏" : "✅ 中文往返无损（UTF-8 全链路正常）");
  process.exit(garbled || !intact ? 1 : 0);
} finally {
  client.stop();
}
