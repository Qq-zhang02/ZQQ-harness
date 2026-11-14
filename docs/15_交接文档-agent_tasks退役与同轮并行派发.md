# 交接文档：agent_tasks 退役与同轮并行派发

> **用途**：docs/14 交付后用户要求删除批量派发工具，本文档是结论与交接依据，供新对话无上下文直接执行。惯例同 docs/1-14：`npm run typecheck` + `npm test` 全绿 + 四冒烟全过；改动结论以源码为准。
> **写作基线**：2026-11-14 代码快照（docs/14 完成后 361 项全绿 → 本轮 **360 项全绿 0 skip**：-2 删除的 agent_tasks 工具测试 +1 新增并行执行锁定测试；typecheck 干净；server.ts 248 行零改动）。行号会漂移，**以符号名为准**。
> **铁律**（照抄 docs/7-14）：不破坏 docs/4 §6 不变量清单；server.ts ≤250 行；SSE 事件名零新增；系统提示逐字节确定（golden 显式更新 = 显式决定）；模块之间禁止互相 import。

---

## 0. 需求拆解（用户原话）

> 「协调者的派发多个子代理任务的工具删掉，改为协调者可多次派发单个子代理。」

### 0.1 关键技术点（为什么不是只删工具）

工具循环原本**顺序执行**同轮 tool_calls（`for … await executeWithMeta`）——并行的唯一来源是 agent_tasks 在**一次调用内部** `Promise.all`。直接删掉它 → 协调者同轮发多个 agent_task 会退化为**串行**（子代理 1 完成后才开始子代理 2）——并行能力丢失。定案：**agent.ts 工具循环对协调者会话的同轮多工具调用并行执行**（协调者注册表全是派发/控制类，无顺序依赖；普通会话保持顺序——文件工具有写后读等先后语义）。并行能力由「一次调用内的批量」迁移为「同轮多调用」，用户语义达成：多次派发单个子代理即可并行。

### 0.2 定案总表

| 项 | 定案 |
|---|---|
| 工具删除 | `createAgentTasksTool` 整体删除（agent-task.ts）+ 模块注册删除（index.ts）；协调者 registry **六件 → 五件**（agent_task / agent_followup / archive_subagent / pause_subagent / resume_subagent） |
| agent_task 描述 | 删「互不依赖的任务请改用 agent_tasks 并行派发」，改为「互不依赖、写入范围不重叠的任务，在同一轮里发多个 agent_task 调用即可并行执行（超出并发上限的调用立即报错回传、不排队）」；summary 同步「同一轮发多个本调用即并行派发」 |
| 工具循环并行 | agent.ts run() 工具循环：`sessionKind === "coordinator" && toolCalls.length > 1` → 全部 printToolCall 按启动序先打，`Promise.all(executeWithMeta)` 并行执行、printToolResult 各自完成时报，**tool 消息等全部完成后按调用序统一回填**（mergeInterimQueue 的「本轮 tool 消息已 push」形状不变；executeWithMeta 不抛错，Promise.all 安全）。普通会话逐字保持原顺序分支 |
| 提示词 | coordinatorBase「并行纪律」改写（同轮多 agent_task + 各自 scope + 超发即拒不排队）；「子代理工具参考」删 agent_tasks 行、agent_task 行补「同一轮发多个本调用即并行执行（见并行纪律）」；golden 显式更新（并行纪律行、工具参考行、toolDocs 五件——golden 与 vision 变体两处） |
| 配额语义 | 不变：并发/累计配额在 subagentServiceFor.run **同步段**检查（单 JS 线程下同轮并行派发各自入口检查原子，与原批量路径等价）；拒收文案「并发上限已达 3…该任务未启动」保留 |
| 历史会话兼容 | 前端 addTool 的 `name === "agent_task" \|\| name === "agent_tasks"` 判断**保留**——旧会话存档里的 agent_tasks 工具块照常渲染（含批次统计/🤖 抽屉入口）；工具已退役不可再调 |
| interim 兼容 | 白名单本就不含 agent_tasks；并行窗口 toolPending=true 语义不变（场景 9 真机验证：同轮两个 agent_task 挂起期间 interject 形状与合并序列不回归） |

### 0.3 明确不做（边界）

- 不做普通会话的并行工具执行（文件工具顺序语义是有意设计）。
- 不保留 agent_tasks 作「兼容别名」（模型不会再见到它；历史档只渲染不执行）。
- 并行分支不做每工具的超时隔离（与顺序版同构——工具自身的中止/超时语义不变）。
- followup 同轮多调用同样并行（可复用 worker 各自独立任务，无共享状态；乐观锁照常兜底文件冲突）。

