/**
 * tools.agent-task 模块：agent_task（SA1，单个非阻塞派发；docs/15 起为唯一派发通道——
 * 并行 = 协调者同一轮发多个 agent_task 调用，工具循环并行执行；agent_tasks 批量工具
 * 已退役；docs/16 起派发即返回、报告自动送达）系统工具的注册入口；docs/9
 * agent_followup（向空闲待命的可复用子代理追加任务）与 archive_subagent（归档可复用
 * 子代理）；docs/18：暂停/恢复机制退役——pause/resume_subagent 两件由 stop_subagent
 * （打断即终结：一次性随之归档、可复用转待命）一件取代。audience="coordinator"——
 * 只在协调者会话注册（createRuntime 按 rt.kind 过滤，docs/5 D1）；worker 的 registry
 * 不含它们 → 结构性禁止嵌套派发（D6）。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { createAgentFollowupTool, createAgentTaskTool, createArchiveSubagentTool, createStopSubagentTool } from "./agent-task.ts";

const agentTaskDef: SystemToolDef = {
  name: "agent_task",
  summary: "派出一个子代理独立完成一项任务，立即返回派发回执（非阻塞；报告完成后自动送达。reusable=true 可复用；同一轮发多个本调用即并行派发，协调者核心派发工具）",
  audience: "coordinator",
  create: createAgentTaskTool,
};

const agentFollowupDef: SystemToolDef = {
  name: "agent_followup",
  summary: "向一个空闲待命的可复用子代理追加新任务，立即返回派发回执（非阻塞；它保留之前任务的全部上下文，按 name 或 subId 寻址）",
  audience: "coordinator",
  create: createAgentFollowupTool,
};

const archiveSubagentDef: SystemToolDef = {
  name: "archive_subagent",
  summary: "归档一个可复用子代理（归档后仅可查看存档，不可再派任务；执行中归档会先中止当前任务）",
  audience: "coordinator",
  create: createArchiveSubagentTool,
};

const stopSubagentDef: SystemToolDef = {
  name: "stop_subagent",
  summary: "打断一个运行中子代理的当前任务（立即中止请求/工具执行；一次性随之归档、可复用转空闲待命，无恢复机制；按 name 或 subId 匹配）",
  audience: "coordinator",
  create: createStopSubagentTool,
};

export const toolAgentTask: HarnessModule = {
  name: "tools.agent-task",
  setup(ctx) {
    ctx.tools.register(agentTaskDef);
    ctx.tools.register(agentFollowupDef);
    ctx.tools.register(archiveSubagentDef);
    ctx.tools.register(stopSubagentDef);
  },
};
