/**
 * 系统文件工具（read_file/write_file/edit_file）的共享机制（core 层：机制在此，
 * 注册在 modules/tools/*——模块间不可互采，三工具的公共逻辑只能下沉）。
 * 与 run_pwsh 的裁决差异（有意为之）：文件工具对"写"是路径级直接裁决——
 * 工作区内 + workspace-write 直接写；区外或 read-only 直接弹审批（pwsh 是先被
 * OS 沙箱拒绝、模型带 justification 升级再审批）。信任边界等价，少一轮往返；
 * 审批复用 approval/types.ts 的封闭决策词汇与 fail-closed 语义。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { isInsideWorkspace } from "../workspace.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.ts";
import type { SandboxMode } from "../sandbox/types.ts";

// ---------- 路径 ----------

export interface ResolvedTarget {
  abs: string;
  inside: boolean;
}

/** 相对路径按工作区根解析，绝对路径原样采纳；空串报错。返回绝对路径与是否落在工作区内。 */
export function resolveTarget(root: string, raw: string): ResolvedTarget {
  const p = raw.trim();
  if (!p) throw new Error("path 不能为空");
  const abs = normalize(isAbsolute(p) ? resolve(p) : resolve(root, p));
  return { abs, inside: isInsideWorkspace(root, abs) };
}

/**
 * 已读台账的键（write_file 覆写已有文件 / edit_file 编辑前必须先 read_file）。
 * Windows 文件系统大小写不敏感，键统一小写避免"读了没记上"。
 */
