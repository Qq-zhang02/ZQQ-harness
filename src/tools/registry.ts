import type { ChatImage, ToolSchema } from "../llm/provider.ts";
import type { Workspace } from "../workspace.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.ts";
import type { SandboxMode } from "../sandbox/types.ts";
import { DEFAULTS } from "../config.ts";
import { pruneToolResult } from "./prune.ts";

export interface ToolContext {
  workspace: Workspace;
  /** 请求人工批准（封闭决策词汇）。只有 allowed-once 放行，且仅限当次。 */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 逐条确认模式：所有命令都要走批准 */
  alwaysConfirm?: boolean;
  /** 沙箱模式（随会话存档）；Phase A 无后端时受约束模式 fail-closed 拒绝 */
  sandboxMode?: SandboxMode;
  /** 工具结果统一修剪预算（字符）；缺省 DEFAULTS.toolResultMaxChars */
  toolResultMaxChars?: number;
  /** 超长输出全文落盘目录（spill，按会话）；缺省不落盘 */
  spillDir?: string;
  /** 沙箱私有临时目录（~/.ZQQ-harness/tmp/<sessionId>/，随会话）；workspace-write 模式受限执行时必须 */
  privateTempDir?: string;
  /** 子代理写入分区（docs/5 §5.4）：相对工作区根的路径前缀。文件三工具对区外目标硬拒
   *  （不走审批——scope 是协调者的结构性决定）；run_pwsh 的守卫检测到引用区外路径时
   *  把「scope 越界」加入 reasons 强制弹卡由用户裁决（启发式，诚实边界）。缺省=整个工作区 */
  writeScope?: string[];
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  /** 系统提示"可用工具"行的一句话摘要（§4.4 工具行生成化）；缺省=不进入该行（如 mcp__ 工具） */
  summary?: string;
  /** JSON Schema（object 类型） */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** 可选：带图像块返回（docs/34 read_image——图像作为 tool 消息的 images 进入对话）。
   *  实现时 execute 只作注册表回退兜底（executeWithMeta **优先本方法、二者只执行其一**）；
   *  带图返回只在会话模型有视觉能力时有意义（工具层用 selfVision 闸门，纯文本模型
   *  直接拒绝，不会先存再变占位）。 */
  executeImage?(args: Record<string, unknown>, ctx: ToolContext): Promise<{ text: string; images: ChatImage[] }>;
}

/** 工具执行结果（注册表层统一修剪后）：text 入模型，full 供 UI 完整展示，prunedChars/spilled 为元数据。 */
export interface ToolExecResult {
  /** 入模型 history 的文本（修剪后 + 可能的 spill 引用） */
  text: string;
  /** 工具原始输出（未修剪；UI 展示用，spill 只影响 text 不影响这里） */
  full: string;
  /** 被剪掉的字符数（未修剪为 0） */
  prunedChars: number;
  /** 触发落盘时的全文文件路径 */
  spilled?: string;
  /** 工具返回的图像块（docs/34 read_image）：agent 回填 tool 消息时挂 images——提供方投影
   *  成路由对应的图像形态（anthropic=tool_result 内图像块；openai 兼容=紧随合成 user 图像
   *  消息）。文本修剪不丢弃图像（图像是内容本体，不是超长文本）。 */
  images?: ChatImage[];
}

/**
 * 工具注册表。execute 不抛异常：所有错误都以字符串形式返回给模型，
 * 让模型有机会自行修正参数或换个做法。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** 注销工具（MCP 重连时移除旧服务器的工具用） */
  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** 全部已注册工具（系统提示 toolDocs 生成用）；无序（按注册序）。 */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 执行并附修剪元数据：text（入模型）与 full（UI 完整展示）分离。 */
  async executeWithMeta(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolExecResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      const msg = `错误：未知工具 "${name}"，可用工具：${[...this.tools.keys()].join("、")}`;
      return { text: msg, full: msg, prunedChars: 0 };
    }
    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      const msg = `错误：参数不是合法 JSON：${rawArgs.slice(0, 200)}`;
      return { text: msg, full: msg, prunedChars: 0 };
    }
    let full: string;
    let images: ChatImage[] | undefined;
    try {
      // docs/34：实现 executeImage 的工具（read_image）走带图路径——二者只执行其一
      if (tool.executeImage) {
        const rich = await tool.executeImage(args, ctx);
        full = rich.text;
        images = rich.images;
      } else {
        full = await tool.execute(args, ctx);
      }
    } catch (e) {
      full = `工具执行出错：${e instanceof Error ? e.message : String(e)}`;
      return { text: full, full, prunedChars: 0 };
    }
    // 注册表级统一修剪：所有工具（run_pwsh、mcp__、read_file、load_skill 等）一致生效
    // —— executeWithMeta 是唯一执行入口（工具自身的采集上限仍由各自负责）
    const pr = pruneToolResult(full, ctx.toolResultMaxChars ?? DEFAULTS.toolResultMaxChars, ctx.spillDir ? { dir: ctx.spillDir } : undefined);
    return { text: pr.text, full, prunedChars: pr.prunedChars, ...(pr.spilled ? { spilled: pr.spilled } : {}), ...(images?.length ? { images } : {}) };
  }

  /** 兼容入口：只取入模型的文本。 */
  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    return (await this.executeWithMeta(name, rawArgs, ctx)).text;
  }
}
