import { join } from "node:path";
import type { Tool } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import {
  buildServerConfig,
  readMcpConfigFile,
  validateServerEntry,
  writeMcpConfigFile,
} from "../../../mcp/config.ts";

/** 原技能（mcp-setup）排错经验的收敛：add 后启动失败时回传给模型的排查清单。 */
const TROUBLESHOOT = [
  "命令不存在：npx/npm/pnpm/yarn/bun 及 .cmd/.bat 会被自动经 cmd /c 启动，直接写 npx 即可；其他可执行文件必须写绝对路径（JSON 里用正斜杠）",
  "服务器向 stdout 打印了日志/横幅（stdout 只允许协议 JSON，日志必须走 stderr）",
  "首次运行要下载依赖/模型，超过 20 秒握手超时：先在终端手动跑一次预热，再重试本工具",
  "依赖缺失：先 run_pwsh 执行 pip install / npm install",
].map((s) => `  - ${s}`);

/** 已合并条目的一行摘要（list 用）：命令 + 参数 + 可选 cwd。 */
function entryLine(command: string, args: string[] | undefined, cwd: string | undefined): string {
  return [command, ...(args ?? [])].join(" ") + (cwd ? `（cwd: ${cwd}）` : "");
}

export function createManageMcpTool(deps: SystemToolDeps): Tool {
  const hasTransport = (t: string) => deps.ctx.mcpTransports.get(t) !== undefined;

  return {
    name: "manage_mcp",
    description:
      "管理 ZQQ-harness 的 MCP 服务器（仅支持 stdio 传输）。action=list 列出全局与工作区配置及本会话连接状态；" +
      "action=add 安装或更新服务器（name、command 必填，args/env/cwd 可选）；action=remove 卸载。" +
      "scope=global（默认，~/.ZQQ-harness/mcp.json，所有工作区生效）或 workspace（<工作区>/mcp.json，同名覆盖全局；" +
      "通用工具源放全局，仅当前项目用的放工作区，拿不准先问用户）。" +
      "写入是\"读取-合并-校验-原子替换\"：文件损坏时拒绝修改以保护已有配置；成功后自动重连本会话，" +
      "状态里直接报告连接结果（N 个工具 / 启动失败原因）；其他已开会话要新建对话或切换工作区才会加载。" +
      "Windows 适配：Python 服务器自动注入 PYTHONUTF8=1/PYTHONIOENCODING=utf-8；握手超时 20 秒、工具调用超时 60 秒；" +
      "服务名用于工具前缀 mcp__<服务名>__<工具名>，建议小写英文与连字符。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"], description: "list=查看；add=安装/更新；remove=卸载" },
        name: { type: "string", description: "服务名（add/remove 必填）。建议小写英文与连字符，如 ref-database" },
        command: { type: "string", description: "add 必填。启动命令：npx 直接写 npx；其他写绝对路径（正斜杠）" },
        args: { type: "array", items: { type: "string" }, description: "add 可选。命令参数数组" },
        env: { type: "object", description: "add 可选。环境变量（字符串到字符串），如 {\"API_KEY\": \"...\"}" },
        cwd: { type: "string", description: "add 可选。子进程工作目录" },
        type: { type: "string", description: "add 可选。传输类型，缺省 stdio（当前唯一支持值）" },
        scope: { type: "string", enum: ["global", "workspace"], description: "可选，默认 global。写入哪个 mcp.json" },
      },
      required: ["action"],
    },

    async execute(args) {
      const action = String(args.action ?? "");
      const scope = args.scope === "workspace" ? "workspace" : "global";
      const globalFile = deps.ctx.paths.globalMcpFile;
      const wsFile = join(deps.workspace().root, "mcp.json"); // list 需要两份都看，与 scope 无关
      const file = scope === "global" ? globalFile : wsFile;

      if (action === "list") return listAll(deps, globalFile, wsFile);
      if (action === "add") return await addServer(deps, hasTransport, file, scope, args);
      if (action === "remove") return await removeServer(deps, file, scope, args);
      return `错误：未知 action "${action}"（可用：list / add / remove）`;
    },
  };
}

