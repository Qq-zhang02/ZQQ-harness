/**
 * MCP stdio 传输（模块化架构重构 §4.7/§10，自 src/mcp/client.ts 迁入）：
 * 最小 MCP（Model Context Protocol）stdio 客户端，零外部依赖。
 * 协议：子进程 stdin/stdout 上换行分隔的 JSON-RPC 2.0。
 * 流程：initialize 握手 → notifications/initialized → tools/list → tools/call。
 * 实现传输无关的 McpConnection 接口（core/types.ts）；未来 http 等传输
 * 在 modules/mcp/<type>/ 另行实现 McpTransportDef 注册。
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { McpConnection, McpServerConfig, McpToolInfo } from "../../../core/types.ts";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = "2025-06-18";
const HANDSHAKE_TIMEOUT_MS = 20_000;

export class McpClient implements McpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools: McpToolInfo[] = [];
  private buffer = "";
  private stopped = false;
  private serverName: string;
  private cfg: McpServerConfig;
  serverInfo: { name?: string; version?: string } = {};
  /** 服务器在 initialize 握手时提供的 instructions（使用说明，注入系统提示用）；未提供为 null */
  instructions: string | null = null;

  constructor(serverName: string, cfg: McpServerConfig) {
    this.serverName = serverName;
    this.cfg = cfg;
  }

  /** 启动子进程并完成握手、拉取工具列表 */
  async start(): Promise<void> {
    const argv = this.buildArgv();
    const proc = spawn(argv[0], argv[1], {
      cwd: this.cfg.cwd,
      // Windows 下 Python（≤3.14）默认按系统区域编码（简中系统=GBK）读写 stdio，
      // 会把 UTF-8 JSON 里的中文参数读成乱码再回显；显式强制子进程用 UTF-8
      //（对非 Python 服务器无副作用；cfg.env 仍可覆盖）
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...this.cfg.env },
      windowsHide: true,
    });
    this.proc = proc;
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("无法建立 stdio 管道");
    }
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      this.buffer += d;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", () => {
      /* MCP 服务器自身日志，忽略（避免污染协议流） */
    });
    proc.on("exit", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP 服务器 "${this.serverName}" 进程已退出`));
      }
      this.pending.clear();
    });
    proc.on("error", (err) => this.failAllPending(err));

    const initResult = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "zqq-harness", version: "0.1.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    )) as { serverInfo?: { name?: string; version?: string }; instructions?: unknown };
    this.serverInfo = initResult?.serverInfo ?? {};
    this.instructions =
      typeof initResult?.instructions === "string" && initResult.instructions.trim()
        ? initResult.instructions.trim()
        : null;
    this.notify("notifications/initialized");
    const list = (await this.request("tools/list", {}, HANDSHAKE_TIMEOUT_MS)) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    this.tools = (list?.tools ?? []).map((t) => ({
      name: String(t.name),
      description: String(t.description ?? ""),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  /** Windows 下 npx/npm 等是 .cmd 脚本，直接 spawn 会 ENOENT，需经 cmd /c 启动 */
  private buildArgv(): [string, string[]] {
    if (process.platform === "win32") {
      const c = this.cfg.command;
      if (/\.(cmd|bat)$/i.test(c) || /^(npx|npm|pnpm|yarn|bun)(\.cmd|\.exe)?$/i.test(c)) {
        return [process.env.ComSpec ?? "cmd.exe", ["/c", c, ...(this.cfg.args ?? [])]];
      }
    }
    return [this.cfg.command, this.cfg.args ?? []];
  }

  private handleLine(line: string): void {
    let msg: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（服务器杂音）
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // 服务器 → 客户端的请求：MVP 不支持 roots/sampling 等，回空结果避免对端挂起
      this.write({ jsonrpc: "2.0", id: msg.id, result: msg.method === "roots/list" ? { roots: [] } : null });
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP 调用出错"));
        else p.resolve(msg.result);
      }
    }
    // 其余为通知：忽略
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.serverName}" ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string): void {
    this.write({ jsonrpc: "2.0", method });
  }

  private write(obj: unknown): void {
    if (!this.stopped) this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** 调用工具：把 text 内容块拼为字符串返回；isError 时抛错（由注册表转为错误字符串回传模型） */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("\n");
    const out = text || JSON.stringify(result ?? {});
    if (result?.isError) throw new Error(out);
    return out;
  }

  listTools(): McpToolInfo[] {
    return this.tools;
  }

  get alive(): boolean {
    return !this.stopped && this.proc !== null && this.proc.exitCode === null;
  }

  stop(): void {
    this.stopped = true;
    this.failAllPending(new Error(`MCP "${this.serverName}" 已停止`));
    this.proc?.kill();
  }
}
