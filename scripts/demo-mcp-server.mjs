/**
 * 演示用 MCP 服务器（stdio，换行分隔 JSON-RPC 2.0）。
 * 提供两个工具：add(a,b) 两数相加；echo(text) 原样返回。
 * 供 mcp.json 默认配置与测试使用，也可作为编写自定义 MCP 服务器的参考。
 * 注意：不得向 stdout 写任何非协议内容（console.log 会破坏协议流）。
 */
import { createInterface } from "node:readline";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const TOOLS = [
  {
    name: "add",
    description: "两数相加（演示 MCP 工具）",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "echo",
    description: "原样返回给定文本（演示 MCP 工具）",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // 通知：无需应答
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "demo-mcp", version: "0.1.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    let text;
    if (name === "add") text = String(Number(args.a) + Number(args.b));
    else if (name === "echo") text = String(args.text ?? "");
    else text = `未知工具: ${name}`;
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
