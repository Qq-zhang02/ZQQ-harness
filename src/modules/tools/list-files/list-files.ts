/**
 * list_files 工具实现（docs/32）：协调者直用的只读目录清单——只看有什么文件，不看内容。
 * 单层列举（不递归）：目录在前、文件在后按名排序；目录名带「/」后缀、符号链接带「@」
 * （不跟随，防环）。条目上限防巨量输出（协调者只需要掌握结构，不是盘点全部文件）。
 * 路径守卫与 read_file 同口径（isInsideWorkspace，只比路径字符串不解符号链接）。
 * 受众 audience="coordinator"：普通会话/子代理用 run_pwsh 的 Get-ChildItem 即可，不重复注册。
 */
import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import { isInsideWorkspace } from "../../../workspace.ts";

/** 单次列举的条目上限（超出截断并标注总数）。 */
const LIST_FILES_MAX_ENTRIES = 500;

export function createListFilesTool(deps: SystemToolDeps): Tool {
  return {
    name: "list_files",
    description:
      "列出工作区内某个目录的文件与子目录名（只读、不含内容、不递归）。用于了解工作区/模块结构、" +
      "验收前核对子代理声称的产出文件是否真实落盘。路径相对工作区根；目录名带「/」后缀、符号链接带「@」。" +
      "要看某个子目录的内容就对它再调用一次本工具。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "可选，相对工作区根的目录路径（缺省列出工作区根）" },
      },
    },
    async execute(args) {
      const root = deps.workspace().root;
      const rel = String(args.path ?? ".").trim() || ".";
      const abs = resolve(root, rel);
      if (!isInsideWorkspace(root, abs)) {
        return `错误：路径 ${rel} 超出工作区边界——只允许查看工作区内的目录（相对路径）。`;
      }
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st) return `错误：目录不存在：${rel}。`;
      if (!st.isDirectory()) {
        return `错误：${rel} 不是目录（它可能是文件——确认文件是否存在看本目录列举里有没有它即可，读内容是子代理的活）。`;
      }
      let dirents: Dirent[];
      try {
        dirents = readdirSync(abs, { withFileTypes: true });
      } catch (e) {
        return `错误：目录无法读取：${e instanceof Error ? e.message : String(e)}`;
      }
      const rank = (d: Dirent): number => (d.isDirectory() ? 0 : 1); // 目录排前
      dirents.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      const total = dirents.length;
      const shown = dirents.slice(0, LIST_FILES_MAX_ENTRIES);
      const lines = shown.map((d) => (d.isDirectory() ? `${d.name}/` : d.isSymbolicLink() ? `${d.name}@` : d.name));
      const head = `目录 ${rel === "." ? "（工作区根）" : rel}：共 ${total} 项${total === 0 ? "（空目录）" : ""}`;
      const tail = total > shown.length ? `\n…（还有 ${total - shown.length} 项未显示）` : "";
      return [head, ...lines].join("\n") + tail;
    },
  };
}
