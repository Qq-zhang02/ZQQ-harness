/**
 * tools.read-file 模块：read_file 系统工具的注册入口。
 * 机制（路径解析/换行归一/二进制嗅探）在 core/file-tools.ts；本模块只做参数解析与输出格式。
 * 每次成功读取都记入会话已读台账（SystemToolDeps.noteFileRead）——write_file 覆写已有
 * 文件、edit_file 编辑的前置凭据，三个文件工具共用这条会话级契约。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createReadFileTool } from "./read-file.ts";

const def: SystemToolDef = {
  name: "read_file",
  summary: "读取文本文件内容（带行号，支持行区间）",
  create: createReadFileTool,
};

export const toolReadFile: HarnessModule = {
  name: "tools.read-file",
  setup(ctx) {
    ctx.tools.register(def);
  },
};
