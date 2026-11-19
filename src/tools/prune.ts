/**
 * 工具结果统一修剪（toolResultPruner）：在注册表层对全部工具生效。
 * docs/10 R2：只保留头部——超预算即截为「预算内头部 + 省略标记」，不再保留尾部；
 * 传入 spill 目录时触发修剪即全文落盘（无门槛），入模型文本附检索提示（模型有 pwsh，
 * 可用 Get-Content / Select-String 按需读取）。按 UTF-16 码元切，切点回退到最近完整码点
 * （不把代理对劈成孤立代理项）。
 * docs/40 阶段二：新增头+尾保留模式（opts.tailChars > 0）——尾部 capped 到预算的 1/4
 * （防尾部挤占头部）。适用场景 = 消费方尾部是「最新上下文」而非日志残余：压缩摘要输入
 * （session-runtime summarize，尾部最接近保留工作集）；工具输出路径不传该选项、行为不变。
 * 落盘 best-effort：写盘失败退回纯头部截断，不报错——成功的工具调用不能因为存档失败
 * 变成错误。
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PruneResult {
  /** 入模型 history 的文本（修剪后 + 可能的 spill 引用） */
  text: string;
  /** 被剪掉的字符数（未修剪为 0） */
  prunedChars: number;
  /** 触发落盘时的全文文件路径 */
  spilled?: string;
}

/** 头+尾保留模式的选项（docs/40）：tailChars = 尾部保留字符数（实际取 min(该值, 预算/4)）。 */
export interface PruneOptions {
  tailChars?: number;
}

/** 把 UTF-16 切点回退到完整码点边界：index 落在低代理项上（前一项是高代理项）时回退一格。 */
function codePointBoundary(text: string, index: number): number {
  if (
    index > 0 &&
    index < text.length &&
    text.charCodeAt(index) >= 0xdc00 &&
    text.charCodeAt(index) <= 0xdfff &&
    text.charCodeAt(index - 1) >= 0xd800 &&
    text.charCodeAt(index - 1) <= 0xdbff
  ) {
    return index - 1;
  }
  return index;
}

/** spill 目录里的下一个文件序号（已有 1.txt/2.txt → 3）。 */
function nextSpillIndex(dir: string): number {
  try {
    let max = 0;
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.txt$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * 修剪工具结果到 budgetChars 预算（缺省只保留头部；opts.tailChars > 0 时头+尾保留，
 * 中段以省略标记衔接）。spill 传入 { dir } 时，触发修剪即把全文写入 <dir>/<n>.txt 并在
 * 文本尾部附检索提示（docs/10：不再有落盘门槛——已触发修剪就落盘，磁盘成本远小于
 * 中段信息损失）。
 */
export function pruneToolResult(text: string, budgetChars: number, spill?: { dir: string }, opts?: PruneOptions): PruneResult {
  if (text.length <= budgetChars) return { text, prunedChars: 0 };

  const total = text.length;
  // 预算过小（连标记都放不下头部）：整体丢弃，只保留说明
  if (budgetChars < 64) {
    return { text: `[工具输出共 ${total} 字符，超出预算 ${budgetChars}，已整体丢弃]`, prunedChars: total };
  }

  let spilled: string | undefined;
  if (spill) {
    try {
      mkdirSync(spill.dir, { recursive: true });
      const file = join(spill.dir, `${nextSpillIndex(spill.dir)}.txt`);
      writeFileSync(file, text, "utf8");
      spilled = file;
    } catch {
      // best-effort：写盘失败退回纯头部截断，不报错
    }
  }

  const markerWith = (spillPath?: string) =>
    spillPath === undefined ? "" : `；完整输出已存盘：${spillPath}，可用 Get-Content / Select-String 按需读取`;

  // ---- 头+尾保留模式（docs/40 阶段二）：尾部 capped 预算 1/4；切点均回退完整码点 ----
  const tailKeep = opts?.tailChars !== undefined && opts.tailChars > 0 ? Math.min(Math.floor(opts.tailChars), Math.floor(budgetChars / 4)) : 0;
  if (tailKeep > 0) {
    // 标记长度预留进头部预算（用 160 字符假路径估上界，同纯头部模式的误差口径）
    const markerLen = `\n[中段已省略约 ${total} 字符${markerWith("p".repeat(160))}]\n`.length;
    const headKeep = Math.max(1, budgetChars - tailKeep - markerLen);
    const headCut = codePointBoundary(text, headKeep);
    const tailStart = codePointBoundary(text, total - tailKeep);
    if (tailStart > headCut) {
      const out =
        text.slice(0, headCut) +
        `\n[中段已省略约 ${tailStart - headCut} 字符${markerWith(spilled)}]\n` +
        text.slice(tailStart);
      return { text: out, prunedChars: tailStart - headCut, ...(spilled ? { spilled } : {}) };
    }
    // 防御回退（理论上不可达：total > budget ≥ headKeep+tailKeep+marker）→ 走纯头部
  }

  // ---- 纯头部模式（docs/10 R2 原路径，工具输出消费方不变） ----
  // 标记长度预留进预算（用 160 字符假路径估上界；n 位数误差 ≤ 几个字符）——超长路径时
  // 输出可能超出预算几十字符，对修剪预算（万级）无实际影响
  const markerFor = (n: number, spillPath?: string) =>
    `\n[后文已省略约 ${n} 字符${markerWith(spillPath)}]`;
  const head = codePointBoundary(text, Math.max(1, budgetChars - markerFor(total, "p".repeat(160)).length));
  const out = text.slice(0, head) + markerFor(total - head, spilled);
  return { text: out, prunedChars: total - head, ...(spilled ? { spilled } : {}) };
}