export function ledgerKey(abs: string): string {
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

// ---------- 已读台账（docs/5 §5.3：hash 乐观锁，防并行 worker 的 lost update） ----------

/**
 * 会话级已读台账：记「读取时的内容指纹」。协调者会话与它派出的全部 worker
 * 共享同一实例——兄弟 worker 的写入会更新指纹，另一个 worker 手里的旧快照立即失效。
 */
export interface FileLedger {
  /** read_file 成功 / 文件工具写入成功后记录（stamp = 当时内容指纹） */
  noteRead(key: string, stamp: string): void;
  /** 写入前校验用：台账里最新记录的内容指纹；从未读过为 undefined */
  readStamp(key: string): string | undefined;
  /** 本会话（含全部共享 worker）是否读过该文件（v1 语义：先读后写的前置凭据） */
  wasRead(key: string): boolean;
}

export function createFileLedger(): FileLedger {
  const stamps = new Map<string, string>();
  return {
    noteRead: (key, stamp) => void stamps.set(key, stamp),
    readStamp: (key) => stamps.get(key),
    wasRead: (key) => stamps.has(key),
  };
}

/**
 * per-reader 乐观锁视图（docs/5 §5.3 的实现口径）：写入校验比对的必须是「本 reader
 * 上次看到的内容指纹」，而不是台账里的最新值——共享单值台账下兄弟 worker A 写入并
 * 更新指纹后，B 校验时读到的是 A 的新指纹（与磁盘一致），lost update 会漏检。
 * 因此 readStamp 走私有快照（A 的写入碰不到 B 的），noteRead 双写（私有快照 + 共享
 * 凭据：wasRead 语义保持「本会话含全部 worker 读过即可写」）。worker 装配时套一层；
 * 普通会话直接用 createFileLedger() 裸实例（单 reader，私有=共享同体，行为不变）。
 */
export function readerLedger(shared: FileLedger): FileLedger {
  const own = new Map<string, string>();
  return {
    noteRead: (key, stamp) => {
      own.set(key, stamp);
      shared.noteRead(key, stamp);
    },
    readStamp: (key) => own.get(key),
    wasRead: (key) => shared.wasRead(key),
  };
}

/**
 * 写前校验（§5.3 hash 乐观锁 + 先读后写凭据合一）：
 * - 磁盘上没有该文件 → 放行（新建；外部删除后写回=重建）；
 * - 存在但本 reader 从未读过（expected=undefined）→ 拒（防凭想象覆写）；
 * - 存在但内容指纹 ≠ 本 reader 上次所见 → 拒（并行 worker / 外部进程已改——lost update 防线），
 *   文案引导重新 read_file 后基于最新内容重写（模型可自愈，fail-closed 方向）。
 * 读取内容只做一次（peek 复用为指纹来源），5MB/二进制限制与 read_file 同口径。
 */
export type StaleWriteOutcome = { ok: true; exists: boolean } | { ok: false; message: string };

export function staleWriteCheck(abs: string, key: string, ledger: FileLedger, verb: "写入" | "编辑"): StaleWriteOutcome {
  const peek = readTextFile(abs);
  if (!peek.ok) {
    if (peek.message.startsWith("文件不存在")) return { ok: true, exists: false };
    return { ok: false, message: `错误：${abs} 已存在且不适用本工具（${peek.message}）。请改用 run_pwsh 处理该目标。` };
  }
  const expected = ledger.readStamp(key);
  if (expected === undefined) {
    return {
      ok: false,
      message: `错误：${abs} 已存在且本会话未读取过。为防止覆盖已有内容，请先 read_file 该文件，再决定是否${verb}。`,
    };
  }
  if (expected !== stampOfText(peek.text)) {
    return {
      ok: false,
      message:
        `错误：${abs} 在你读取之后已被修改（可能是并行的另一个子代理或外部进程），本次${verb}被拒绝以免覆盖他人工作。` +
        "请重新 read_file 后基于最新内容重写。",
    };
  }
  return { ok: true, exists: true };
}

/** 文本内容的指纹（SHA-1 hex）。与 fileStamp 同口径：UTF-8 编码字节。 */
export function stampOfText(text: string): string {
  return createHash("sha1").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * 磁盘上文件当前内容的指纹（SHA-1 hex）。文件三工具本就限制 ≤5MB 文本，成本可控；
 * 不用 mtime——外部进程改回同 mtime 会漏检。文件不存在/不可读返回 undefined。
 */
export function fileStamp(abs: string): string | undefined {
  try {
    return stampOfText(readFileSync(abs, "utf8"));
  } catch {
    return undefined;
  }
}

// ---------- 换行（Windows CRLF 透明处理） ----------

export type Eol = "\r\n" | "\n";

/** 文件的既有换行风格（含任一 CRLF 即视为 CRLF 文件）。 */
export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** 把 LF 世界的内容按目标风格落盘（入参必须是已归一的 LF 文本）。 */
export function applyEol(textLf: string, eol: Eol): string {
  return eol === "\r\n" ? textLf.replace(/\n/g, "\r\n") : textLf;
}

// ---------- 读取 ----------

export type ReadOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string };

/** 文本文件读取上限（docs/21 §2.2-⑥）：file-tools 与 read-file 工具共用的单一出处
 *  （此前两处各自写死 5MB，会漂移）；错误文案经 maxBytes 动态拼接。 */
/** 文件三工具的适用文件大小边界（阶段 B 第二批阈值键 textFileMaxBytes——config.ts 单一
 *  出处，initConfig 热重绑；此处 re-export 供既有 import 路径不变）。 */
export { TEXT_FILE_MAX_BYTES } from "../config.ts";
import { TEXT_FILE_MAX_BYTES } from "../config.ts";

/** 读一个文本文件（UTF-8）：不存在/目录/超大/疑似二进制都返回可读错误，不抛异常。 */
export function readTextFile(abs: string, maxBytes = TEXT_FILE_MAX_BYTES): ReadOutcome {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, message: `文件不存在：${abs}` };
  }
  if (st.isDirectory()) return { ok: false, message: `这是一个目录，不是文件：${abs}` };
  if (st.size > maxBytes) {
    return { ok: false, message: `文件过大（${st.size} 字节 > 上限 ${maxBytes}），请用 run_pwsh 处理` };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (e) {
    return { ok: false, message: `读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (buf[i] === 0) return { ok: false, message: "疑似二进制文件，本工具不支持（请用 run_pwsh）" };
  }
  return { ok: true, text: buf.toString("utf8") };
}

/** 原子写：先写同目录 .tmp 再 rename 替换，进程崩在半路也不会留下半个新文件。 */
export function writeTextAtomic(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}

// ---------- 精确编辑（LF 世界内匹配，写回时还原文件既有换行风格） ----------

export type EditOutcome =
  | { ok: true; content: string; count: number }
  | { ok: false; message: string };

/**
 * 精确替换。old_string 多次命中时的三种消歧方式：
 * - 纳入更多上下文使 old_string 唯一（首选）；
 * - `occurrence`（1 起始）指定替换第几处——文档中不同位置内容相同时用它定位
 *   （配合 read_file 的行号输出数清次序）；与 replace_all 互斥；
 * - `replace_all=true` 全部替换。
 */
export function applyEdit(
  raw: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  occurrence?: number,
): EditOutcome {
  if (!oldStr) return { ok: false, message: "old_string 不能为空" };
  if (oldStr === newStr) return { ok: false, message: "old_string 与 new_string 相同，无需编辑" };
  if (occurrence !== undefined && replaceAll) {
    return {
      ok: false,
      message: "replace_all 与 occurrence 不能同时使用（replace_all 是全部替换，occurrence 是只改第几处）。",
    };
  }
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) {
    return { ok: false, message: "occurrence 必须是 ≥1 的整数（指定替换第几处，1 起始）。" };
  }
  const eol = detectEol(raw);
  const content = toLf(raw);
  const needle = toLf(oldStr);
  const parts = content.split(needle);
  const count = parts.length - 1;
  if (count === 0) {
    return {
      ok: false,
      message:
        "old_string 在文件中不存在（需与文件内容逐字符一致，包括缩进与空格；注意 read_file 显示的行号不是内容的一部分）。" +
        "文件可能已被外部修改，请重新 read_file。",
    };
  }
  if (count > 1 && !replaceAll && occurrence === undefined) {
    return {
      ok: false,
      message: `old_string 出现了 ${count} 次。请把更多上下文纳入 old_string 使其唯一，或用 occurrence 指定要替换第几处（1–${count}，配合 read_file 的行号数清次序），或设置 replace_all=true 全部替换。`,
    };
  }
  if (occurrence !== undefined && occurrence > count) {
    return {
      ok: false,
      message: `old_string 只出现了 ${count} 次，occurrence=${occurrence} 超出范围（1–${count}）。`,
    };
  }
  if (occurrence !== undefined) {
    // 第 k 次命中位于 parts[k-1] 与 parts[k] 之间：前半段含前 k-1 次命中原样保留
    const contentLf = parts.slice(0, occurrence).join(needle) + toLf(newStr) + parts.slice(occurrence).join(needle);
    return { ok: true, content: applyEol(contentLf, eol), count: 1 };
  }
  return { ok: true, content: applyEol(parts.join(toLf(newStr)), eol), count };
}

// ---------- 写入裁决（沙箱模式 × 目标位置 × scope 分区 → 直接写或审批） ----------

export interface WriteGateInput {
  toolName: string;
  /** 展示用动词："写入" / "编辑" */
  verb: string;
  abs: string;
  inside: boolean;
  /** scope 判定基准（工作区根；目标 abs 相对它求前缀） */
  workspaceRoot: string;
  /** 子代理写入分区（docs/5 §5.4）：相对工作区根的路径前缀；缺省=整个工作区 */
  writeScope?: string[];
  sandboxMode?: SandboxMode;
  alwaysConfirm?: boolean;
  description?: string;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export type WriteGate = { proceed: true } | { proceed: false; text: string };

/** scope 前缀判定（§5.4）：目标相对工作区根的路径是否落在任一前缀内（目录级前缀匹配，非字符串前缀；Windows 大小写不敏感）。 */
function relInsideScope(rel: string, prefixes: string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(rel);
  return prefixes.some((p) => {
    const b = norm(p);
    return b === "" || b === "." ? true : r === b || r.startsWith(b + "/");
  });
}

/**
 * 文件写入的裁决矩阵（与 run_pwsh 的信任边界等价）：
 * - scope 分区（若给定）：目标不在前缀内直接硬拒——scope 是协调者派发时的结构性决定，
 *   不是用户审批事项（不弹卡；§5.4），因此它排在一切审批之前（含区外审批）；
 * - 逐条确认（alwaysConfirm）：任何模式都弹卡——批准的是这次写入本身；
 * - danger-full-access：不逐条确认时不弹卡；
 * - workspace-write：工作区内直接写；区外弹审批（等价 pwsh 的"沙箱拒绝→升级→审批"终点）；
 * - read-only：一律弹审批（等价 pwsh 的"拒绝→升级"终点，但一步到位）。
 * 只有 allowed-once 放行且仅限当次；野值/无人值守由 requestApproval 归一 unavailable。
 */
export async function adjudicateWrite(input: WriteGateInput): Promise<WriteGate> {
  if (input.writeScope && input.writeScope.length > 0) {
    const rel = relative(input.workspaceRoot, input.abs);
    if (!relInsideScope(rel, input.writeScope)) {
      return {
        proceed: false,
        text:
          `错误：目标路径不在本子代理的写入范围（scope）内：${input.abs}。允许的前缀：${input.writeScope.join("、")}。` +
          "这是协调者派发时设定的结构性边界——如确需写该位置，请在报告中说明原因，由协调者调整派发或扩大 scope。",
      };
    }
  }
  const mode = input.sandboxMode ?? "workspace-write";
  const reasons: string[] = [];
  if (!input.inside) reasons.push(`目标路径在工作区外：${input.abs}`);
  if (mode === "read-only") reasons.push("当前沙箱模式为 read-only（只读），文件写入需要批准");

  const needAsk =
    input.alwaysConfirm === true ||
    (mode === "read-only" ? true : mode === "workspace-write" ? !input.inside : false);
  if (!needAsk) return { proceed: true };
  if (reasons.length === 0) reasons.push("（逐条确认模式已开启）");

  const decision = await input.requestApproval({
    toolName: input.toolName,
    command: `${input.verb}：${input.abs}`,
    ...(input.description ? { description: input.description } : {}),
    reasons,
  });
  if (decision === "allowed-once") return { proceed: true };
  switch (decision) {
    case "rejected":
      return {
        proceed: false,
        text:
          "用户拒绝该写入操作。请改用工作区内的路径重新尝试，或先向用户说明为什么需要写这个位置。",
      };
    case "cancelled":
      return { proceed: false, text: "审批等待被取消（用户中断了本轮任务）。文件未改动。" };
    default:
      return {
        proceed: false,
        text: "审批不可用（无人值守模式或审批服务异常），文件未改动。如需写入请让用户退出无人值守模式。",
      };
  }
}
