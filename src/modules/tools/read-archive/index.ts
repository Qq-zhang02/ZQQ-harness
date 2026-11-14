/**
 * tools.read-archive 模块：read_archive 工具（docs/17 存档注入）的注册入口。
 * audience 缺省 worker——普通会话与子代理都注册（接续已归档子代理/旧会话的上下文）；
 * 协调者不注册（它无直用工具，D1；接续上下文的消费方是新派发的 worker——协调者只负责
 * 在任务书里指引它调用本工具，转述搬运存档进协调者上下文正是要避免的事）。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createReadArchiveTool } from "./read-archive.ts";

const readArchiveDef: SystemToolDef = {
  name: "read_archive",
  summary: "读取子代理过程存档或主对话记录，把 JSON 转成可读文本注入上下文（接续已归档子代理/旧会话的工作；subId/sessionId 二选一）",
  create: createReadArchiveTool,
};

export const toolReadArchive: HarnessModule = {
  name: "tools.read-archive",
  setup(ctx) {
    ctx.tools.register(readArchiveDef);
  },
};
