/**
 * mcp.json 文件机制（严格层）：供 tools.mcp-manage 模块使用。
 * 与 manager.ts 的 loadMcpConfig（宽松层：坏文件静默跳过，保证会话照常启动）刻意分层——
 * 本层 fail-closed：解析/结构异常一律拒绝写回，宁可让模型报告"文件已损坏请人工修复"，
 * 也绝不覆盖损坏文件破坏用户已装好的服务器。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServerConfig } from "../core/types.ts";

export type McpConfigRead =
  | { ok: true; obj: Record<string, unknown>; servers: Record<string, McpServerConfig> }
  | { ok: false; error: string };

/** 严格解析：顶层必须是有 mcpServers 对象键的 JSON 对象（未知顶层键原样保留，写回不丢）。 */
export function parseMcpConfigText(text: string): McpConfigRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "顶层必须是一个 JSON 对象" };
  }
  const obj = parsed as Record<string, unknown>;
  const ms = obj.mcpServers;
  if (ms === undefined) return { ok: false, error: "缺少顶层键 mcpServers" };
  if (!ms || typeof ms !== "object" || Array.isArray(ms)) {
    return { ok: false, error: "mcpServers 必须是一个对象（键=服务名，值=服务器配置）" };
  }
  return { ok: true, obj, servers: ms as Record<string, McpServerConfig> };
}

export type McpConfigFileRead =
  | { state: "missing" }
  | { state: "ok"; obj: Record<string, unknown>; servers: Record<string, McpServerConfig> }
  | { state: "corrupt"; error: string };

/** 读一个 mcp.json：不存在是正常态（missing）；存在但坏是 corrupt（调用方必须拒绝修改）。 */
export function readMcpConfigFile(path: string): McpConfigFileRead {
  if (!existsSync(path)) return { state: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { state: "corrupt", error: `读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const r = parseMcpConfigText(text);
  return r.ok ? { state: "ok", obj: r.obj, servers: r.servers } : { state: "corrupt", error: r.error };
}

/**
 * 校验一条服务器配置（add 时用；返回 null=合法，字符串=错误说明）。
 * hasTransport 判断 type 是否已注册（缺省 stdio 恒合法——传输注册表必有）。
 * 服务名同时是工具前缀 mcp__<名>__<工具> 的一段，因此禁止空白/控制字符。
 */
export function validateServerEntry(
  name: string,
  cfg: unknown,
  hasTransport: (type: string) => boolean,
): string | null {
  if (!name.trim()) return "服务名（name）不能为空";
  if (name.trim() !== name) return "服务名首尾不能有空白";
  if (name.length > 64) return "服务名过长（≤64 字符）";
  if (/[\s\u0000-\u001f]/.test(name)) return "服务名不能含空格或控制字符（它用于工具名 mcp__<服务名>__<工具名>）";
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return "服务器配置必须是一个对象";
  const c = cfg as Record<string, unknown>;
  if (typeof c.command !== "string" || !c.command.trim()) return "command 不能为空（要启动的可执行命令）";
  if (c.type !== undefined) {
    if (typeof c.type !== "string" || !c.type) return "type 必须是非空字符串";
    if (!hasTransport(c.type)) return `type "${c.type}" 未注册（本版本仅支持 stdio，缺省即可）`;
  }
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== "string"))) {
    return "args 必须是字符串数组";
  }
  if (c.env !== undefined) {
    const env = c.env;
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
      return "env 必须是字符串到字符串的对象";
    }
  }
  if (c.cwd !== undefined && typeof c.cwd !== "string") return "cwd 必须是字符串";
  return null;
}

/** 从工具入参构造配置对象：只保留合法键，未提供的键不写进文件。入参先经 validateServerEntry 校验。 */
export function buildServerConfig(a: {
  command: string;
  type?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}): McpServerConfig {
  const cfg: McpServerConfig = { command: a.command };
  if (a.type !== undefined) cfg.type = String(a.type);
  if (a.args !== undefined) cfg.args = (a.args as unknown[]).map((x) => String(x));
  if (a.env !== undefined) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.env as Record<string, unknown>)) out[k] = String(v);
    cfg.env = out;
  }
  if (a.cwd !== undefined && String(a.cwd)) cfg.cwd = String(a.cwd);
  return cfg;
}

/** 原子写回（tmp + rename）：未知顶层键与其他服务器条目原样保留。 */
export function writeMcpConfigFile(path: string, obj: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
