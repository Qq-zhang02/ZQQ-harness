/**
 * 会话压缩（compaction）：把早期历史物理替换为一段工作状态摘要。
 * 与 DSH 的刻意取舍：不引入事件溯源日志（本项目会话已是 JSON 存档，messages = surface，
 * SessionData = 真相），压缩不可逆，靠压缩前的 precompact 备份兜底。
 * fail-safe 方向：宁可压不了不可压坏——任何中间错误都不得破坏 history（会话中毒是本项目踩过的坑）。
 */
import type { ChatMessage } from "./llm/provider.ts";

export interface CompactionRecord {
  /** ISO 时间 */
  at: string;
  /** 压缩时的切点（相对压缩前 history；history[1..cut) 被摘要替换） */
  cutIndex: number;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  /** 被移除的消息条数（不含 system） */
  removedMessages: number;
}

export type CompactOutcome =
  | { ok: true; record: CompactionRecord }
  | { ok: false; reason: string };

/**
 * 轮边界判定：在 i 处切分（history[i..] 保留、history[1..i) 被摘要替换）
 * 不会把 toolCall 与它的 tool 结果拆开（等价于 DSH 的配对平衡）。
 * 规则：history[i] 不得是 tool 结果（工具组中间不可切）；user 消息是安全切点；
 * assistant 切点要求前一条是 user/tool（新一轮开始）。
 * i === history.length 视为合法（全部摘要、无保留尾部，无配对可拆）。
 */
export function isTurnBoundary(history: ChatMessage[], i: number): boolean {
  if (i < 1 || i > history.length) return false;
  if (i === history.length) return true;
  const cur = history[i];
  if (cur.role === "tool") return false; // 工具结果前不可切（上一条要么是 assistant.toolCalls 要么是同组结果）
  if (cur.role === "user") return true;
  // cur 是 assistant：要求新一轮开始（前面是 user 或 tool 组结束）
  const prev = history[i - 1];
  return prev.role === "user" || prev.role === "tool";
}

/**
 * 选切点：保留 history[0]（system）+ 尽量多的尾部完整轮次（尾部 token ≤ keepTokens）。
 * 返回 -1 表示找不到安全切点（无法压缩）。
 * tokenOf 注入（测试用）；生产用 tokens.ts 的 messageTokens（逐消息缓存）。
 */
export function chooseCutIndex(
  history: ChatMessage[],
  keepTokens: number,
  tokenOf: (m: ChatMessage) => number,
): number {
  const n = history.length;
  // suffix[i] = history[i..] 的 token 总量（随 i 递减）
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + tokenOf(history[i]);

  // 在合法边界里找最小的 i（保留最多）且尾部装得进预算；i ≥ 2 保证至少摘要一条消息
  let minBoundary = -1;
  for (let i = 2; i <= n; i++) {
    if (!isTurnBoundary(history, i)) continue;
    if (minBoundary < 0) minBoundary = i;
    if (suffix[i] <= keepTokens) return i;
  }
  // 连最小尾部都超预算（单轮巨大）：退而求其次，压到最早的合法边界（最大化压缩，保证有进展）
  return minBoundary;
}

/** 压缩摘要的专用提示词（不带工具的一次 chat）。 */
export const COMPACTION_PROMPT =
  "把以下 agent 工作历史压缩为工作状态摘要，必须保留：用户目标、已做决定、" +
  "涉及的文件路径与命令、当前进行到哪、未完成事项。输出中文。";

/**
 * 识别"输入超过模型上下文窗口"类错误（openai 400 message 含 context length /
 * maximum context；anthropic 为 prompt is too long；与 finishReason=length 的输出
 * 截断不同，这是输入放不下）。
 */
export function isContextOverflowError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /maximum context length|context length(?: is| exceeded)|prompt is too long|input length exceeds|请求的上下文过长|上下文长度超过/i.test(
    msg,
  );
}
