/**
 * 子代理家族七件套之七：唤醒简报与派发附注（docs/42）。历史分析在 core/progress.ts（纯函数），
 * 本文件补上需要 IO 的那一半：
 *   filesChangedSince  写入范围内自某时刻以来被改动的文件（有界扫描）
 *   rehydrateLedger    复活实例的已读台账回填（未变动文件免重读；已变动的不回填——必须先读）
 *   wakeBriefOf        追加任务/唤醒复活时塞在任务书前的系统简报（做到哪 / 谁改了什么 / 看过哪些图）
 *   scopesOverlap / dispatchNoteOf  派发回执附注（同范围已有可唤醒实例、并发占用、近期限流）
 * 背景（真机反馈 docs/42）：唤醒后子代理「不知道做到哪、不知道哪些文件被别的实例改过、编辑自己
 * 建的文件被拒『未读取过』」，协调者「不知道同一范围已有待命/归档实例而另派新实例写同一目录」。
 * 只读 IO + 只写台账：简报不往工作区落任何文件（只读子代理/「只报告」任务同样适用）。
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { THRESHOLDS } from "../config.ts";
import { fileStamp, ledgerKey, type FileLedger } from "../core/file-tools.ts";
import { progressFactsOf } from "../core/progress.ts";
import type { ChatMessage } from "../llm/provider.ts";
import type { SessionRuntime } from "../core/host.ts";

/** 扫描时跳过的目录（依赖/版本库/缓存体量大且与任务产出无关）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".svn", ".hg", ".idea"]);
/** 有界扫描：条目数/深度上限（大工作区不让一次简报扫成千上万个文件）。 */
const SCAN_MAX_ENTRIES = 20_000;
const SCAN_MAX_DEPTH = 12;
/** 简报里逐条列出的上限（超出只报个数——简报是索引不是清单）。 */
const BRIEF_LIST_MAX = 12;

const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

/** 只读子代理的 order 5 系统提示段（docs/42）：结构性约束如实告知——模型一开始就知道自己
 *  没有写入工具，把该落盘的内容写进报告而不是反复试探。 */
export const READONLY_ROLE_SECTION = [
  "本实例为只读模式（协调者派发时设定，不可更改）：你的工具里没有 write_file/edit_file，也没有 MCP 工具；run_pwsh 按只读沙箱执行——写工作区会被系统拒绝，提权申请不生效。",
  "- 你的任务是调查、核对与报告：结论、发现的问题、建议的修改内容全部写进最终报告，不要尝试绕过只读约束。",
  "- 必须落盘才能完成的工作（生成文件、修改代码等）写进报告的「未决问题」，由协调者安排可写实例。",
].join("\n");

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export interface ChangedFiles {
  /** 被改动的文件（相对工作区根，正斜杠；按修改时间倒序） */
  files: Array<{ rel: string; mtimeMs: number }>;
  /** 触到扫描上限（条目过多提前收兵——清单可能不完整） */
  capped: boolean;
}

/**
 * 写入范围（scope 前缀；缺省=整个工作区）内 mtime 晚于 sinceMs 的文件。迭代目录栈 + 条目/深度
 * 上限，跳过依赖与版本库目录；目录不存在静默跳过。mtime 判定的已知偏差：外部进程改回同
 * mtime 会漏检——所以它只用于「简报提醒」与「台账免重读」，写入时的 hash 乐观锁照旧兜底。
 */