/** list：全局 + 工作区两份配置都展示（损坏的标注但不妨碍看另一份），附本会话连接状态。 */
function listAll(deps: SystemToolDeps, globalFile: string, wsFile: string): string {
  const global = readMcpConfigFile(globalFile);
  const ws = readMcpConfigFile(wsFile);
  const status = deps.mcpStatus();
  const lines: string[] = [];

  const dump = (label: string, path: string, r: ReturnType<typeof readMcpConfigFile>) => {
    lines.push(`【${label}】${path}`);
    if (r.state === "missing") {
      lines.push("  （文件不存在，尚未配置）");
    } else if (r.state === "corrupt") {
      lines.push(`  ⚠ 文件损坏：${r.error}——manage_mcp 拒绝修改它，需人工修复后再用本工具`);
    } else {
      const names = Object.keys(r.servers);
      if (names.length === 0) lines.push("  （无服务器）");
      for (const name of names) {
        const issue = validateServerEntry(name, r.servers[name], (t) => deps.ctx.mcpTransports.get(t) !== undefined);
        const cfg = r.servers[name] as { command?: string; args?: string[]; cwd?: string };
        const live = status.find((l) => l.startsWith(`${name}（`));
        lines.push(
          `  - ${name}：${entryLine(cfg.command ?? "?", cfg.args, cfg.cwd)}` +
            (issue ? ` ⚠ 配置有误：${issue}` : "") +
            (live ? ` → ${live}` : ""),
        );
      }
    }
  };
  dump("全局（所有工作区生效）", deps.ctx.paths.globalMcpFile, global);
  dump("工作区（仅当前工作区，同名覆盖全局）", wsFile, ws);
  lines.push(`本会话连接状态：${status.length > 0 ? status.join("；") : "无"}`);
  return lines.join("\n");
}

/** 读一份待写配置；损坏时拒绝（fail-closed）并指引人工修复。 */
function readForWrite(file: string): { obj: Record<string, unknown>; servers: Record<string, unknown>; existed: boolean } | { error: string } {
  const r = readMcpConfigFile(file);
  if (r.state === "corrupt") {
    return {
      error:
        `拒绝修改：${file} 已损坏（${r.error}）。为保护你的配置不会被覆盖，本工具不会写这个文件。` +
        "请让用户手工修复该文件（或删除它从零开始），修复后重试。",
    };
  }
  if (r.state === "missing") {
    return { obj: { mcpServers: {} }, servers: {}, existed: false };
  }
  return { obj: r.obj, servers: r.servers as Record<string, unknown>, existed: true };
}

async function addServer(
  deps: SystemToolDeps,
  hasTransport: (t: string) => boolean,
  file: string,
  scope: "global" | "workspace",
  args: Record<string, unknown>,
): Promise<string> {
  const name = String(args.name ?? "");
  const command = String(args.command ?? "");
  // 先校验原始入参（类型不对给可读错误），再构造配置对象——构造会对 env/args 做展开，脏入参不能先喂给它
  const issue = validateServerEntry(name, { command, type: args.type, args: args.args, env: args.env, cwd: args.cwd }, hasTransport);
  if (issue) return `错误：${issue}`;
  const cfg = buildServerConfig({
    command,
    type: args.type,
    args: args.args,
    env: args.env,
    cwd: args.cwd,
  });

  const read = readForWrite(file);
  if ("error" in read) return read.error;
  const updating = name in read.servers;
  (read.obj.mcpServers as Record<string, unknown>)[name] = cfg;
  writeMcpConfigFile(file, read.obj);

  const status = await deps.reloadMcp();
  const live = status.find((l) => l.startsWith(`${name}（`));
  const head =
    `已${updating ? "更新" : "写入"} ${scope === "global" ? "全局" : "工作区"}配置 ${file}\n` +
    `  ${name}：${entryLine(cfg.command, cfg.args, cfg.cwd)}\n` +
    `本会话已重连：${live ?? "（状态未知）"}`;
  if (live?.includes("启动失败")) {
    return (
      head +
      "\n服务器启动失败，可按以下清单排查后重试：\n" +
      TROUBLESHOOT.join("\n") +
      "\n修复后再次 add 即可覆盖更新。"
    );
  }
  return (
    head +
    `\n已生效：工具名前缀 mcp__${name}__<工具名>，下一轮对话即可调用。` +
    "\n其他已开的对话需新建对话或切换工作区后才会加载该服务器。"
  );
}

async function removeServer(
  deps: SystemToolDeps,
  file: string,
  scope: "global" | "workspace",
  args: Record<string, unknown>,
): Promise<string> {
  const name = String(args.name ?? "");
  if (!name.trim()) return "错误：卸载需要 name 参数";
  const read = readForWrite(file);
  if ("error" in read) return read.error;
  if (!read.existed) return `${scope === "global" ? "全局" : "工作区"}配置 ${file} 不存在，没有可卸载的服务器。`;
  if (!(name in read.servers)) {
    const names = Object.keys(read.servers);
    return `错误：${file} 中没有名为 "${name}" 的服务器。现有：${names.join("、") || "（无）"}` +
      "（注意区分全局与工作区 scope：同名时工作区覆盖全局，卸载另一份需换 scope）";
  }
  delete (read.obj.mcpServers as Record<string, unknown>)[name];
  writeMcpConfigFile(file, read.obj);
  const status = await deps.reloadMcp();
  const gone = !status.some((l) => l.startsWith(`${name}（`));
  return `已从${scope === "global" ? "全局" : "工作区"}配置 ${file} 移除 "${name}"，本会话已重连（${gone ? "该服务器已断开" : "注意：状态中仍可见，可能来自另一份配置文件"}）。\n` +
    `剩余服务器：${status.join("；") || "无"}。`;
}
