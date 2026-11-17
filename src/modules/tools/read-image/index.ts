/**
 * tools.read-image 模块：read_image 工具（docs/34 视觉会话直读图片）的注册入口。
 * audience 缺省 worker——普通会话与子代理都注册（与 read_file 同受众；子代理与父会话
 * 同提供方，selfVision 同源）；协调者不注册（无文件直用工具红线不变）。
 * 与 view_image 互补：read_image=模型有视觉时原生看图（图像块进对话）；view_image=
 * 借视觉模型出文字描述（无视觉主模型也能用）。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createReadImageTool } from "./read-image.ts";

const readImageDef: SystemToolDef = {
  name: "read_image",
  summary: "直接读取工作区图片文件作为图像块进入对话（视觉会话专用——下一轮原生看到图，每轮持续占视觉 token，勿重复读同一张；无视觉模型被拒，改用 view_image 借视觉模型）",
  create: createReadImageTool,
};

export const toolReadImage: HarnessModule = {
  name: "tools.read-image",
  setup(ctx) {
    ctx.tools.register(readImageDef);
  },
};
