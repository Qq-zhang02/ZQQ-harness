/**
 * read_archive 工具实现（docs/17 存档注入）：把子代理过程存档 / 主对话会话档读回并渲染成
 * 可读纯文本注入上下文（不直接读 JSON——「给模型发信息」而非转储语法噪音）。存档解析与
 * IO 在 deps.archiveSource 接缝（web/subagents.ts archiveSourceOf，主会话与全部 worker
 * 同一实现）；本模块只做参数校验、渲染与预算截断。
 */
import { ARCHIVE_RENDER_MAX_CHARS } from "../../../config.ts";
import type { ChatMessage } from "../../../llm/provider.ts";
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

/** read_archive：存档注入（docs/17）。subId（本会话子代理过程存档）/ sessionId（主对话
 *  记录）二选一；都不给时返回可用存档清单自纠错（清单来自 deps.archiveSource）。渲染
 *  文本超出 archiveRenderMaxChars 预算截为头部 + 省略标记（pruneToolResult 同款；不 spill
 *  ——存档全文本就在盘上，缺什么再读什么）。 */
export function createReadArchiveTool(deps: SystemToolDeps): Tool {
  return {
    name: "read_archive",
    description:
      "读取一份历史存档，把其中的对话与操作过程转成可读文本注入本代理的上下文（不是直接读 JSON 原文）。两种来源二选一：" +
      "subId=本会话某个子代理的过程存档（接续已被归档/失效子代理的工作——任务书指定的 subId）；" +
      "sessionId=另一段主对话的完整记录（接续旧会话的工作）。读完后按存档里的进展继续当前任务，" +
      "不要重复存档里已完成的工作。",
    parameters: {
      type: "object",
      properties: {
        subId: { type: "integer", description: "本会话子代理序号（报告/[[过程档案#N]] 标注里的 #N）——读它的全程过程存档" },
        sessionId: { type: "string", description: "主对话会话 id（UUID，会话列表里那条对话）——读它的完整历史记录" },
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
      const header =
        `存档注入 · ${r.label} · 共 ${r.messages.length} 条消息\n` +
        "（以下是该段历史的过程回放，供接续上下文；运行中子代理的快照截至其最近一次任务结束）\n\n";
      const pr = pruneToolResult(header + renderArchiveMessages(r.messages), ARCHIVE_RENDER_MAX_CHARS);
      return pr.text;
    },
  };
}
