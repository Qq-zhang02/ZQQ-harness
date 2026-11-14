import type { Tool } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import { fileStamp, ledgerKey, readTextFile, resolveTarget, toLf, TEXT_FILE_MAX_BYTES } from "../../../core/file-tools.ts";

const DEFAULT_LIMIT = 2000;
const MAX_CHARS = 100_000; // 单次返回上限（注册表修剪之前先自己收口，避免必然被剪的无效传输）

/**
 * read_file：读文本文件（UTF-8），输出带行号（行号是定位辅助，不是文件内容——编辑时
 * old_string 不要带行号）。CRLF 文件按 LF 展示，模型编辑时无需关心 \r。
 * 成功读取记入会话已读台账：是 write_file 覆写已有文件与 edit_file 的前置要求。
 */
export function createReadFileTool(deps: SystemToolDeps): Tool {
  return {
    name: "read_file",
    description:
      "读取一个文本文件的内容（UTF-8），输出带行号，可用 offset/limit 分段读取大文件。" +
      "成功读取会记入本会话的已读台账——覆写已有文件（write_file）或精确编辑（edit_file）前必须先读。" +
      `不支持目录、二进制文件与超过 ${TEXT_FILE_MAX_BYTES / 1024 / 1024}MB 的文件（那些用 run_pwsh）。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区根，或绝对路径）" },
        offset: { type: "integer", description: "可选，起始行号（1 起，默认 1）" },
        limit: { type: "integer", description: `可选，读取行数（默认 ${DEFAULT_LIMIT}）` },
      },
      required: ["path"],
    },
    async execute(args) {
      let abs: string;
      try {
        abs = resolveTarget(deps.workspace().root, String(args.path ?? "")).abs;
      } catch (e) {
        return `错误：${e instanceof Error ? e.message : String(e)}`;
      }
      const r = readTextFile(abs);
      if (!r.ok) return `错误：${r.message}`;
      const lines = toLf(r.text).split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // 结尾换行不产生第 N+1 空行
      if (lines.length === 1 && lines[0] === "") return `${abs}（空文件，共 0 行）`;
      const total = lines.length;

      const offset = Math.max(1, Math.floor(Number(args.offset ?? 1)) || 1);
      if (offset > total) return `错误：offset=${offset} 超出总行数 ${total}`;
      const limit = Math.max(1, Math.floor(Number(args.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT);
      const shown = lines.slice(offset - 1, offset - 1 + limit);

      let out = "";
      let used = 0;
      let cutAt = -1; // 超过单次字符上限时截断到的行数
      for (let i = 0; i < shown.length; i++) {
        const line = `${offset + i}\t${shown[i]}`;
        if (used + line.length > MAX_CHARS && i > 0) {
          cutAt = i;
          break;
        }
        out += line + "\n";
        used += line.length + 1;
      }
      const shownCount = cutAt >= 0 ? cutAt : shown.length;
      const head = `${abs}（共 ${total} 行；显示第 ${offset}–${offset + shownCount - 1} 行）`;
      const notes: string[] = [];
      if (cutAt >= 0) notes.push(`单次返回达到字符上限，已截断——用 offset=${offset + cutAt} 续读`);
      if (offset + shownCount - 1 < total && cutAt < 0) notes.push(`还有后续行——用 offset=${offset + shownCount} 续读`);
      // 台账记内容指纹（hash 乐观锁）：并行 worker 场景下写入前校验"读取之后是否被改"的凭据
      deps.ledger.noteRead(ledgerKey(abs), fileStamp(abs) ?? "");
      return (notes.length > 0 ? `${head}。${notes.join("；")}。\n` : head + "\n") + out;
    },
  };
}
