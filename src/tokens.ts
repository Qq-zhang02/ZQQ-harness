/**
 * Token 用量统计：优先用项目内assets的 DeepSeek v4 tokenizer（纯 JS BPE）
 * 对各分类做真实计数；tokenizer 资产缺失/加载失败时回退到 DeepSeek 官方
 * 字符换算比例（1 中文字符 ≈ 0.6 token，1 英文字符 ≈ 0.3 token）。
 * API 的 usage 只返回整次请求的 prompt_tokens 等总量，六类拆分在本地按
 * 请求内容计算，与实际总量的差（角色标记、chat 模板包装等）归入“其他”，
 * 六类合计恒等于实际总量。总量一律以模型返回的 usage 为准：单次请求经
 * withOther 校准；上下文总量（Agent.contextEstimate）锚定最近一次实测
 * usage、本地估算只补其后新增部分（usageAnchor，见 agent.ts）。
 */
import { fileURLToPath } from "node:url";
import { loadTokenizer, type Tokenizer } from "./tokens/bpe.ts";
import type { ChatMessage, ToolSchema, UsageBreakdown } from "./llm/provider.ts";
import { skillListText, type SkillInfo } from "./core/skills.ts";
import { MCP_TOOL_PREFIX } from "./core/types.ts";

const TOKENIZER_JSON = fileURLToPath(
  new URL("../assets/deepseek_v4_tokenizer/tokenizer.json", import.meta.url),
);

// ---- 分词器：首次使用时懒加载；加载失败永久回退启发式 ----
let bpe: Tokenizer | null | undefined;

