# 32 · 交接文档——协调者状态表/目录清单/询问用户工具 + 子代理 MCP 注入修复 + 协调者提示词完善

> 状态：**已实施**（2026-11-17，随 v0.3.4 发布；预检三件套全绿——typecheck 三段过 + npm test **487/487** + smoke:sa4 **11/11**；smoke-subagent / smoke-sa2 / smoke-sa3 三个非闸门冒烟也全过）。
> 来源：`docs/待办事项.txt` 三条（①协调者加子代理状态表工具与只看文件名的目录工具；②协调者提示词里 godot/blender 的 MCP 说明未注入、ref_database 可以；③完善协调者提示词）+ 用户追加一条（④`ask_user` 询问用户工具：普通对话与协调者可用、子代理不可用——子代理不确定写进报告由协调者转询；让用户做选择题，选项之外可自行输入其它答案）。

## §0 根因与设计决策

### 0.1 MCP 注入 bug 根因（真机实证，三个会话档比对）

协调者的 MCP 说明只经 order 35「子代理系统提示词说明」段 ← `rt.mcp.instructionsText()`（manager.ts，只收「连接成功且握手返回了 instructions」的服务器）。真机三个会话档实证：

| 会话 | 时间 | 现象 |
|---|---|---|
| games 协调者 | 20:13 | 回答完全无 godot/blender 内容 |
| 论文工作区协调者 | 20:13 | ref_database 用法完整注入 |
| games 普通对话（仅晚 1 分钟） | 20:14 | godot/blender 全部在线（27.8k tokens 工具） |

三重时序/重试缺陷叠加：**①协调者首轮无闸门**——普通对话 `startTurn` 前 `await rt.mcpReady`（session-lifecycle），协调者该 promise 从不赋值（预热是 `void` fire-and-forget），首轮请求立即用「MCP 为空」的提示词发出；**②godot-ai 冷启动超握手超时**——attach 先拉后端再应答握手（健康检查上限 30s > harness 握手超时 20s），`McpManager.apply` 把它记入 `failures` **本会话永不重试**，但超时放弃的那个桥接进程不杀后端——1 分钟后新开的普通对话秒连（采纳现有后端）且有 `mcpReady` 闸门收口，于是「只有普通对话注入了」；**③热更只补后续轮**——blender（轻量）在 godot 超时后连成功触发 `refreshSystemPrompt`，但协调者首轮早已结束。

### 0.2 设计决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 状态表工具名/受众 | `subagent_status`，`audience: "coordinator"`，接缝 `subagentStatus?: (opts) => string` | 仿 `subagentControl` 先例；docs/18 §3 预留口径落地 |
| 目录工具 | `list_files`，`audience: "coordinator"`，复用现有 `deps.workspace()` 接缝（不新增缝） | 普通会话/子代理已有 run_pwsh；协调者只看文件名核对结构与验收产出 |
| 询问工具受众 | **三值 audience 扩展**：`"worker" \| "coordinator" \| "front"`（front=普通+协调者，不含子代理） | 二值受众表达不了「普通+协调者、无子代理」；front 语义=前台会话（对用户对话的形态），子代理是对内的 |
| ask_user 的 UX | 复用审批卡机制形态：SSE `askUser` 事件弹卡 + `POST /api/ask-user` 决议；选项按钮点选 + 「其它」自由输入框 | 与审批卡同一交互范式（驻留卡、决答回流）；`rt.pendingAskUsers` 用 **Map** 而非单槽——协调者同轮并行多问不互相覆盖（审批是单槽+串行链，ask 无副作用不需要链） |
| ask_user 与 interim | **不进** `INTERIM_CONTROL_TOOLS` | 阻塞提问会挂住 interim 合并点；插话窗口维持三件（stop/archive/subagent_status） |
| MCP 修复 | 三件套：①协调者也设 `rt.mcpReady`（首轮闸门，与普通会话同语义）；②`workerMcpToolsOf` 失败重试一次（宽限 10s 后整体重连）；③「子代理说明段」附 MCP 工具清单（`toolInventoryText`）+ 未连接服务器警示行 | 闸门治「赶不上首轮」、重试治「冷启动判死刑」、清单治「服务器不给 instructions」——三层任一生效即可见 |
| 清单位置 | 附在重放正文**之后**并标注「非子代理提示词原文」 | 保持「子代理系统提示词说明」段的同构重放语义不破 |
| 提示词完善范围 | 用户选定「同步修订 + 两条新纪律」：追问进度用 subagent_status 查后如实汇报；交付前用 list_files 抽查产出物落盘 | 与新能力同步 + 最小增量 |

