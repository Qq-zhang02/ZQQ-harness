/**
 * tools.list-files 模块：list_files 工具（docs/32 协调者直用只读目录清单）的注册入口。
 * audience="coordinator"——协调者结构性无实质工具的红线只为只读查询开了两件（subagent_status
 * 状态表 + 本工具）：子代理写文件，协调者只看文件名核对结构与验收产出落点；普通会话与
 * 子代理有 run_pwsh 的 Get-ChildItem 可用，不重复注册。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createListFilesTool } from "./list-files.ts";

const listFilesDef: SystemToolDef = {
  name: "list_files",
  summary: "列出工作区内某个目录的文件与子目录名（只读、不含内容、不递归；核对结构与验收产出落点用，深入子目录再对它调用）",
  audience: "coordinator",
  create: createListFilesTool,
};

export const toolListFiles: HarnessModule = {
  name: "tools.list-files",
  setup(ctx) {
    ctx.tools.register(listFilesDef);
  },
};
