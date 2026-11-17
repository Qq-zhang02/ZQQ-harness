/**
 * tools.ask-user 模块：ask_user 工具（docs/32 前台询问用户）的注册入口。
 * audience="front"——普通会话与协调者注册；子代理双层防线：registry 三值过滤不注册本工具 +
 * workerDeps 不注入 askUser 接缝（execute 的防御文案兜底）——子代理不确定时自行向协调者
 * 报告（写进报告的未决问题），不直接向用户提问（docs/5 两层架构：协调者是用户的唯一对话面）。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createAskUserTool } from "./ask-user.ts";

const askUserDef: SystemToolDef = {
  name: "ask_user",
  summary:
    "向用户发起选择题询问并等待回答（方向性不确定才用：需求歧义/方案取舍/破坏性操作确认；2~4 个互斥选项，用户可自行输入其它答案；能从上下文推断的不要问）",
  audience: "front",
  create: createAskUserTool,
};

export const toolAskUser: HarnessModule = {
  name: "tools.ask-user",
  setup(ctx) {
    ctx.tools.register(askUserDef);
  },
};