## §1 实施

1. **三值受众**（`core/types.ts` + 三处过滤点）：`session-runtime.ts` 注册分流（coordinator 装 coordinator+front；normal 装 worker+front）、`subagent-worker.ts` worker 只装 worker、`subagents.ts` worker 提示词重放同口径。防线双层：worker registry 不注册 ask_user + workerDeps 不注入 `askUser` 接缝（execute 防御文案兜底）。
2. **subagent_status**：接缝实现 `web/subagent-status.ts`（家族六件套之六，D1 行数哨兵内拆出）——活动子代理（run/idle）逐行实时状态（`liveElapsedMs/liveContextPct`），`all=true` 附最近 20 条历史记录；工具在 agent-task 家族模块；interim 白名单三件（`agent.ts` `INTERIM_CONTROL_TOOLS` + 错误文案）。
3. **list_files**：新模块 `modules/tools/list-files/`——单层列举、目录在前、`/`/`@` 后缀、500 条截断、`isInsideWorkspace` 守卫（与 read_file 同口径）。
4. **ask_user**：新模块 `modules/tools/ask-user/`（校验 question ≤2000、options 2~4 个 ≤200 字符）；接缝 `web/session-runtime.ts askUserFor`（广播 `SSE_EVENTS.askUser` + `rt.pendingAskUsers: Map<askId, resolver>` + 中止信号 cancelled）；路由 `POST /api/ask-user`（web-sessions 模块，镜像 /api/approval fail-closed 风格）；前端 `main.js` SSE_HANDLERS.askUser + 询问卡（index.html `#askUser`，CSS 复用审批卡色系）+ 失焦通知 + turnEnd 清卡 + 后台会话缓冲重放（replay 同一路由）。
5. **MCP 三件套**：`manager.ts` 加 `failedServers()`/`toolInventoryText()`；`workerMcpToolsOf` 失败重试（`WORKER_MCP_RETRY_DELAY_MS = 10_000` 本地常量）+ 整体 try/catch 降级 null（顺修 `??=` 缓存 rejected promise 隐患）；`createRuntime`/`bindWorkspace` 协调者预热改挂 `rt.mcpReady`（`startTurn` 既有 await 收口；最坏等待 ≈ 20s+10s+20s，无配置近瞬时）；`commonWorkerPromptSectionText` 包装头追加清单与警示（同构重放正文不动）。
6. **提示词**（`core/sections.ts` + `subagent-worker.ts` WORKER_ROLE_SECTION）：协调者身份句（三件直用工具）、新增「直用工具参考」块、异常变动条「事实源 + 主动核对」、报告处理纪律补追问进度、汇总交付补抽查产出物、interim 三件口径；normal base 补 ask_user 纪律行；worker 职责段补「不可直问用户」。**golden 快照显式更新**（contract.test.ts baseSection/coordinatorBase/toolDocs 六件清单/vision 变体）。

## §2 哨兵与测试调整（显式决定记录）