## 1. 实施记录（2026-11-14 交付）

1. **agent-task.ts**：删 createAgentTasksTool（含 TASK_ITEM_PROPERTIES 的数组用法注释）；agent_task description/summary 改写（§0.2）；文件头注释补 docs/15。
2. **index.ts**：删 agentTasksDef 注册与导出；模块头注释更新。
3. **agent.ts**：工具循环并行分支（§0.2）；三处注释的 agent_tasks 提法更新。
4. **sections.ts**：并行纪律条 + 工具参考改写；coordinatorBase 注释沿革补 docs/15。
5. **contract.test.ts**：golden 并行纪律行/工具参考行/toolDocs 五件（golden 与 vision 变体两处）；注释沿革补 docs/15。
6. **测试**：agent-task.test.ts 删 agent_tasks 组两测试（-2）；agent.test.ts 新增「docs/15：协调者同轮多个工具调用并行执行（w2 无需等 w1 完成）；普通会话保持顺序执行」（+1：协调者并行 + 普通顺序对照 + 回填按调用序 + 两轮 chat）；session-runtime.test.ts 五件断言 ×2 + 系统提示断言（不含 agent_tasks + 含同轮并行说明）。
7. **冒烟**：smoke-subagent/sa2 六件断言改五件；sa4 场景 1 改 `Promise.all` 两个 agent_task（断言一成一败各自报告）；sa3 场景 1/2/6/7 registry 与并行调用改写、场景 9 改**同轮两个 agent_task 调用**（scripted 单 ChatResult 双 toolCalls——真实走 agent.ts 并行分支）。
8. **注释清理**：config.ts（并发上限说明）、subagents.ts 五处、smoke 头注释。

## 2. 验证

- `npm test` **360 全绿 0 skip**（361 - 2 + 1）；typecheck 干净。
- 四冒烟全过：smoke:subagent / smoke:sa2 / **smoke:sa3 10/10**（场景 9 即并行分支真机验证：同轮两个 agent_task 挂起 → interject 请求形状（两个状态占位 tool 消息 + 新消息 + 仅三件控制工具）→ 轮末合并 [tool,tool,user,assistant] → 最终报告）/ **smoke:sa4 9/9**。
- 过程坑（诚实记录）：①heredoc 转义把 TS 源码里的 `\n` 写成真实换行（两处字符串损坏）——改用标记定位 + 独立修复脚本收口；②sa3 场景 9 首改把两个 tc() 当同轮——tc() 是单 toolCall 的 ChatResult，两个 tc 是三轮串行脚本；改为单个 ChatResult 带 toolCalls×2 才真正触发并行分支（worker 未到闸门的失败暴露了这一点）。

## 3. 已知边界（诚实声明）

1. 并行分支回填顺序 = 调用序（非完成序）——OpenAI/Anthropic 协议只要求 tool 消息与 assistant.tool_calls 按 call_id 配对，顺序无关；如未来某端点要求严格完成序再调。
2. 同轮并行调用的 UI：调用块按启动序全部先出现（live 并转），结果各自完成时定格——与旧 agent_tasks「一整块」不同，是 N 个独立 agent_task 块（前端批次统计按块各算一个）。
3. 协调者在同轮里混合派发+控制（如 agent_task×2 + pause_subagent）时控制工具也并行执行——控制类是同步快操作，无竞态；但「先派发再暂停刚派出的」这类同轮时序依赖不保证（模型应分轮做，提示词工具参考已隐含轮次语义）。
4. agent_tasks 的合并统计头（「共 N 项：成功 X / 失败 Y」）随工具退役消失——前端 _subsum 批次统计改按同轮各块分别定格（正则按块匹配 `[子代理 X 完成]`，天然兼容）。

## 4. 符号速查（写作基线快照）

| 主题 | 符号 | 文件 |
|---|---|---|
| 并行分支 | run() 工具循环 `sessionKind === "coordinator" && calls.length > 1` → Promise.all | src/agent.ts |
| 唯一派发工具 | `createAgentTaskTool`（description 含同轮多调用并行说明） | modules/tools/agent-task/agent-task.ts |
| 注册（五件） | toolAgentTask.setup（agentTasksDef 已删） | modules/tools/agent-task/index.ts |
| 提示词 | coordinatorBase「并行纪律」/「agent_task」工具参考行 | core/sections.ts + contract.test.ts（golden） |
| 并行锁定测试 | 「docs/15：协调者同轮多个工具调用并行执行…」 | src/agent.test.ts |
| 前端历史兼容 | addTool 的 `agent_task \|\| agent_tasks` 判断（保留） | src/web/public/index.html |

—— 完 ——