export function filesChangedSince(root: string, prefixes: string[] | undefined, sinceMs: number): ChangedFiles {
  const out: ChangedFiles = { files: [], capped: false };
  const roots = (prefixes && prefixes.length > 0 ? prefixes : [""]).map((p) => resolve(root, p));
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (++visited > SCAN_MAX_ENTRIES) {
        out.capped = true;
        return;
      }
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && depth < SCAN_MAX_DEPTH) walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const m = statSync(abs, { throwIfNoEntry: false })?.mtimeMs;
      if (m !== undefined && m > sinceMs) out.files.push({ rel: toRel(root, abs), mtimeMs: m });
    }
  };
  for (const r of roots) walk(r, 0);
  out.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * 已读台账回填（复活/重启唤醒的新实例调用——旧实例的 per-reader 快照随实例消亡，此前编辑
 * 自己建的文件一律被拒「本会话未读取过」，每次唤醒多一轮 read_file）。口径：历史里成功读过/
 * 写过的路径中，**自上次活动以来没变过**（mtime ≤ sinceMs）的按当前内容指纹回填——内容就是
 * 它上次见过的，免重读；**变过的绝不回填**（可能是别的实例改的，必须先 read_file 再写）。
 * 不存在/不可读（二进制、超大）的路径跳过。返回两类清单供简报如实说明。
 */
export function rehydrateLedger(ledger: FileLedger, paths: readonly string[], root: string, sinceMs: number): { seeded: string[]; changed: string[] } {
  const seeded: string[] = [];
  const changed: string[] = [];
  for (const p of paths) {
    const abs = resolve(root, p);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    if (st.mtimeMs > sinceMs) {
      changed.push(p);
      continue;
    }
    const stamp = fileStamp(abs);
    if (stamp === undefined) continue;
    ledger.noteRead(ledgerKey(abs), stamp);
    seeded.push(p);
  }
  return { seeded, changed };
}

/**
 * 唤醒简报（追加任务 / 从存档复活时塞在任务书前）。sinceMs = 上次活动时刻（收尾时间）之后的
 * 磁盘变动即「不是本实例改的」。没有历史进展或没有基准时刻返回 undefined（首派发不造简报）。
 * opts.rehydrate：复活的新实例回填台账；在线待命实例自己的台账完好，不回填（只报变动）。
 * root 为空（会话未绑工作区）返回 undefined——绝不拿空串去扫盘。
 */
export function wakeBriefOf(
  root: string | null | undefined,
  ledger: FileLedger | undefined,
  messages: readonly ChatMessage[],
  sinceMs: number | undefined,
  scope: string[] | undefined,
  opts: { rehydrate: boolean },
): string | undefined {
  // root 缺席（未绑工作区）必须直接返回：空串会被 resolve("") 解析到进程 cwd 去扫盘
  if (sinceMs === undefined || !root) return undefined;
  const f = progressFactsOf(messages);
  if (f.calls === 0) return undefined;
  const lines: string[] = ["[唤醒简报（系统生成——接手前先读，不必再逐个核对文件清单）]"];
  lines.push(
    `你上一段工作的进展：已完成 ${f.done} 个工具调用` +
      (f.written.length > 0 ? `；经文件工具写入 ${f.written.length} 个：${f.written.slice(0, BRIEF_LIST_MAX).join("、")}${f.written.length > BRIEF_LIST_MAX ? " 等" : ""}` : "") +
      (f.lastOkCommand ? `；最后成功的命令：${f.lastOkCommand}` : "") +
      (f.lastText ? `；最后留言：${f.lastText.length > 200 ? `${f.lastText.slice(0, 200)}…` : f.lastText}` : "") + "。",
  );
  const changed = filesChangedSince(root, scope, sinceMs);
  if (changed.files.length === 0) {
    lines.push(`自 ${hhmm(sinceMs)} 以来，你的写入范围内没有文件变动。`);
  } else {
    const shown = changed.files.slice(0, BRIEF_LIST_MAX);
    lines.push(
      `自 ${hhmm(sinceMs)} 以来，你的写入范围内有 ${changed.files.length} 个文件被改动（可能来自协调者、其他子代理或外部进程——动它们之前先读现状，不要凭记忆覆盖）：` +
        shown.map((c) => `\n- ${c.rel}（${hhmm(c.mtimeMs)}）`).join("") +
        (changed.files.length > shown.length ? `\n- …另有 ${changed.files.length - shown.length} 个` : "") +
        (changed.capped ? "（扫描已达上限，清单可能不完整）" : ""),
    );
  }
  const touched = [...f.written, ...f.read];
  if (opts.rehydrate && ledger) {
    const r = rehydrateLedger(ledger, touched, root, sinceMs);
    if (r.seeded.length > 0) lines.push(`你此前读/写过且此后未变的 ${r.seeded.length} 个文件已恢复台账，可直接编辑：${r.seeded.slice(0, BRIEF_LIST_MAX).join("、")}${r.seeded.length > BRIEF_LIST_MAX ? " 等" : ""}。`);
    if (r.changed.length > 0) lines.push(`你此前读/写过、但此后被改动的 ${r.changed.length} 个文件未恢复台账（${r.changed.join("、")}）——写它们之前先 read_file。`);
  }
  if (f.images.length > 0) {
    lines.push(`你此前查看过 ${f.images.length} 张图：${f.images.slice(0, BRIEF_LIST_MAX).join("、")}${f.images.length > BRIEF_LIST_MAX ? " 等" : ""}（图像块仍留在你的上下文里，可直接回看；已被压缩摘要替换或超出图片预算移出的，需要时重新 read_image）。`);
  }
  return lines.join("\n");
}