| 项 | 调整 | 依据 |
|---|---|---|
| D1 五文件 ≤400 行 | **增至六文件**（subagent-status.ts 拆出后 subagents.ts 回到限内）；哨兵改名六件套 | 拆分方向符合 D1 本意，不抬上限 |
| index.html ≤500 行 | **500→520**（ask 卡 CSS+骨架 +19 行，现 509） | 先例：行数哨兵随功能调整并留注释（250→270→278） |
| smoke-sa4 P2 | 协调者 registry 断言四件→**七件排序串**；红线断言 `!includes("mcp__demo")` → `!includes("# MCP 服务器使用说明")` | 清单兜底会让协调者提示**有意**含 mcp__ 工具名；红线本义=不装配 mcp__ 工具（registry 断言已覆盖）+ 无 MCP 说明段 |
| smoke-subagent/sa2/sa3 | registry 四件→七件；sa2「六件」旧文案→七件；subagent 的「不含 run_pwsh」改「run_pwsh 只出现在 docs/20 子代理说明段内」（该断言本就早于 docs/20 过期） | 非闸门脚本但对齐新口径 |
| subagents.test.ts 三处校准 | 任务书 repeat(460/150/100)→(190/25/30) | normal base 新增 ask_user 行 + WORKER_ROLE_SECTION 新增一行 → worker 系统提示变长，占比校准漂移（测试注释预留的「漂了请调任务书长度」流程） |
| session-runtime.test.ts | coordinator registry 断言四件→五件（测试壳只注册 agent-task 家族模块） | 同上 |

## §3 已知边界

- ask_user 阻塞等待无超时（与审批卡同口径）；用户停止会话 → cancelled 收场，工具文案指引「不要假设答案」。
- interim 插话窗口不能发起 ask_user（白名单外错误回填）；协调者要提问等当前轮结束。
- `rt.mcpReady` 闸门让协调者首条消息最多等 ≈50s（握手 20s + 重试宽限 10s + 重试握手 20s）；普通会话本就等（单次 apply ≤20s）。
- worker MCP 配置仍在**会话生命周期读一次**（`rt.workerMcp` promise 缓存）——会话中途改 mcp.json 需重开会话/换绑工作区（现状不变，README 已如此描述）。
- list_files 路径守卫只比字符串不解符号链接（与 read_file 同口径）；symlink 指向工作区外时列举其目标文件名属已知可接受（只读名字，不给内容）。
- 前端询问卡同一时刻只显示一张（后到覆盖前卡显示）；并行多问各自持 id 均可提交。

## §4 真机验收指引（下轮真机回归用）

1. games 工区新建 🎯 协调者会话 → 提问「子代理有哪些工具」：回答应含 godot/blender 的 MCP 说明或工具清单/「未能连接」警示（三态都算修复生效）；冷启动首问明显有等待（闸门生效）。
2. 派长任务后运行中插话「现在进度如何」→ 应见 `subagent_status` 工具块真实执行并转述状态表。
3. 协调者或普通会话让模型「向我确认一下用哪个方案」→ 弹询问卡：点选项回流「用户选择了：…」；「其它」输入文字回流「用户没有选给定选项，自行输入：…」；停止会话 → 模型收到未回答提示。
4. 协调者让它列工作区根目录 → `list_files` 返回文件名清单（无内容）。

## §5 真机回归修复记录（2026-11-17，随 v0.3.5 发布）

真机试第一轮发现两处问题，均已修复并带回归测试：

1. **选完选项轮次卡死、结果永不回填**（严重）：`/api/ask-user` 路由在调 `settle` 前**预先** `rt.pendingAskUsers.delete(id)`——settle 的幂等守卫（`if (!delete(id)) return`）把本次决议误判为「迟到触发」提前返回，提问 promise **永不 resolve**，工具循环挂死（仅停止会话可解）。修复：路由只调 settle（删除由 settle 自己做）；回归测试挂在 web-sessions.test.ts（双删必超时）。教训：**幂等守卫与槽删除必须同属一处**，调用方不得先动槽。
2. **工具块展示带参数 JSON 格式**：ask_user / subagent_status / list_files / stop_subagent / archive_subagent 五个工具没有 toolinfo 定制，折叠头与展开体都落到「参数 JSON」兜底（如 `{}`、`{"all":true}`），与 write/edit/pwsh 的「只显内容」理念不一致。修复（toolinfo.js）：ask_user 折叠头=`提问 <问题>`、展开体=问题+编号选项两块（回答在结果 tres）；subagent_status / list_files / stop / archive 折叠头=`动词+对象`（查看子代理状态表 / 列目录 <path> / 打断·归档子代理 #N（name））、展开体只留结果（read_file 同款空数组语义）。

v0.3.4 未打包即被 v0.3.5 取代（发版提交仅版本号，无产物）。
