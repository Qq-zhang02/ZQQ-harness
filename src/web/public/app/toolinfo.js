/**
 * 工具调用的展示信息（docs/28 P2-3，纯逻辑）：折叠行摘要（pwsh=description、读/写/编辑=
 * 动词+文件名）与展开体片段（write=只显示写入内容、edit=红绿 diff、其他=参数 JSON 照旧）。
 * docs/32 真机回归起，新五工具对齐「只显内容」理念：ask_user 折叠头=问题、展开体=问题+选项
 * 列表（回答在结果 tres）；subagent_status / list_files / stop / archive 折叠头=动词+对象、
 * 展开体只留结果（空数组，read_file 同款）。
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
      // 折叠头附 diff 规模标注（真机待办：展开前就能看出"少了几行、多了几行"）——
      // 行数取 old/new 的换行段数（不逐行 diff，规模感足够；replace_all 多处命中时是总行数）
      if (typeof a.old_string === "string" && typeof a.new_string === "string") {
        const rm = a.old_string.split("\n").length;
        const add = a.new_string.split("\n").length;
        return "编辑 " + p + " · +" + add + " -" + rm + " 行";
      }
      return "编辑 " + p;
    } else if (name === "read_image" && typeof a.path === "string" && a.path) {
      return "读图 " + a.path; // docs/34：折叠头=读图+路径（图片本体在结果与对话图像块里）
    } else if (name === "ask_user" && typeof a.question === "string" && a.question.trim()) {
      // docs/32 真机回归：新工具对齐「只显内容」——折叠头=问题本身，不是参数 JSON
      return "提问 " + firstLine(a.question.trim());
    } else if (name === "subagent_status") {
      return a.all === true ? "查看子代理状态表（含历史记录）" : "查看子代理状态表";
    } else if (name === "list_files") {
      return "列目录 " + (p || "工作区根");
    } else if (name === "stop_subagent" || name === "archive_subagent") {
      const label =
        Number.isInteger(a.subId) && Number(a.subId) > 0
          ? "#" + a.subId + (typeof a.name === "string" && a.name ? "（" + a.name + "）" : "")
          : typeof a.name === "string" && a.name
            ? a.name
            : "";
      return (name === "stop_subagent" ? "打断子代理 " : "归档子代理 ") + (label || "（未指定目标）");
    }
  }
  return firstLine(String(fallbackPreview ?? ""));
}

/** @typedef {"args" | "note" | "content" | "diff"} ToolBodyKind */
/**
 * @typedef {{ type: "args", text: string }} ArgsBlock 参数 JSON 块（其他工具/降级路径）
 * @typedef {{ type: "note", text: string }} NoteBlock 一行注记（description 等）
 * @typedef {{ type: "content", text: string, cap?: string }} ContentBlock 内容块（write_file 的写入内容 / run_pwsh 的命令本体；cap=块头说明文字，缺省「写入内容」）
 * @typedef {{ type: "diff", oldText: string, newText: string, note?: string }} DiffBlock 红绿 diff 块（edit_file；note=occurrence/replace_all 注记）
 * @typedef {ArgsBlock | NoteBlock | ContentBlock | DiffBlock} ToolBodyBlock
 */

/**
 * 工具块展开体片段（docs/28 需求 + 真机待办「展示理念统一」：只显示内容/描述/结果这些
 * 重要部分，不显示参数 JSON 格式块）。
 * write_file → [note?, content(cap=写入内容)]；edit_file → [note?, diff]（old_string 各行
 * 红-/new_string 各行绿+，附消歧注记）；run_pwsh → [note?(description), content(cap=命令)]——
 * 展开体=描述+命令本体，不再显示 prettyArgs JSON；read_file → []（空数组=有定义无参数块，
 * 展开体只留结果 tres——读取的内容就在结果里，路径/起始行折叠头已有）；其余 → null
 * （调用方按现状渲染 prettyArgs 参数块）。参数不可解析 → null（降级：argsRaw 可能是截断的 preview）。
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
  // docs/32 真机回归（展示理念统一）：ask_user 展开体=问题+选项列表（回答在结果 tres 里，
  // 不再显示参数 JSON）；subagent_status / list_files / stop / archive 展开体只留结果——
  // 状态表/目录清单/控制结果本身就是内容（read_file 同款空数组语义）
  if (name === "ask_user") {
    const q = typeof a.question === "string" ? a.question : "";
    const opts = Array.isArray(a.options) ? a.options.filter((o) => typeof o === "string" && o.trim()) : [];
    if (!q.trim()) return null; // 缺问题（畸形/截断）→ 降级参数块
    blocks.push({ type: "content", text: q, cap: "问题" });
    if (opts.length > 0) {
      blocks.push({ type: "content", text: opts.map((o, i) => i + 1 + ". " + o).join("\n"), cap: "选项" });
    }
    return blocks;
  }
  if (name === "subagent_status" || name === "list_files" || name === "stop_subagent" || name === "archive_subagent" || name === "read_image") {
    return []; // docs/34：read_image 展开体只留结果说明（图像本体模型侧可见，UI 渲染见已知边界）
  }
  if (name === "run_pwsh") {
    const c = typeof a.command === "string" ? a.command : "";
    if (!c.trim()) return null; // 缺命令（畸形/截断）→ 降级参数块
    if (d) blocks.push({ type: "note", text: d });
    blocks.push({ type: "content", text: c, cap: "命令" });
    return blocks;
  }
  if (name === "read_file") {
    return []; // 展开体只留结果（读取的文件内容在 tres 里）——不显示参数 JSON
  }
  if (name === "write_file" && typeof a.content === "string") {
    if (d) blocks.push({ type: "note", text: d });
    blocks.push({ type: "content", text: a.content }); // cap 缺省「写入内容」（renderToolBody 兜底）
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

/** 失败判定的两个文本特征（项目惯例单一出处）：pwsh 的非零退出码行与全部系统工具/
 *  MCP 控制面共用的「错误：」前缀回传（文件工具/agent_task 校验/子代理控制/manage_mcp/
 *  view_image 等的错误文案一律以「错误：」开头——工具执行错误以字符串回传模型，不抛异常）。
 *  @param {unknown} text 工具结果全文（畸形事件防御：非字符串一律 false）
 *  @returns {boolean}
 */
export function isToolResultError(text) {
  if (typeof text !== "string") return false;
  if (/^错误：/.test(text.trimStart())) return true;
  const m = /exit code: (-?\d+)/.exec(text); // pwsh：非零退出码=失败（unknown/缺失不算数字，不误判）
  return m !== null && m[1] !== "0";
}
