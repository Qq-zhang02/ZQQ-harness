/**
 * 工具调用的展示信息（docs/28 P2-3，纯逻辑）：折叠行摘要（pwsh=description、读/写/编辑=
 * 动词+文件名）与展开体片段（write=只显示写入内容、edit=红绿 diff、其他=参数 JSON 照旧）。
 * 主对话（chat.js addTool）与子代理时间线（drawer.js makeTimeline）共用——DOM 渲染器在
 * dom.js 的 renderToolBody（消费本模块的片段数据）。全部纯函数，禁 DOM 全局引用
 * （F1 可测性边界，契约测试哨兵锁定，PURE 集合含本文件）。
 */
import { firstLine } from "./autoreport.js";

/** 参数 JSON 解析：非字符串/空/非法 JSON/非对象 → null（调用方走降级展示）。 @param {unknown} raw @returns {Record<string, unknown> | null} */
function parseArgs(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 工具块折叠行的一行摘要（docs/28 需求：展开前只看这句话）。
 * run_pwsh → description（缺省退 command 首行）；read/write/edit_file → 「读取/写入/编辑
 * <路径>」；其他工具（MCP/view_image/…）→ firstLine(fallbackPreview)（现状不变）。
 * 参数不可解析（截断/旧事件缺 args）→ firstLine(fallbackPreview)。
 * @param {string} name 工具名
 * @param {string | undefined} argsRaw 完整参数 JSON（可能缺省/被截断）
 * @param {string | undefined} fallbackPreview 服务端截好的预览（降级数据源）
 * @returns {string}
 */
export function toolHeadline(name, argsRaw, fallbackPreview) {
  const a = parseArgs(argsRaw);
  if (a) {
    const p = typeof a.path === "string" && a.path ? a.path : "";
    if (name === "run_pwsh") {
      const d = typeof a.description === "string" ? a.description.trim() : "";
      if (d) return d;
      const c = typeof a.command === "string" ? a.command : "";
      if (c) return firstLine(c);
    } else if (name === "read_file" && p) {
      const off = Number.isInteger(a.offset) && Number(a.offset) > 1 ? a.offset : null;
      return off ? "读取 " + p + " · 第 " + off + " 行起" : "读取 " + p;
    } else if (name === "write_file" && p) {
      return "写入 " + p;
    } else if (name === "edit_file" && p) {
      return "编辑 " + p;
    }
  }
  return firstLine(String(fallbackPreview ?? ""));
}

/** @typedef {"args" | "note" | "content" | "diff"} ToolBodyKind */
/**
 * @typedef {{ type: "args", text: string }} ArgsBlock 参数 JSON 块（其他工具/降级路径）
 * @typedef {{ type: "note", text: string }} NoteBlock 一行注记（description 等）
 * @typedef {{ type: "content", text: string }} ContentBlock 写入内容块（write_file）
 * @typedef {{ type: "diff", oldText: string, newText: string, note?: string }} DiffBlock 红绿 diff 块（edit_file；note=occurrence/replace_all 注记）
 * @typedef {ArgsBlock | NoteBlock | ContentBlock | DiffBlock} ToolBodyBlock
 */

/**
 * 工具块展开体片段（docs/28 需求：展开才见具体内容）。
 * write_file → [note?, content]（只显示写入内容，不显示参数 JSON）；edit_file → [note?,
 * diff]（old_string 各行红-/new_string 各行绿+，附消歧注记）；其余 → null（调用方按现状
 * 渲染 prettyArgs 参数块）。参数不可解析 → null（降级：argsRaw 可能是截断的 preview）。
 * @param {string} name 工具名
 * @param {string | undefined} argsRaw 完整参数 JSON
 * @returns {ToolBodyBlock[] | null}
 */
export function toolBodyBlocks(name, argsRaw) {
  const a = parseArgs(argsRaw);
  if (!a) return null;
  /** @type {ToolBodyBlock[]} */
  const blocks = [];
  const d = typeof a.description === "string" ? a.description.trim() : "";
  if (name === "write_file" && typeof a.content === "string") {
    if (d) blocks.push({ type: "note", text: d });
    blocks.push({ type: "content", text: a.content });
    return blocks;
  }
  if (name === "edit_file" && typeof a.old_string === "string" && typeof a.new_string === "string") {
    if (d) blocks.push({ type: "note", text: d });
    const disambig = [];
    if (a.replace_all === true) disambig.push("replace_all：全部替换");
    else if (Number.isInteger(a.occurrence) && Number(a.occurrence) > 0) disambig.push("occurrence=" + a.occurrence + "：第 " + a.occurrence + " 处");
    blocks.push({
      type: "diff",
      oldText: a.old_string,
      newText: a.new_string,
      ...(disambig.length ? { note: disambig.join(" · ") } : {}),
    });
    return blocks;
  }
  return null;
}