function getBpe(): Tokenizer | null {
  if (bpe !== undefined) return bpe;
  try {
    bpe = loadTokenizer(TOKENIZER_JSON);
  } catch (e) {
    bpe = null;
    console.warn(
      `[tokens] tokenizer 加载失败，回退字符估算：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return bpe;
}

// ---- 启发式回退：DeepSeek 官方换算比例 ----
const CJK_TOKEN_PER_CHAR = 0.6;
const OTHER_TOKEN_PER_CHAR = 0.3;
const MESSAGE_FRAME_TOKENS = 4;

/** 单张图片的 token 估算（docs/10 R3；阶段 B 第二批阈值键 imageTokenEst）：各 vision API 按
 *  分辨率 tiles 计量且规则互不相同，本地无法真实分词——按典型中档分辨率固定估算，与实际计量的
 *  差由 withOther 归入 other（六类合计=实际输入的不变量保持）。config.ts 单一出处（initConfig
 *  热重绑，换视觉模型后可校准），此处 re-export 供既有 import 路径不变。 */
export { IMAGE_TOKEN_EST } from "./config.ts";
import { IMAGE_TOKEN_EST } from "./config.ts";

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0xff00 && cp <= 0xffef) // 全角符号
  );
}

/** 字符换算回退实现（tokenizer 资产缺失时使用）。 */
export function estTokensHeuristic(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * CJK_TOKEN_PER_CHAR + other * OTHER_TOKEN_PER_CHAR);
}

// ---- 真实计数入口：整串缓存（历史消息/工具 schema 每轮重复发送，命中率高） ----
const countCache = new Map<string, number>();
const CACHE_MAX = 2048;

export function estTokens(s: string): number {
  if (!s) return 0;
  const hit = countCache.get(s);
  if (hit !== undefined) return hit;
  const t = getBpe();
  const n = t ? t.count(s) : estTokensHeuristic(s);
  if (countCache.size >= CACHE_MAX) countCache.clear();
  countCache.set(s, n);
  return n;
}

/** 不带缓存的逐消息计数（消息正文 + 工具调用参数 + 角色框架开销 + 图片固定估算；
 *  passbackThinking 时计入思考回传文本）。count 可注入（测试用）。 */
export function messageTokenCount(m: ChatMessage, count: (s: string) => number, passbackThinking = false): number {
  let n = count(typeof m.content === "string" ? m.content : "");
  if (m.role === "assistant") {
    // ?? []：宽容畸形存档（assistant 消息缺 toolCalls 字段——手改/外部生成的档），
    // docs/28 冒烟实测缺字段会让 contextEstimate 抛 "not iterable" 炸掉会话装载
    for (const tc of m.toolCalls ?? []) n += count(tc.name + tc.arguments);
    if (passbackThinking && m.thinking) n += count(m.thinking.text);
  }
  if (m.role === "user" && m.images) n += m.images.length * IMAGE_TOKEN_EST;
  return n + MESSAGE_FRAME_TOKENS;
}

// ---- 逐消息缓存：history 是 push-only、消息对象不可变，可安全按对象身份缓存 ----
// passback 与 plain 分开缓存：同一消息在开关/档位变化前后会被两种口径计数
const msgTokenCache = new WeakMap<ChatMessage, { plain: number; passback: number }>();

/** 单条消息 token 数（按消息对象身份缓存；system 重建等场景产生新对象自然失效重算）。
 *  passbackThinking=true 按"思考文本回传"口径计数（与回传条件对齐，见 agent.thinkingPassbackOf）。 */
export function messageTokens(m: ChatMessage, count: (s: string) => number = estTokens, passbackThinking = false): number {
  let hit = msgTokenCache.get(m);
  if (!hit) {
    hit = { plain: messageTokenCount(m, count, false), passback: -1 };
    msgTokenCache.set(m, hit);
  }
  if (!passbackThinking) return hit.plain;
  if (hit.passback < 0) hit.passback = messageTokenCount(m, count, true);
  return hit.passback;
}

/** 按请求内容计算输入 token 构成：system 消息拆出技能清单单列，工具 schema 与服务器 instructions 归 MCP，其余归消息。
 *  thinkingPassback 为逐消息回传判定（与 provider 回传条件对齐）；判定为真的 assistant 消息其 thinking.text 计入 messages 分类。 */
export function estimateBreakdown(
  messages: ChatMessage[],
  tools: ToolSchema[],
  skills: SkillInfo[] = [],
  mcpInstructions: string | null = null,
  thinkingPassback?: (m: ChatMessage) => boolean,
): UsageBreakdown {
  const first = messages[0];
  const skillsText = skillListText(skills);
  const bd: UsageBreakdown = {
    systemPrompt: estTokens(first?.role === "system" ? first.content : ""),
    skills: skillsText ? estTokens(skillsText) : 0,
    systemTools: 0,
    mcp: estTokens(mcpInstructions ?? ""), // MCP 分类 = 工具 schema + 服务器注入的使用说明
    messages: 0,
    other: 0,
  };
  bd.systemPrompt = Math.max(0, bd.systemPrompt - bd.skills); // 技能清单是 system 消息的一部分
  for (const t of tools) {
    const n = estTokens(JSON.stringify(t));
    if (t.name.startsWith(MCP_TOOL_PREFIX)) bd.mcp += n;
    else bd.systemTools += n;
  }
  const rest = first?.role === "system" ? messages.slice(1) : messages;
  for (const m of rest) {
    bd.messages += messageTokens(m, estTokens, thinkingPassback?.(m) ?? false); // 逐消息缓存命中，不再全量重算
  }
  return bd;
}

/** 上下文压力 = 预估输入 / 提供方上下文长度，夹到 [0,1]；contextLength 非法时返回 0。 */
export function contextPressure(total: number, contextLength: number): number {
  if (!(contextLength > 0)) return 0;
  return Math.min(1, Math.max(0, total / contextLength));
}

/** 用实际总量校准：估算合计之外的余量（角色标记、chat 模板、分词包装）归入 other（估算偏高时归 0）。 */
export function withOther(usage: { promptTokens: number }, bd: UsageBreakdown): UsageBreakdown {
  const est = bd.systemPrompt + bd.skills + bd.systemTools + bd.mcp + bd.messages;
  return { ...bd, other: Math.max(0, usage.promptTokens - est) };
}

/** 缓存命中率（0-100 整数百分比，命中/输入总量）；无输入或无命中时为 0。 */
export function cacheHitRate(cacheHitTokens: number, promptTokens: number): number {
  if (promptTokens <= 0 || cacheHitTokens <= 0) return 0;
  return Math.min(100, Math.round((cacheHitTokens / promptTokens) * 100));
}
