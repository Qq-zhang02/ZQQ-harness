/**
 * read_archive 工具实现（docs/17 存档注入）：把子代理过程存档 / 主对话会话档读回并渲染成
 * 可读纯文本注入上下文（不直接读 JSON——「给模型发信息」而非转储语法噪音）。存档解析与
 * IO 在 deps.archiveSource 接缝（web/subagents.ts archiveSourceOf，主会话与全部 worker
 * 同一实现）；本模块只做参数校验、渲染与预算截断。
 */
import { THRESHOLDS } from "../../../config.ts";
import type { ChatMessage } from "../../../llm/provider.ts";
import { clipLine, progressDigestOf, toolEventLine, toolEventsOf } from "../../../core/progress.ts";
import { pruneToolResult } from "../../../tools/prune.ts";
import type { Tool } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";

/**
 * ChatMessage[] → 可读纯文本（docs/17）：一段一事件、无 JSON 语法噪音——
 *   [用户] 内容
 *   [助手] 内容
 *   [助手 → 工具名] 参数
 *   [工具] 结果
 * 思考块不回放（内部过程；存档消费方只需结论与操作链路）；图片标注占位（存档不含图像
 * 数据注入）。工具参数是原始 JSON 串，压缩空白后单行原样展示——参数本身是结构化数据，
 * 保留原样最诚实，不二次加工。
 */
export function renderArchiveMessages(messages: readonly ChatMessage[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // 存档本就不含系统提示；防御跳过
    if (m.role === "user") {
      const imgs = m.images?.length ? `（含图片 ×${m.images.length}）` : "";
      blocks.push(`[用户] ${m.content}${imgs}`);
    } else if (m.role === "assistant") {
      const text = (m.content ?? "").trim();
      if (text) blocks.push(`[助手] ${text}`);
      for (const t of m.toolCalls) {
        blocks.push(`[助手 → ${t.name}] ${String(t.arguments).replace(/\s+/g, " ").trim()}`);
      }
      if (!text && m.toolCalls.length === 0) blocks.push("[助手] （无文本回复）");
    } else {
      blocks.push(`[工具] ${m.content}`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * 摘要版渲染（docs/42）：决策与路径索引，不回放工具结果全文——接手一个做过上百次工具调用的
 * 存档，完整版动辄十几万字符（比直接看磁盘产出还贵），摘要版只留四块：任务书（截 300）、
 * 助手说明文字（截 400——决定与进展都在这里）、操作索引（每个调用一行：工具 + 路径/命令 +
 * 成败标记）、进展速览（progressDigestOf）。需要某个工具结果的全文再去掉 summary 读完整版。
 */
export function renderArchiveSummary(messages: readonly ChatMessage[]): string {
  const tasks: string[] = [];
  const notes: string[] = [];
  for (const m of messages) {
    if (m.role === "user") tasks.push(`- ${clipLine(m.content, 300)}`);
    else if (m.role === "assistant" && (m.content ?? "").trim()) notes.push(`- ${clipLine(m.content ?? "", 400)}`);
  }
  const events = toolEventsOf(messages);
  const parts: string[] = [];
  if (tasks.length > 0) parts.push(`[任务书（${tasks.length} 条）]\n${tasks.join("\n")}`);
  if (notes.length > 0) parts.push(`[过程说明（${notes.length} 条助手文本）]\n${notes.join("\n")}`);
  parts.push(`[操作索引（${events.length} 个工具调用）]\n${events.map((e) => `- ${toolEventLine(e)}`).join("\n") || "-（无）"}`);
  const digest = progressDigestOf(messages);
  if (digest) parts.push(`[进展速览]\n${digest}`);
  return parts.join("\n\n");
}

/** read_archive：存档注入（docs/17）。subId（本会话子代理过程存档）/ sessionId（主对话
 *  记录）二选一；都不给时返回可用存档清单自纠错（清单来自 deps.archiveSource）。渲染
 *  文本超出预算截为头部 + 省略标记（不 spill——存档全文本就在盘上，缺什么再读什么）。
 *  docs/40 阶段二（单层化）：预算 = min(archiveRenderMaxChars, 阅读类注册表预算)，自限后
 *  注册表二次修剪不再触发（此前 160k 预剪会被注册表再砍到通用预算、spill 落的还是已剪版）；
 *  resultBudget 声明阅读类预算供注册表兜底口径一致。两者均调用期求值（live binding）。 */
export function createReadArchiveTool(deps: SystemToolDeps): Tool {
  return {
    name: "read_archive",
    resultBudget: () => THRESHOLDS.readToolResultMaxChars,
    description:
      "读取一份历史存档，把其中的对话与操作过程转成可读文本注入本代理的上下文（不是直接读 JSON 原文）。两种来源二选一：" +
      "subId=本会话某个子代理的过程存档（接续已被归档/失效子代理的工作——任务书指定的 subId）；" +
      "sessionId=另一段主对话的完整记录（接续旧会话的工作）。" +
      "summary=true 读摘要版（任务书、助手的说明文字、每个工具调用一行的操作索引、进展速览）——接手别人的工作先读它，" +
      "只有需要某个工具结果的全文时才去掉 summary 读完整版（完整版可能很大）。读完后按存档里的进展继续当前任务，" +
      "不要重复存档里已完成的工作。",
    parameters: {
      type: "object",
      properties: {
        subId: { type: "integer", description: "本会话子代理序号（报告/[[过程档案#N]] 标注里的 #N）——读它的全程过程存档" },
        sessionId: { type: "string", description: "主对话会话 id（UUID，会话列表里那条对话）——读它的完整历史记录" },
        summary: { type: "boolean", description: "可选，true=摘要版（任务书/助手说明/操作索引/进展速览，不含工具结果全文）；缺省完整版" },
      },
    },
    async execute(args) {
      const src = deps.archiveSource;
      if (!src) return "错误：存档解析不可用（本会话未装配存档接缝）。";
      const subId = args.subId === undefined || args.subId === null ? undefined : Number(args.subId);
      const sessionId = args.sessionId === undefined || args.sessionId === null ? undefined : String(args.sessionId).trim();
      if (subId !== undefined && (!Number.isInteger(subId) || subId < 1)) return "错误：subId 必须是正整数。";
      if (sessionId !== undefined && !sessionId) return "错误：sessionId 不能为空。";
      const r = src({
        ...(subId !== undefined ? { subId } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      if (!r.ok) return r.error;
      const header = args.summary === true
        ? `存档注入（摘要版） · ${r.label} · 共 ${r.messages.length} 条消息\n` +
          "（摘要 = 任务书、助手的说明文字、每个工具调用一行的操作索引、进展速览；需要某个工具结果的全文时去掉 summary 读完整版）\n\n"
        : `存档注入 · ${r.label} · 共 ${r.messages.length} 条消息\n` +
          "（以下是该段历史的过程回放，供接续上下文；运行中子代理的快照截至其最近一次任务结束）\n\n";
      const budget = Math.min(THRESHOLDS.archiveRenderMaxChars, THRESHOLDS.readToolResultMaxChars);
      const pr = pruneToolResult(header + (args.summary === true ? renderArchiveSummary(r.messages) : renderArchiveMessages(r.messages)), budget);
      return pr.text;
    },
  };
}