/** 归一化 scope 前缀（正斜杠、去首尾 ./ 与斜杠、小写——Windows 大小写不敏感）。 */
const normScope = (p: string): string => p.replace(/\\/g, "/").replace(/^(?:\.\/)+|\/+$/g, "").toLowerCase();

/**
 * 两个写入分区是否重叠（目录级前缀：相等或一方是另一方的前缀目录）。
 * 任一方未给 scope（=整个工作区）返回 false：范围不明不提示——旧记录不带 scope，按「整个
 * 工作区」去比会让每次派发都撞上历史记录，提示沦为噪音（宁可漏报不可误报）。
 */
export function scopesOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  const as = a.map(normScope);
  const bs = b.map(normScope);
  return as.some((x) => bs.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

const LIMIT_LABEL = { rate: "速率限制", cap: "用量上限" } as const;

/**
 * 派发回执附注（docs/42）：①同范围已有可唤醒实例（待命/归档且有过程存档）——接续它的工作优先
 * agent_followup 唤醒，不要另派新实例写同一目录；②当前并发占用；③本会话近期提供方限流。
 * 只提醒不拦截：是否属于「同一工作的接续」只有协调者知道。
 */
export function dispatchNoteOf(rt: SessionRuntime, scope: string[] | undefined): string | undefined {
  const parts: string[] = [];
  const overlaps = rt.subagents.filter(
    (r) => (r.state === "idle" || r.state === "archived") && !!r.transcript && scopesOverlap(r.scope, scope),
  );
  if (overlaps.length > 0) {
    const names = overlaps.slice(-3).map((r) => `${r.name}#${r.subId}（${r.state === "idle" ? "空闲待命" : "已归档"}，有过程存档）`).join("、");
    parts.push(
      `⚠ 写入范围重叠：本会话已有同范围的子代理 ${names}——若这是接续它的工作，优先用 agent_followup（按 subId）唤醒它而非新派；` +
        "坚持新派请先确认原实例已归档或已停止，并在任务书里要求新实例「接手前先读现状，不要覆盖已有改动」。",
    );
  }
  parts.push(`（当前运行中子代理 ${rt.workers.size}/${THRESHOLDS.subagentMaxConcurrent}）`);
  const limits = rt.subagentLimits ?? [];
  if (limits.length > 0) {
    const last = limits[limits.length - 1]!;
    const rates = limits.filter((l) => l.kind === "rate").length;
    parts.push(
      `⚠ 本会话近期发生提供方限流 ${limits.length} 次（最近 ${hhmm(last.at)}：${LIMIT_LABEL[last.kind]}）` +
        (rates > 0 ? "——速率限制说明并发请求过密：调小 subagentMaxConcurrent 或改串行推进，稍候再派" : "——用量上限须等额度重置，重试无益") + "。",
    );
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
