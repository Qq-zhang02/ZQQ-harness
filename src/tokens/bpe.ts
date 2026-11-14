/**
 * 纯 JS 实现的 DeepSeek BPE 分词器（只做编码计数，不解码，零原生依赖）。
 * 从 HuggingFace tokenizer.json 读取 vocab / merges / pre_tokenizer 切分规则，
 * 忠实复刻 HF fast tokenizer 的编码流程：
 *   文本 → 逐条 Split 规则切分（Isolated 行为，匹配段独立成片）
 *        → ByteLevel 字节映射（UTF-8 字节 → GPT-2 风格可见字符）
 *        → 每个片段 BPE 合并（按 merges 优先级）→ 片段数即 token 数。
 * 特殊 token（<｜begin▁of▁sentence｜> 等）按普通文本处理：它们由服务端
 * chat 模板注入，产生的开销归入用量明细的“其他”，不参与正文计数。
 */
import { readFileSync } from "node:fs";

export interface Tokenizer {
  /** 返回文本的 token 数 */
  count(text: string): number;
}

interface TokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    merges: string[];
  };
  pre_tokenizer?: {
    type: string;
    pretokenizers?: Array<{
      type: string;
      behavior?: string;
      pattern?: { Regex?: string };
    }>;
  };
}

/** GPT-2 风格字节→可见字符映射：可打印字节映射到自身，其余按序映射到 256+ 区，返回按字节值索引的表。 */
function bytesToUnicode(): string[] {
  const table = new Array<string>(256).fill("");
  for (let b = 33; b < 127; b++) table[b] = String.fromCharCode(b);
  for (let b = 161; b < 173; b++) table[b] = String.fromCharCode(b);
  for (let b = 174; b < 256; b++) table[b] = String.fromCharCode(b);
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!table[b]) table[b] = String.fromCharCode(256 + n++);
  }
  return table;
}

/** 对已有片段逐个应用一条切分正则：匹配段独立保留（Isolated），其余按间隙切开。 */
function splitBy(pieces: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const p of pieces) {
    let last = 0;
    for (const m of p.matchAll(re)) {
      const i = m.index ?? 0;
      const text = m[0];
      if (!text) continue; // 防零长匹配死循环
      if (i > last) out.push(p.slice(last, i));
      out.push(text);
      last = i + text.length;
    }
    if (last < p.length) out.push(p.slice(last));
  }
  return out;
}

/**
 * 加载 tokenizer.json。只依赖 model.vocab / model.merges 与
 * pre_tokenizer 中的 Split+Regex+Isolated 规则（DeepSeek v4 即此配置）。
 */
export function loadTokenizer(jsonPath: string): Tokenizer {
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as TokenizerJson;
  if (raw.model?.type !== "BPE" || !raw.model.vocab || !Array.isArray(raw.model.merges)) {
    throw new Error("不支持的 tokenizer 格式（需要 BPE 模型）");
  }
  const ranks = new Map<string, number>();
  raw.model.merges.forEach((m, i) => ranks.set(m, i));

  const rules: RegExp[] = [];
  for (const pt of raw.pre_tokenizer?.pretokenizers ?? []) {
    if (pt.type === "Split" && pt.behavior === "Isolated" && pt.pattern?.Regex) {
      rules.push(new RegExp(pt.pattern.Regex, "gu"));
    }
  }

  const byteEnc = bytesToUnicode();
  const encoder = new TextEncoder();
  const mapBytes = (s: string): string => {
    let out = "";
    for (const b of encoder.encode(s)) out += byteEnc[b];
    return out;
  };

  // 片段级缓存：BPE 结果按映射后片段复用（词级重复率极高）
  const pieceCache = new Map<string, number>();
  const bpeCount = (mapped: string): number => {
    const hit = pieceCache.get(mapped);
    if (hit !== undefined) return hit;
    const parts: string[] = [...mapped];
    while (parts.length > 1) {
      let bestRank = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        // merges 条目形如 "a b"（字节映射保证 token 内不含空格，空格分隔无歧义）
        const r = ranks.get(parts[i] + " " + parts[i + 1]);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const merged = parts[bestIdx] + parts[bestIdx + 1];
      parts.splice(bestIdx, 2, merged);
    }
    const n = parts.length;
    if (pieceCache.size >= 65536) pieceCache.clear();
    pieceCache.set(mapped, n);
    return n;
  };

  return {
    count(text: string): number {
      if (!text) return 0;
      let pieces = [text];
      for (const re of rules) pieces = splitBy(pieces, re);
      let total = 0;
      for (const p of pieces) {
        if (!p) continue;
        total += bpeCount(mapBytes(p));
      }
      return total;
    },
  };
}
