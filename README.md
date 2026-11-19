# ZQQ-harness

Agent 应用（**Web UI**，`npm run web`）：多提供方 LLM + **10 个系统工具**（run_pwsh / read_file / write_file / edit_file / load_skill / manage_mcp / view_image / read_archive / ask_user / read_image——ask_user 是向用户发起选择题的询问工具 docs/32；read_image 是视觉会话直读盘上图片 docs/34）+ MCP + 技能，带**命令审核、Windows 受限令牌沙箱、上下文管理、多会话并行与思考内容管理、视觉支持**（有视觉能力的模型直看图片——贴图或 read_image；没有的用 view_image 工具借视觉模型分析）；大型任务可开**协调者会话**（两层架构：子代理**非阻塞并行派发、完成/失败/打断即时送达**（像用户消息一样到达，协调者随时处于收信状态）/打断（stop，无暂停恢复）/可复用与归档（重启后 followup 自动从存档唤醒）/异常变动自动报告，见[协调者会话与子代理](#协调者会话与子代理大型任务)）。代码按**模块化架构**组织（`src/core/` 内核 + `src/modules/` 组合式模块，产品 = 一张模块清单），新增/删减能力只需增删模块；**运行阈值与模块启停可经用户级 `harness.json` 覆盖、外部模块目录可零源码扩展**（见[用户级配置](#用户级配置-harnessjson-与外部模块)）。

## 维护导航（新对话/新协作者先读）

- **架构体检与改进路线**：[docs/21_开发文档-架构可维护性审计与参数化改进.md](docs/21_开发文档-架构可维护性审计与参数化改进.md)——2026-11-14 全项目审计基线，含**硬编码参数全清单（P0–P3 分级）**、参数间矛盾、分阶段实施路线图（§4）与不变量清单（§5）。**阶段 A（P0）8/8、阶段 B 第一批（P1 8 键）与第二批（后 9 键，25→34 键收官）、阶段 C（P2 常量收敛+协议解耦+前端 CFG/XSS）、阶段 D1（subagents.ts 拆五文件）、D2（config initConfig 显式装载）、D3 首块（renderTree keyed 更新）均已完成**（实施记录见文档头部）；D3 其余重灌点已并入前端优化路线（[docs/26](docs/26_开发文档-前端架构优化与桌面端统一路线.md) F3）。改参数/改架构前先看它。
- **五分钟建立全局感**（docs/21 §6 有完整版）：`src/modules.ts`（54 行产品全貌）→ `src/core/context.ts` + `core/types.ts`（扩展点形状）→ `src/config.ts`（全部运行参数生效值唯一出处）→ `src/agent.ts`（Agent 循环）→ `src/web/server.ts`（bootstrap 瘦壳）。
- **常见任务最小改动路径**：调阈值= config.ts 三件套（THRESHOLDS 字段 + rules 校验行 + resolveThresholds 缺省）+ 测试；新工具 = `modules/tools/<名>/` + `modules.ts` 加一行；改提示词 = `core/sections.ts`（golden 测试把关）——速查表见 docs/21 §6。
- **变更惯例**：docs/ 编号文档（设计稿→头部补实施记录）；每阶段收尾 `npm run typecheck` + `npm test` 全绿 + Web UI 手工冒烟。
- **前端与桌面统一路线（已全部收官）**（详见 [docs/26](docs/26_开发文档-前端架构优化与桌面端统一路线.md) §8）：**前端优化（F1–F4）与桌面端（DT0–DT3）**。①地基（DT0+F1）②桌面形态（DT1 薄壳 + DT2 打包）③质量渐进（F2 store 化；F3 keyed 收官）④F4 大分区拆文件（index.html 2,906→473 行，视图七模块无环分层）⑤**DT3 桌面增强已完成**（审批通知/开机自启/托盘常驻/休眠恢复，四项独立 commit，详见 [docs/25](docs/25_开发文档-桌面端版本方案.md) 头部实施记录）。前端「运行阈值」设置入口见 [docs/24](docs/24_交接文档-前端设置入口与harness热应用.md)。路线内无遗留开发项；后续新工作另立文档。
- **最新一轮**（[docs/40](docs/40_开发文档-阈值体系意义与架构改善.md)，阈值体系意义与架构改善）：三阶段一次落地——**阅读类独立预算 `readToolResultMaxChars`（120k）+ 双层截断单层化**（read_file/read_archive 头部行区间与模型实见一致）、**压缩摘要输入改头+尾保留**（尾 10% 是最近上下文，docs/10 R2 勘误）、**30+ export let 常量收敛单一 `THRESHOLDS` 对象**（initConfig 原地 Object.assign，34 文件迁移 + 哨兵重写）、修剪观测性（Token 面板一行）、子代理报告 16k→32k、顶栏版号显示；`npm test` 531 项全绿。上一轮：[docs/39](docs/39_交接文档-Anthropic路线缓存断点默认注入.md)（Anthropic 路线 cache_control 断点默认注入，随 v0.3.13 发布）。上上轮：[docs/38](docs/38_交接文档-Anthropic格式缓存命中的输入口径修正.md)（缓存命中输入口径修正，随 v0.3.12 发布）。
- **打包与冒烟速查**：[docs/27](docs/27_操作手册-桌面端打包与冒烟.md)——给自己看的操作手册（照抄命令即可）：预检三件套（typecheck + test + smoke:sa4）→ 双镜像 electron-builder 打包 → 打包版验收清单与常见坑速查。**版本更替发版清单（改哪些地方、提交顺序、产物验收）**：[docs/31](docs/31_操作手册-版本更替与发版清单.md)（v0.3.3 即按此流程）。

## 快速开始

```bash
npm install
npm run web               # 打开 http://localhost:8787（自动弹浏览器，PORT 可改）
npm run desktop           # 桌面版（Electron 薄壳，docs/25 DT1）：独立窗口 + 动态端口 + 关窗即退
```

- **桌面版首次安装**：electron 二进制（~120MB）由 postinstall 下载；本机 allow-scripts 策略会拦截该脚本时，手动补跑：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`（registry 已是 npmmirror）。壳只管进程与窗口（`desktop/main.mjs` + `icon.ico`〔c1-energy 应用图标〕，≤2 文件哨兵锁定）——与浏览器版跑**同一份** server.ts 与前端，双入口零漂移
- **打包分发**（docs/25 DT2）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npx electron-builder --win` → `dist/ZQQ-harness-Setup-<版本>.exe`（nsis 引导式安装，**安装位置可选**——默认按用户装无需管理员，静默装/卸：`Setup.exe /S /D=<不带引号的目录>` 与 `Uninstall ZQQ-harness.exe /S`；卸载**不清** `~/.ZQQ-harness/` 用户数据）与 `dist/ZQQ-harness-<版本>-portable.exe`（免安装单文件）。目标机只需 Windows 10/11 x64 + PowerShell 7（Node/浏览器均不需要，Electron 自带）。`asar: false`（ELECTRON_RUN_AS_NODE 子进程加载 .ts 与 koffi DLL 走真实文件最稳）；未签名（SmartScreen/杀软可能误报，portable 自用为主——已知取舍）；portable 双击运行无控制台（排障用 dev 模式 `npm run desktop` 看 `[svc]` 服务日志）
- **桌面增强**（docs/25 DT3，已全部落地）：**审批通知**（审批卡到达且窗口失焦时系统通知，点击聚焦）；**开机自启/托盘常驻**（偏好存 `~/.ZQQ-harness/desktop.json`，经 web.desktop 模块 `/api/desktop` 读写——设置模态「🖥 桌面版」区即时生效，壳 fs.watch 活应用；两项默认关，自启仅打包版注册）；**休眠恢复**（唤醒后整页 reload 走 init 快照，默认开）

- 不想自动弹浏览器（脚本/远程环境）：设环境变量 `ZQQ_NO_BROWSER=1` 再启动
- **服务默认只监听 `127.0.0.1`（本机）**，局域网不可达（docs/25 DT0）；确需局域网访问设 `ZQQ_HOST=0.0.0.0` 再启动（自担风险——服务暴露会话数据与 API key 操作面）。`PORT=0` 为随机端口，启动首行 stdout 打印 `ZQQ-READY <端口>` 握手行（供桌面壳解析，浏览器模式忽略无害）；关停支持 Ctrl+C 与 stdin 关闭（父进程退出联动）
- **用户级调整**：不改源码即可启停模块、覆盖运行阈值——在 Web UI 顶栏 **⚙** 可视化编辑（保存即热应用，见[用户级配置](#用户级配置-harnessjson-与外部模块)），或直接改 `~/.ZQQ-harness/harness.json`（支持注释，重启生效）

**一键启动**：双击项目根目录的 `start-zqq.bat`（浏览器版，纯 ASCII；bat 含中文会被 GBK 解析撕裂）或 `start-zqq-desktop.bat`（桌面版，等价 `npm run desktop`），或桌面快捷方式"ZQQ-harness"，自动起服务并打开窗口/浏览器；关闭时直接关掉那个控制台窗口。

**API key**：提供方连接信息统一存放在 `~/.ZQQ-harness/providers.json`（含 key）。首次启动且该文件不存在时，自动从环境变量 `DEEPSEEK_API_KEY` → `C:\Users\<用户>\.ZQQ-harness\.credentials.yaml`（规范位置，`DEEPSEEK_API_KEY: sk-xxx`）→ 启动目录/工作区根的旧位置迁移，并填好 DeepSeek 提供方（https://api.deepseek.com + `deepseek-flash` + 思考高；`DEEPSEEK_MODEL`/`DEEPSEEK_MAX_TOKENS`/`DEEPSEEK_CONTEXT_LENGTH` 环境变量同样只在这次迁移时读取）。**之后一律以 providers.json 为准**，在界面"提供方管理"里增删改。

## 提供方管理

支持同时配置多个 LLM 提供方，随时切换。**点击顶栏模型徽章**打开管理面板：

- 每个提供方配置：**名称 / 接口格式 / API 地址 / 模型 / 思考档位 / API Key / 上下文长度 / 输出上限**（可选）/ **视觉能力**（docs/10：勾选=该模型可直接看图，会话输入框出现 📎 上传按钮，图片随消息直发模型）
- **视觉模型**（docs/10；docs/12 R2 修订）：面板顶部的 👁 下拉——从勾选了视觉能力的提供方里选一个供 `view_image` 工具**借用**（没有视觉能力的会话看图的出路——docs/34 起有视觉的会话读盘图改用 read_image 直看，不经此下拉）；即时保存，无需重启
- **接口格式是注册制**：合法值 = 已注册的格式模块（当前内置 **OpenAI 兼容** 与 **Anthropic 兼容** 两个，表单下拉由服务端下发）；新增一种 LLM 协议 = 新增一个 provider 模块，不改任何现有代码
- **思考档位按提供方设置**：默认（不添加思考参数，适配不支持思考档位的模型如 mimo）/ 关 / 低 / 高 / 最高；选"默认"时请求不带任何 thinking/reasoning 参数
- **模型与思考档位按对话记录，不是全局**：「用于当前对话」只切换当前对话的模型（历史保留）并写入该对话的存档，切换/恢复对话时自动跟随；「设为默认」只决定新对话用哪个提供方
- 「测试连接」按提供方自己的思考档位发最小请求验证配置
- 接口格式说明：OpenAI 兼容格式按 DeepSeek 风格发送思考参数（`thinking`/`reasoning_effort`）；Anthropic 兼容格式走 `/v1/messages` + SSE，思考映射为扩展思考 budget（低 4k / 高 16k / 最高 32k），**off 档显式发 `disabled`**（GLM/DeepSeek/MiMo 兼容端缺省=默认思考、不发参数关不掉；官方 Anthropic 不认 disabled→自动去参重试一次，docs/37），**默认注入 `cache_control` 断点**（末消息末块——MiMo 端激活缓存与命中报告、DeepSeek 无副作用、GLM 忽略；未知端 400 自动去标重试，docs/39）
- **思考内容入历史与回传**：所有轮次的思考（含签名与产出模型）随会话历史存档——**回放/回传范围限定在带工具调用的轮次**：Anthropic 路线在思考开启的请求中**原样回放 thinking 块**（模型一致且签名有效才回放，换模型自动省略，签名缺失降级并告警），修复官方端点多轮工具调用的 400；OpenAI 兼容（DeepSeek）路线**默认不回传**历史思考（实测不回传也无 400，省 token），设环境变量 `REASONING_PASSBACK=1` 开启合规回传。最终回答轮的思考只存档供前端显示，不回传
- **压缩等辅助调用强制关思考**：会话压缩的摘要调用固定 `effort: off`（openai 路线显式 `thinking:disabled`），不付思考成本、思考流也不串进前端

## Web UI

- **侧边栏**：上部是「＋ 新对话」「📁 添加工作区…」按钮，中部是**工作区树**（数量不设上限，可滚轮滑动）：每个工作区一行，**点击选中该工作区并展开**（当前工作区高亮；切换=旧对话归档+新工作区开新对话；**已存在的工作区选中/切换不改变树中顺序**，只有**首次添加**的工作区自动置顶），**点击 ▸/▾ 仅折叠/展开**，**拖动行排序**（顺序存 `workspaces.json`）；行内展开显示该工作区的**全部对话**（每轮对话结束自动存档到 `sessions/`、重启服务不丢；点击切换、悬停 ✕ **两步确认**删除、拖动排序）；**无默认工作区**——启动后必须先选择，未选时输入框禁用；有会话但不在工作区列表中的目录也会显示在树尾（数据不丢）
- **工作区删除与回收站**：工作区行悬停 🗑 **两步确认**删除——从树中移除，其中全部对话转入**回收站**（侧边栏底部可折叠区，显示标题 / 原工作区 / 日期）；删的是当前工作区则自动回到未选择态；删除时无消息的空占位对话直接清除、不进回收站。回收站内可**恢复**（对话回到工作区列表）或 ✕ 两步确认**彻底删除**（不可恢复）
- **对话拖动排序**：对话列表项可拖动——放到目标**上半部**=排到其上、**下半部**=排到其下（拖拽时有蓝色插入位置指示线）；任意工作区的对话都可拖动；手动顺序按工作区存 `sessions/order.json`，新对话自动置顶，未拖动过的旧会话按时间倒序排在手动顺序之后
- 切换工作区 = 当前对话归档在旧工作区名下 + 新工作区开新对话（当前会话还是**没有任何消息的空占位**时改为**就地换绑**到新工作区——不新建不清扫，docs/28；侧边栏条目跟着工作区走）；加载旧会话会同时恢复其工作区、提供方与思考档位、token 累计、审批策略与沙箱模式；**点「＋新对话」后新会话立即出现在侧边栏**（暂显"(无标题)"，首轮消息后自动改为消息摘要标题）。切换/新建的响应不等待 MCP 握手（连接后台装配，首轮消息发出前就绪，docs/28），会话列表读取走内存元数据缓存（大量会话/大存档时不再卡顿）
- **思考流**：灰色框内显示（💭 标记），框内可滚轮滑动；**思考完成后自动折叠**（标题显示字数），点击框头随时重开；**切换会话/刷新页面后，历史思考以折叠态重现**（每轮一条，点击展开——思考已随会话存档，含最终回答轮）
- **工具调用块**：每次调用一个可折叠块——**头部是一行摘要**（docs/28）：`run_pwsh` 只显示 description（缺省退命令首行）、`read_file`/`write_file`/`edit_file` 显示「读取/写入/编辑 文件路径」（read 带 offset 附起始行；edit 附 `+N -M 行` diff 规模标注），其他工具照旧参数摘要；**展开体按工具分流**（docs/28 + 真机待办「展示理念统一」：只显示内容/描述/结果，不显示参数 JSON 格式块）：`run_pwsh` 显示 description 注记 + 命令本体、`write_file` 只显示写入的内容、`edit_file` 显示**红绿 diff**（删除行红 `-`、新增行绿 `+`，附 occurrence/replace_all 消歧注记）、`read_file` 只留结果（读取的内容就在结果里，路径/起始行折叠头已有），其余为格式化参数 + **完整返回结果**（滚动区）；结果被修剪或落盘时块内会标注；**调用完成后自动折叠**，点击重开；并行调用/切回重放按 callId 精确配对，被中断轮的未完成调用标注"无返回结果"而不是永远转圈；协调者会话的 agent_task 块只留一行**子代理动态摘要**（docs/16 起结果即派发回执，摘要定格为「已派发 N 个子代理 · 报告完成后自动送达」），各子代理的完成报告以带 🤖 徽标的「自动送达」消息气泡进主列——**默认只显示一行摘要**（哪个子代理 · ✓完成/✗失败/状态，docs/18；点击「展开全文」看报告详情，过程档案链接在展开后可点），过程全部移入**侧栏抽屉**查看（见[协调者会话](#协调者会话与子代理大型任务)，docs/8）
- **轮结束自动收纳**：每轮任务完成后，本轮的全部过程——思考、工具与 MCP 调用、中间文字输出——收进一个"🔧 执行过程 · N 项"折叠条目（点击展开，内部工具块仍可各自展开），**每轮的最终回答保持展开**——一眼看到每轮结论，过程随手可查；历史渲染（刷新/切回）行为一致，任务运行中的最新轮不收纳（实时流可见）
- **思考档位**：**按对话记录**——顶栏下拉随时切换（默认=不添加思考参数 / 关 / 低 / 高 / 最高），写入当前对话存档，切回旧对话自动跟随；提供方表单里的思考档位只是新对话使用该提供方时的初始值。思考是**自适应的**：简单任务即使开高档位，模型也可能不输出思考块
- **沙箱模式**：**按对话记录**——顶栏下拉随时切换（🔒 只读 / 🗂 工作区可写 / ⚠ 全开放），写入当前对话存档；详见[沙箱（安全模型）](#沙箱安全模型)
- **token 用量**：顶栏实时显示会话累计输入/输出 token（按会话保存与恢复，总量以 API 返回的 usage 为准；缓存以**命中率**显示、思考 token 单独显示，均为 API 实测）+ **当前上下文**（下次请求将发送的 system+工具+消息 的 token 总量，**优先锚定 API 实测**：取最近一次请求返回的 usage 实际输入 token，其后新增消息与固定开销变化按本地估算补足，随对话实时增长，显示占上下文上限的百分比；**占用达到阈值数字变红，悬停提示 /compact**，阈值由服务端下发）。**点击展开输入构成明细**——首行"当前上下文（下次请求）"，随后是**下次请求的单次构成**：系统提示词 / 技能清单 / 系统工具 / MCP 工具 / 消息（技能正文与工具调用结果都计入"消息"）；"输入/输出合计"为会话累计。分类用项目内置的 **DeepSeek v4 tokenizer**（`assets/deepseek_v4_tokenizer/`，纯 JS BPE 实现，零原生依赖）对实际发送内容做真实编码计数（逐消息缓存，不重复分词）；tokenizer 资产缺失时自动回退官方换算比例（1 中文字符 ≈ 0.6 token，1 英文字符 ≈ 0.3 token）。"其他"为校准项（实测与估算的差额、chat 模板包装等 API 侧开销），六类合计=总量；新会话/恢复档/压缩/换提供方后暂无实测数据时回退纯本地估算，首轮请求后自动重新锚定；**流式 usage 的各家字段差异在提供方层吸收**（docs/35：anthropic 格式 GLM 的输入实值在末尾 `message_delta`、openai 格式缓存命中双字段 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` 择一可读；docs/37：anthropic 格式 DeepSeek 的思考 token 在 `output_tokens_details.thinking_tokens`——「其中思考」跨格式对齐；docs/38：anthropic 格式按官方公式取总输入 `input + cache_read + cache_creation`——DeepSeek 端 input 只算未命中，命中率不再被钳 100%）；`/status` 同样可见
- **运行计时**：顶栏 ⏱ 实时显示**本次**（当前轮用时，运行中高亮、本地 1s 滴答）与**累计**（会话全部已结束轮的总用时，随会话存档/恢复，与在飞部分合并显示不双算）；`/status` 同样可见。**协调者会话的计时覆盖整段编排**（docs/35）——子代理运行期间持续计时（等待空窗也计入），报告送达/用户插话开新轮接续同段「本次」不重置，全部子代理结束且协调者空闲才停。子代理同样计时（见[协调者会话](#协调者会话与子代理大型任务)）。**首轮装配进度**（docs/36）：会话运行实例的第一条消息发出时，装配阶段按真实时序逐段可见——🧩 系统提示装配完成（系统提示词〔基础规则+两级 AGENTS.md〕· 系统工具 · 技能清单的 token 数，与 token 面板同源）→ 🔌 MCP 注入（已连接/未连上清单；协调者会话标注为子代理 MCP）→ ✅ 装配完毕、用户请求已发出；**用户请求只在装配完成后才发出**（MCP 握手慢不再像卡死）；后续消息不再展示
- **多会话并行**：每个对话一份独立运行态（模型/设置/审批/中止控制/MCP 连接互相独立），**任务运行中可随时切换或新建对话**——后台会话继续运行，侧边栏条目显示 ⏳ 运行中、❓ 等待审批标记；切回运行中的会话从当前位置继续实时显示（在途事件按历史长度锚点过滤重放，不重不漏；子代理工具事件不带锚点、全量重放进抽屉——delta 增量带锚点去重，docs/28），轮结束后自动补齐完整转写；发送/停止/审批卡/设置只作用于**正在查看的会话**；同一时刻可有多个对话各自跑轮（同一提供方也可并行）
- **任务运行中（当前查看的会话）**：该会话的压缩/换模型/思考档位被拒绝（服务端 409），**审批策略与沙箱模式例外可切、下一命令即生效**（docs/30）；发送按钮变"停止"（**协调者会话例外**：输入框保持可用——可运行中插话即时得到回应或排队，停止是输入框旁独立 ⏹ 按钮，见[协调者会话](#协调者会话与子代理大型任务)）；**其他会话不受影响**，切换、新建、删除等操作照常
- **图片消息（视觉，docs/10 + docs/12 R2）**：当前会话的提供方勾选了「视觉能力」时输入框旁出现 **📎 按钮**，**Ctrl+V 粘贴截图同样收图**（与选文件同一校验管线）——≤4 张、每张 ≤5MB、PNG/JPEG/GIF/WEBP 进预览条（可删），随文字消息一起发送（多模态直发模型），气泡内渲染缩略图；视觉会话的系统提示注入**图片直看指引**（模型已直接看到消息里的图、优先自身视觉作答、不对消息图调 view_image）；**任务运行中不支持发图**（普通会话发送被停止按钮占用、协调者插话纯文本）。图片字节按**内容寻址**落盘一份——`~/.ZQQ-harness/attachments/v1/objects/<sha256 前2位>/<sha256>`（docs/33：相同字节全局只存一份、去重、**永不自动清理**），会话档 JSON 里只存 `{mime, ref}` 引用（不再嵌整段 base64，档体积不随图片膨胀）；每次带图请求仍会把图片重放给模型（多模态内容块）。当前模型没有视觉能力时改用 `view_image` 工具；有视觉能力的模型读盘上图片用 `read_image`（docs/34：图片作为图像块进入对话，下一轮原生看到——与贴图同一条附件库/回放管线）（见[系统工具](#系统工具)）
- 刷新页面恢复当前会话显示（历史思考块以折叠态重现，工具块以折叠态恢复，图片气泡照常渲染）
- 输出因 max_tokens 截断（finish_reason=length）会有明确警告

## 系统工具

普通会话与子代理可用的**系统工具**共 10 个，全部由 `src/modules/tools/*` 模块注册（组合清单加一行即新增工具，系统提示的"可用工具"行由各模块的 summary 自动生成）；其中 `ask_user`（docs/32）受众所为 **front**——普通会话与协调者可用、**子代理不注册**（子代理不确定时写进报告的「未决问题」由协调者裁决或转询用户）；另有协调者专用的 `agent_task` / `agent_followup` / `archive_subagent` / `stop_subagent` 四件派发/控制工具 + `subagent_status`（子代理状态表）与 `list_files`（只读目录清单）两件直用只读（docs/32；见下节；docs/18 起暂停/恢复退役——`pause/resume_subagent` 由 `stop_subagent` 一件取代；docs/15 起 `agent_tasks` 退役——并行派发 = 同一轮发多个 `agent_task` 调用；docs/16 起两个派发工具都**非阻塞**——派发即返回回执，报告完成后自动送达）。工具执行错误一律以字符串回传模型（不抛异常炸轮次），超长结果统一修剪（见[上下文管理](#上下文管理)）。

| 工具 | 作用 | 要点 |
|---|---|---|
| `run_pwsh` | 在本机 PowerShell 7 执行命令（工作目录=工作区根） | description 必填；守卫/审批/沙箱三层裁决；升级额度制 |
| `read_file` | 读文本文件（UTF-8，带行号） | offset/limit 分段；CRLF 按 LF 显示；二进制/>5MB 拒绝 |
| `write_file` | 创建或整体覆写文件 | **覆写已有文件必须先 read_file**；自动建父目录 |
| `edit_file` | 精确字符串替换编辑 | **必须先 read_file**；old_string 需唯一命中（同文多处可用 `occurrence` 指定第几处或 `replace_all` 全替）；CRLF 自动还原 |
| `load_skill` | 加载某技能的 SKILL.md 全文 | 清单在系统提示，按需加载 |
| `manage_mcp` | 管理 MCP 服务器配置（list/add/remove） | 校验+原子写+损坏文件拒改；写入后自动重连，**装完即用** |
| `view_image` | 分析一张本地图片文件，返回文字描述（docs/10；docs/12 R2 修订） | PNG/JPEG/GIF/WEBP ≤8MB；**优先用当前会话模型自身视觉**（勾了视觉即免配视觉模型），无自身视觉才借用配置的视觉模型（未配置返回指引）；只用于磁盘图片文件——消息携带的图模型已直看；用量计入会话合计 |
| `read_image` | **直接读取**本地图片文件，图片作为图像块进入对话——下一轮模型原生看到（docs/34；与 view_image 互补：一个直看、一个借视觉模型出文字） | 仅**当前会话模型有视觉能力**时可用（无视觉被工具层拒绝并指引 view_image）；PNG/JPEG/GIF/WebP ≤5MB 按文件魔数识别；路径相对工作区根（与 read_file 同守卫）；图片经 docs/33 附件库去重落盘、随历史每轮重放（持续占视觉 token，勿重复读同一张） |
| `read_archive` | 存档注入（docs/17）：读取子代理过程存档或主对话记录，把 JSON 转成**可读文本**注入上下文 | `subId`（本会话子代理存档）/`sessionId`（主对话档）二选一，缺参返回可用清单；新旧存档格式都兼容；超 `archiveRenderMaxChars`（默认 160k）头部截断；协调者不注册（接续上下文由新 worker 自己读，协调者只写任务书指引） |

**文件三工具的关键语义**：

- **先读后写契约（防误毁用户数据）**：`write_file` 覆写已存在的文件、`edit_file` 编辑文件之前，必须在本会话先用 `read_file` 读过该文件，否则被拒绝（新建文件不受限）。台账是会话级的：切换会话各自独立。局部修改优先用 `edit_file` 而不是整文件重写
- **写入裁决矩阵**（与 run_pwsh 的信任边界等价，但一步到位）：
  - **逐条确认开启时：任何模式都弹卡**（批准的是这次写入本身）；
  - `workspace-write`（默认）：**工作区内直接写**；工作区外弹审批卡（原因=区外路径）
  - `read-only`：任何写入都弹审批卡（原因=只读模式），批准当次放行
  - `danger-full-access`：不约束；仅逐条确认模式（顶栏 🛡「逐条确认」）下弹卡
  - 审批卡显示"写入/编辑：<绝对路径>"与拦截原因；只有 allowed-once 放行且仅限当次；拒绝/取消/无人值守的回传文案与 run_pwsh 一致
- **CRLF 透明处理**：`read_file` 把 CRLF 按 LF 显示；`edit_file` 在 LF 世界里匹配替换、写回时还原文件既有换行风格——Windows 文件的行尾不会被悄悄改变；`write_file` 内容原样落盘
- **编辑唯一性**：`edit_file` 的 old_string 必须与文件内容逐字符一致（行号不是内容的一部分）；出现多次时报错，三种消歧方式任选——①把该处独有的上下文纳入 old_string 使其唯一（首选）；②`occurrence`（1 起始整数）指定替换按文档顺序数的第几处——文档不同位置内容完全相同时用它定位（配合 read_file 的行号输出数清次序），只动选中那一处、其余命中原样保留，超过实际出现次数会报错；③`replace_all=true` 全部替换（与 occurrence 互斥）。改完后台账同步更新，可直接继续编辑无需重读
- 不适用目标（目录、二进制、超过 5MB）明确报错并指向 `run_pwsh`；`write_file`/`edit_file` 支持可选 `description`，弹审批卡时展示

**manage_mcp（MCP 配置的系统工具化）**：安装/卸载 MCP 不再靠模型手改 mcp.json——`manage_mcp` 以"读取-合并-校验-原子替换"方式写配置：条目逐项校验（服务名 ≤64 字符且无空白/控制字符、args 必须字符串数组、env 必须字符串映射、传输类型须已注册）；**文件损坏（JSON 不合法或缺 `mcpServers` 键）时拒绝修改**并指引人工修复——宁可装不上，不弄坏已装好的服务器；写回保留未知顶层键与其他服务器条目。写完自动**重连当前会话**并把连接结果回传模型（"N 个工具"或"启动失败：原因"+ 排查清单），**新工具下一轮即可调用**；其他已开的对话在新建对话或切换工作区时加载新配置。原 mcp-setup 技能的 Windows 适配知识已收敛进该工具的描述与排查清单。

## 协调者会话与子代理（大型任务）

侧边栏「🎯 协调者对话」开**两层架构**会话（docs/5；解决大型任务上下文过长的问题——具体工作的海量工具调用与文件内容全部留在子代理的独立上下文里）：

- **前台协调者（coordinator）**：**实质工作没有直接工具**（registry = `agent_task` 派发（docs/15：同一轮发多个调用即并行派出；docs/16：派发即返回「已派发」回执、不等待完成）、`agent_followup` 向可复用子代理追加任务（同样非阻塞）、`stop_subagent` 打断与 `archive_subagent` 归档四件派发/控制工具，外加 docs/32 三件**直用**件：`subagent_status` 查看子代理状态表（只读快照——活动子代理运行中/空闲待命的实时用时/上下文占用/任务摘要，`all=true` 附历史记录；不打扰子代理，用户追问进度、寻址前核对 name/subId 用）、`list_files` 列工作区目录的文件与子目录名（只读、不含内容、不递归——核对结构与验收产出落点）、`ask_user` 向用户发起选择题（阻塞等待回答，点选 2~4 个互斥选项或「其它」自由输入）；幻觉调 run_pwsh 仍只会收到「未知工具」）；只做任务分解、派发、验收与整合，系统提示强制任务书自包含（子代理看不到对话历史）、**派发纪律**与**报告处理纪律**（部分报告只简报进度不提前汇总；等待其余报告时简短收尾，报告送达自动开新轮；用户追问进度用 subagent_status 查询后如实转述）与冲突预防纪律；工具各带**精确语义说明**（「子代理工具参考」与「直用工具参考」两段：参数必填项、打断即终结的确切含义、可归档的状态前提等）与**执行纪律**——用户要求停止/归档必须真正调用工具并如实转述返回，**禁止在文字里冒充执行**（没调工具=没执行）；系统提示注入**「子代理（worker）系统提示词说明」段**（docs/20）——子代理实际收到的系统提示词共同部分原文（基础规则、可用工具、可加载技能、MCP 服务器说明与两级 AGENTS.md），据此派发与能力匹配的任务书、不在任务书里重复其中规则，**段尾附 MCP 工具清单与未连接服务器警示**（docs/32：服务器不提供 instructions 时协调者也能看到子代理带哪些 mcp__ 工具、连不上的以「不可用」可见）；worker 的 MCP **会话创建即预热连接**（docs/32 起升级为**首轮闸门**——promise 挂 `rt.mcpReady`，首条消息发出前 await 收口，说明必已就位；连接失败宽限 10s 后**自动重试一次**（冷启动型服务器如 godot-ai 的后端拉起可超单次握手超时），仍失败才对本会话定局并以警示行可见），**两级 AGENTS.md 只在该段出现**（协调者自身不再单独注入，消除重复）
- **运行中即时响应**（docs/8 W2-L2；排队兜底 = docs/7 W2-L1）：协调者任务运行中输入框**保持可用**——消息**立即**发起一次旁路 LLM 调用（带全历史 + 未完成任务的状态占位）**秒级流式回应**，回应缓冲后在本轮工具结果全部回填时**合并进历史**（协调者事后记得这段运行中对话；协议要求用户消息只能排在工具结果之后，多条按到达序）。**即时应答携带三件工具并可真实执行**（docs/32 起白名单三件）：`stop_subagent` / `archive_subagent` / `subagent_status` 随请求下发，模型调用即当场执行（同步快、非阻塞）后再补一次收尾应答——运行中说"打断子代理 X"或"现在进度如何"**即时生效**（后者当场查状态表转述），不再只是文字回应；白名单外的工具调用（幻觉出的 agent_task、阻塞型的 ask_user 等）不执行、以错误文本回填（即时应答不派发新任务、不发起阻塞提问）。interim 不适用（非工具等待窗口）或失败时自动落 📩 排队兜底（当前轮结束后按先后顺序处理，中断后继续）。停止是输入框旁的独立 ⏹ 按钮。普通会话维持「运行中禁止发送、发送键变停止」（其即时应答不带工具，行为不变）
- **后台子代理（worker）**：Agent 实例拥有完整系统工具（pwsh/文件三件套/技能；**无嵌套派发**——结构性禁止）+ **本会话配置的全部 MCP 工具**（docs/6 P2：会话级共享连接、懒加载，信任模型与普通会话一致不走审批；协调者自己仍然不带 MCP），独立历史/上下文/升级额度/spill 与私有临时目录；自己的压缩装配（超压自动压缩）；思考档位继承会话当前值（per-request 可覆盖）；提示词引导**调用解释器用 PATH 短名**（python 而非绝对路径——绝对路径触发工作区外引用审批卡，docs/7 W1-B①）
- **可复用与归档**（docs/9 + docs/10 上下文治理）：子代理分两类——**一次性**（缺省：任务结束即自动归档）与**可复用**（`agent_task` 带 `reusable: true` 派出：任务完成后保留全部上下文待命 💤，协调者用 `agent_followup` 按 name/subId 追加任务（任务书可引用之前的进展——历史延续即复用价值），确定不再使用时 `archive_subagent` 归档；执行中归档会先中止当前任务）；**归档后仅可查看**过程存档（transcript 只读），不可再派任务；每实例任务数上限 `subagentMaxTasks`（默认 12，超出 followup 立即报错）
- **存档注入与重启唤醒**（docs/17）：过程存档（`spill/<sessionId>/sub-N-name/transcript.json`）改为**主对话 SessionData 同构格式**（`kind`=`subagent` + `subagent` 元数据块：累计统计 + 复活所需的 scope/effort/system 构造期参数；旧裸 `{messages}` 格式兼容读取）；**重启唤醒**——服务重启后可复用子代理的运行实例不在线（抽屉行 💤「服务重启过 · followup 自动唤醒」），协调者 `agent_followup` 它时服务端**自动从存档回读完整历史**（`Agent.restore` 与主对话恢复同口径）、按存档 meta 重装实例（同 subId 复活）再执行追加任务，任务数/用量/上下文占比累计延续，三道闸（任务数上限/上下文门槛/并发）照旧生效；存档缺失或损坏时降级为指引重派文案；**休眠待命可直接归档**（docs/35）：重启后休眠的可复用子代理（记录 state:"idle"、实例不在线）在抽屉行正确显示 💤 待命，`archive_subagent` 工具与界面 📦 按钮都能**直接归档休眠记录**（记录定格 archived + archived 事件 + ui 路径状态通知），不再要求先 followup 复活；**存档注入**——`read_archive` 工具把子代理过程存档/主对话记录转成 `[用户]/[助手]/[助手 → 工具]/[工具]` 逐条可读文本注入调用方上下文（不再让模型直接读 JSON）——归档子代理不可再派后，协调者重派新 worker 并在任务书里让它「先用 read_archive（subId=N）读过程存档」，即接续旧工作；上下文门槛拒收/强制归档/归档通知等指引文案同步指向 read_archive
- **子代理上下文治理**（docs/10 R1，三档；docs/14 修订说明载体）：计算该子代理的**上下文占用百分比**（与主对话同口径：上下文总量优先锚定最近一次 API 实测 usage、其后新增内容本地估算补足，无实测数据时回退纯本地估算 ÷ 提供方上下文长度）——**一直显示**：运行中实时估算（抽屉行每 2s 轮询刷新、详情页头部随轮询与事件流、state 快照随发），任务收尾定格进报告 stats 行、idle/archived/done 事件与审计记录——**治理说明只随报告文本走**（docs/14：协调者系统提示不注入治理条目——占用是宿主侧计算的，子代理模型并不知道自己的占用，预先描述只会诱导协调者向子代理索要数据；协调者从报告自带的用量行/预警/拒收/归档说明获知并按指引行事）；**三档处置**：占用 > `subagentWarnContextPct`（默认 25%）→ 报告附「⚠ 上下文过长」预警（仍可追加，建议尽快归档重派）；≥ `subagentFollowupContextPct`（默认 35%）→ `agent_followup` 被**服务端直接拒收**（文案附归档重派与过程存档接续指引）；任务完成时 > `subagentArchiveContextPct`（默认 50%）→ **强制归档**（不转待命，报告说明原因——继续驻留只会诱导向高幻觉风险实例追加任务）
- **并行与配额**（docs/15/16 修订）：并行派发 = 协调者**同一轮发多个 `agent_task` 调用**（工具循环对同轮多调用并行执行；历史会话存档中的 `agent_tasks` 块仍可渲染，工具已退役不再可调）；**派发非阻塞**（docs/16）——每笔调用立即返回「[子代理 X#N 已派发]」回执（回执附指引：报告自动送达、到齐前不要编造或提前汇总），任务在后台执行；超出**并发上限**（subagentMaxConcurrent，默认 3）或**累计上限**（subagentMaxTotal，默认 24/会话，重启按存档记录续期）的派发在同步段**立即拒绝不排队**；每 worker 轮次上限 subagentMaxToolRounds（默认 40，达上限自动收尾交报告）；可选 `timeoutMs`（≥60s）
- **打断即终结**（docs/18，取代 docs/7 W2-S 的暂停/恢复）：**没有暂停挂起、没有恢复**——打断（stop）= 立即中止进行中的 LLM 请求与工具执行（含 pwsh 进程；已完成的进度保留在历史、半截内容作废），任务随即结算：**一次性子代理随之归档；可复用子代理转空闲待命**（保留全部上下文，继续该方向的工作只能用 `agent_followup` 发新任务书，被打断的任务不会自动续跑）。双入口：协调者的 `stop_subagent` 工具（按 name 或 subId 匹配；**任务运行中的插话即时应答同样能真正执行两件控制工具**，见上）与前端抽屉行的 ⏹ 按钮（`POST /api/subagent/control`，同一路由也承载归档 action；**界面打断是协调者看不见的变动，会自动送达「[子代理状态 · 自动送达]」通知**——工具路径的返回文案已抵达协调者，不重复送）；打断结算的失败报告**不重复送达**（通知/工具文案已覆盖同一信息）；失败归因「任务被用户停止」，并发槽随结算立即释放（不再站着空位）
- **完成即时送达，协调者随时收信**（docs/16，取代 docs/11 W1 的「暂停先行返回」）：**派发本就不阻塞**（即时回执），每个子代理任务的每次结算——完成/失败（含空回复、超时、中止）/归档——都以「[子代理任务报告 · 自动送达]」开头的消息进入协调者收件箱（与用户运行中插话同一队列）：**空闲立即开轮处理，忙碌时排队、轮末排空时把紧随其后的连续报告合并为一条只开一轮**（用户消息不合并，顺序不变；**界面把合并消息拆回每份一张独立 🤖 卡片**——按行首送达前缀切段，摘要各归各的报告，真机待办；切回/刷新同路径）——像用户消息一样随时到达，多份报告按完成顺序送达，一次性子代理的报告注明"已自动归档"；归档请求中止的结果带「已按归档请求归档」说明（不再误报"已保留待命"）；界面归档/打断子代理同样送达「[子代理状态 · 自动送达]」通知。协调者收到部分报告时只向用户简报进度或按需干预（追派/打断/归档），全部到齐后再汇总交付
- **子代理运行计时**：每个 worker 计**本次任务用时**（运行中本地 1s 滴答实时显示）与**累计用时**（可复用跨任务累计、一次性=单任务）；任务收尾定格进报告 stats 行（「用时 3m12s」）、抽屉行第一行 ⏱ 徽标（docs/35：与名称并排显示）、详情页头部、idle/archived/done/error 事件与审计记录（随会话存档恢复）；`/status` 可见子代理累计用时
- **冲突治理**（多子代理并行是硬性需求，docs/5 §5）：**文件 hash 乐观锁**（写入校验"本 reader 上次所见"快照，读取后被并行子代理/外部进程改过即拒、重读后可自愈；审批通过后落盘前终检）；**scope 写入分区**（任务书声明允许写入的相对路径前缀——文件工具硬拒；pwsh 守卫强制弹卡由用户裁决，**只读命令豁免**：管道段首 token 全在只读 cmdlet 白名单且无写形态（重定向/写 cmdlet/执行器）时不弹，docs/7 W1-A'；守卫提取也做了精度修正——正则 Pattern 与源码文本不再被当路径，docs/7 W1-A）；**审批串行队列**（一次一卡按序决议，卡带「🤖 来自子代理」来源标注）；中止信号级联到全部在跑子代理
- **可观测性**（SA4 + docs/6 P3 + docs/8 + docs/10-13 + docs/28）：SSE `subagent` 事件驱动（phase：spawned / **delta（docs/28：思考/文字增量流，~120ms 合并批，带 ml 锚点）** / tool（附完整参数 args，docs/28）/ toolResult / task / idle / archived / done / error（docs/18 起 paused/resumed 退役；error 含打断结算）；idle/archived/done/error 载荷带 contextPct 与用时）；顶栏 🤖 开关**子代理侧栏抽屉**（仅协调者会话且有 worker 记录时显示，普通会话零感知）——**列表页**每个 worker **两行结构**（docs/35）：第一行 = 状态图标 + 名称#id + **⏱ 用时 + 上下文占比徽标并排**（行尾对齐，不折叠不换行；超档位附 ⚠ 着色，完整档位说明悬停可见），第二行 = 任务摘要/轮数/用量等统计；运行中置顶 + live 指示 + 状态图标（▶/💤 待命/📦 已归档/✓/✗）+ ⏹ 打断与 📦 归档按钮；上下文/用时**运行中每 2s 就地刷新**（不重渲染详情页、阅读位置不跳，docs/11 W2）、用时本地 1s 滴答；档位线随 /api/meta 下发（>25% ⚠较长、≥35% ⚠不宜再派，docs/10）；**详情页**三态管线：完成后拉取**全程 transcript 存档**（任务书/思考/正文/工具与结果），**运行中实时直播**（docs/28：worker 的思考与文字增量以 ~120ms 合并批流式穿透——与主对话同款打字机/思考框体验，工具调用即时呈现〔折叠头一行摘要与展开体 diff 同主对话〕；4s 轮询服务端实时历史兜底校正，与普通会话同构的全量过程**跨刷新/切会话不丢**，docs/8 第三棒），存档读取失败时由 `tool`/`toolResult` 事件步骤流保底（输出截断 500 字符）；**折叠块完成即收起**——与普通对话同款：工具块结果一到达即折、思考块随消息产出定型折，任意时刻默认展开的只有进行中的块（三种视图同规则，docs/13）；**新增内容不打扰回看**——非贴底时保持阅读位置、展开态冻结（正在读的块不因完成塌掉，重渲染不清屏不闪空，docs/11 W2），贴底自动跟随最新；**⛶ 放大 / ⤡ 缩小**——抽屉占满整页阅读（列表/时间线居中限宽 1000px，内容零重建、阅读位置保留；列表页同样可放大），Esc / 出现审批卡自动回到侧边抽屉（docs/12 A）。主列 agent_task 块只留一行子代理动态摘要 + 🤖 快捷入口（docs/16 起块内折叠体是派发回执，完成报告以 🤖 徽标的「自动送达」气泡进主列）；「📄 过程」入口与报告尾的过程档案标记（`[[过程档案#N]]`）统一进详情页（自动送达气泡同样渲染）——**刷新/重启后仍可点开**；**worker 全程 transcript 落盘**（思考/工具调用与结果/报告，存 spill 私有目录，随会话删除清理；可复用 worker 跨任务累积重写同一存档，运行中拉取以内存活历史优先）；worker 用量一次汇总计入会话合计（token 面板/`/status` 可见：🎯 子代理 N 次·成败·累计输入输出·累计用时）；已完成子代理的审计记录（名字/成败/轮数/用量/上下文占比/用时/时间）随会话存档恢复。过程只在用户点开时进 UI，**不进前台历史/上下文**（两层架构不破）
- 报告超 `subagentResultMaxChars`（默认 32,000 字符，docs/40 上调）自动修剪，剪掉量超阈值时全文落 worker 私有 spill 目录

## 命令审核（approval）

所有有副作用的工具调用都经过**审批服务**，决策是一个封闭词汇表：`allowed-once`（仅当次放行，下次重新审批）/ `rejected` / `cancelled`（等待中被用户中断）/ `unavailable`（不可用，等价拒绝）。**fail-closed**：应答野值/缺失/异常一律按拒绝处理，绝不静默放行。

- **命令摘要**：`run_pwsh` 必须自带 `description`（一句话概括命令目的），缺失直接被拒——审批人先读摘要再读命令；文件工具的 description 可选，弹卡时展示
- **审批卡三段式**：📌 命令摘要 → 命令原文（文件工具为"写入/编辑：路径"）→ 拦截原因列表；模型申请提权时还显著展示 🧬 提权理由；卡上另有**两个权限更改按钮**（docs/30）：「🔓 解除沙箱并放行」= 放行本条并把本会话沙箱切到全开放（区外命令从此真能执行）；「允许并不再询问」= 放行本条并把本会话审批策略切到自动放行（后续拦截卡自动批准，提权卡仍弹）——两者按会话当前状态显隐，随决议原子应用（排队的并行 worker 后卡立即见新模式）
- **逐条确认**：顶栏 🛡 下拉切到「逐条确认」后，**任何沙箱模式下的每条命令与每次文件写入都弹卡**（只读模式下的查看命令也不例外）——批准的是命令本身，执行仍按当前沙箱模式的边界进行
- **自动放行（auto，docs/30）**：顶栏 🛡 下拉切到「自动放行」——拦截卡不再弹出、自动批准：文件工具区外写入静默放行、worker scope 卡自动批；**提权卡例外仍弹人工**（防模型自我升权，升级额度门不拆）；run_pwsh 的命令仍受 OS 沙箱约束（区外写入照样被拒，要真能执行请配合全开放）。「不再询问」改回「正常审批」即恢复弹卡
- **无人值守模式**：顶栏 🛡 下拉切到「无人值守」（CI/挂机场景）——不弹卡、直接按不可用拒绝；切回「正常审批」退出
- **审批策略与沙箱模式运行中可切**（docs/30）：顶栏两下拉在任务运行中不再禁用——工具 live 读会话设置，**下一命令即生效**（审批策略下一次审批即生效）；busy 时的改动由轮结束的自动存档落盘。思考档位维持运行中禁用（服务端 409）
- **审计事件**：每次审批的询问/决议都记入会话存档（`events` 字段，log-only，不进模型上下文；auto 自动放行同样成对记录，带 auto 标注）；`/status` 显示"本会话审批 N 次（批准 M 次）"
- **升级重试（escalation，额度制，会话级）**：run_pwsh 的沙箱每拒绝一次记一次"升级额度"（上限 8，**每个会话独立**），模型在下一次调用带 `justification`（一句话说明为何需要更宽权限）即转交人工审批，批准后以无约束方式执行一次——命令**可以换一种写法**，不必逐字复现被拒命令；额度无论批准与否都被消费。文件工具不需要升级环节（写目标在调用时已知，直接按上面的裁决矩阵弹卡）

## 上下文管理

- **token 度量缓存与实测锚定**：历史消息按对象身份缓存计数（历史是只追加的，新消息才真正分词），上下文估算不再每轮全量重算；**上下文总量优先锚定 API 实测**（usageAnchor：run 内每次请求返回 usage 即记录实测 promptTokens 与请求时刻形状，`contextEstimate` = 实测 + 其后新增的本地估算；压缩/恢复/清空/换提供方后锚点失效回退纯估算，下次请求重建）；思考文本的计数口径与回传条件严格同源（发了才计、计了必发），守住"六类合计=总量"不变量
- **工具结果统一修剪**（docs/10 简化 + docs/40 按工具预算）：在工具注册表层对**所有工具**统一生效——预算按工具解析：工具 `resultBudget` 声明（read_file/read_archive/load_skill 阅读类走 `readToolResultMaxChars`，默认 120,000 字符）> `toolResultMaxChars` 缺省（默认 48,000 字符）；超过预算**只保留预算内头部** + 省略标记（不劈开代理对）；read_file 单次自限 `min(readFileMaxChars, readToolResultMaxChars)`——头部行区间与模型实见内容一致（双层截断失真已消除，docs/40）；UI 始终展示完整输出，修剪只影响入模型的内容；会话累计修剪统计（次数/被剪字符/spill 份数）在 Token 面板一行可见
- **超长输出落盘（spill）**：**触发修剪即全文落盘**（无门槛，docs/10——已剪就存，磁盘成本远小于信息损失），全文存到 `~/.ZQQ-harness/spill/<会话>/`，入模型的文本附 `[完整输出已存盘：<路径>]`——模型有文件工具和 pwsh，需要时自己读；彻底删除/删除会话时连带清理
- **压缩（compaction）**：三个触发入口——
  1. **自动**：每轮开始前上下文占用 ≥ 阈值（默认 80%，服务端下发前端）→ 先压缩再跑轮；
  2. **手动**：`/compact`；
  3. **兜底**：请求撞上"上下文超限"类 400 错误 → 自动压缩并重试该轮一次。

  压缩 = 保留系统提示 + 把早期历史替换为一段工作状态摘要（保留用户目标/决定/路径/进度/未完成事项）+ 保留尾部完整轮次（轮次切点保证 toolCall 与结果不被拆开）。**保留预算按触发方式区分**：自动触发与溢出兜底保留约 30% 上下文窗口的近期工作集；**手动 `/compact` 立即压到最小**（全部消息进摘要，上下文只剩"摘要 + 系统提示/工具等固定开销"），完成后对话底部显示"上下文已压缩"。压缩前的完整历史自动备份为 `sessions/<id>.precompact-<n>.json`（重启后手动可救，环形保留最近 `precompactKeep` 份，默认 3）；压缩记录进 `compactions`；摘要失败/为空则放弃压缩，会话原样保留（宁可压不了，不可压坏）。摘要调用强制关思考（见提供方管理）；**摘要输入防超长为头+尾保留**（尾部留 10% 预算≈30k 字符——尾部是最接近保留工作集的近期上下文，丢了伤最重，docs/40 勘误 docs/10 R2 的 head-only；全文仍在 precompact 备份）。本节的修剪/spill/压缩阈值等运行参数都可经 `harness.json` 覆盖（见[用户级配置](#用户级配置-harnessjson-与外部模块)）

## 沙箱（安全模型）

命令裁决分三层，模式**按对话记录**（顶栏下拉或 `/sandbox`）：

- **🗂 工作区可写（workspace-write，默认）**：命令在 **Windows 受限令牌**下执行——`CreateRestrictedToken` 写受限令牌 + 目录 DACL 能力授权，内核对"写类"访问做双重检查：**只有工作区根目录和私有临时目录可写可删**，其他位置的写入/删除被 OS 拒绝（`Access is denied` 原样回传给模型）。**读不受限**：任何用户可读的文件都能读
- **🔒 只读（read-only）**：同一受限机制但无任何写授权——到处都写不了，适合"只让模型查资料"。注意：**文件三工具在此模式下的写入走审批放行**（批准当次由全权限写入），而 run_pwsh 的写入仍被 OS 沙箱拒绝后走升级审批——两者终态一致（都要人批准），路径不同
- **⚠ 全开放（danger-full-access）**：完全不约束（用户明示），退回守卫+审批；守卫 reasons 仅在逐条确认模式下展示
- **守卫（启发式分析）**：永远运行，但只作为**审批理由生成器**（提示层）——引用工作区外路径、`..` 逃逸、系统级操作等会作为原因出现在审批卡上，不再直接拦截
- **拒绝后的合法出路**：模型可带 justification 走一次人工审批升级（见上文审核）；🛡 无人值守模式下一切按不可用拒绝
- 执行等待为**异步轮询**（0 超时非阻塞探测 + 间隔让出事件循环，docs/19）——长命令（如 Start-Sleep 20s）运行期间服务与全部会话照常响应，⏹ 打断/超时在探测间隔内（≤200ms）生效；超时/中断经 **Job Object**（KILL_ON_JOB_CLOSE）终止整棵进程树——孙进程不残留；`TMP`/`TEMP` 重定向到会话私有临时目录（out/err 采集文件**运行结束即删**，docs/19；启动时按 `sandboxTmpMaxAgeHours`（默认 24h）清扫残留兜底）
- **沙箱后端也是注册制**：`src/modules/sandbox/windows-acl/` 声明可用性（非 Windows 或 koffi DLL 加载失败→不可用）；全部后端不可用时受约束模式 **fail-closed 拒绝执行**（绝不静默放行），全开放模式与审批照常工作

> ⚠️ 诚实边界（照实写，不夸大）：受限令牌只约束**写/删**，**不约束读与网络**；**删除的真实边界取决于位置与 DACL 构成（本机实测）**：工作区内可删；**用户配置文件（~ 及其子目录，如桌面）下的文件能被裸删除**——`[IO.File]::Delete`、`cmd del`、以及从工作区外 Move 到工作区内的跨卷源删除都会真的删掉文件；**其余位置**（数据盘如 `F:\`、`C:\Users\Public` 等仅组授权的目录）**裸删除也会被拦**（`Access is denied`），即使文件 ACL 明确授予了当前用户；DACL 含 **Everyone** 写 ACE 的文件同样能被裸删；`Remove-Item`/`Rename-Item` 因额外申请写类访问在区外一律被拦。需要删区外文件时走审批升级（批准后以无约束方式执行）；NTFS **硬链接**可跨路径别名同一文件；`NUL` 设备因设备 DACL 设计仍可写；目录 DACL 授予是**常驻变更**（能力 SID 由工作区路径哈希确定性派生，跨重启复用；需要当前用户对该目录有 DACL 写权限，通常即目录所有者）；**未经安全审计，只防误操作，不得作为对抗恶意代码的边界**——需要强隔离请用虚拟机/容器。

## MCP 外部工具

支持以 **MCP 客户端**（stdio 传输）接入任意 MCP 服务器，工具自动注册为 `mcp__<服务器>__<工具名>` 供模型调用（零额外依赖，自带最小 JSON-RPC 实现）。配置分两级：

- **全局**：`~/.ZQQ-harness/mcp.json`（所有工作区可用）
- **工作区级**：`<工作区根>/mcp.json`（仅选中该工作区时连接；**同名时覆盖全局**）

```json
{
  "mcpServers": {
    "demo": { "command": "node", "args": ["F:/MyClaw/ZQQ-harness/scripts/demo-mcp-server.mjs"] },
    "anything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
  }
}
```

**安装/卸载/查看：让模型调 `manage_mcp` 系统工具**（见[系统工具](#系统工具)）——自动校验、原子写入、立即重连并回报连接结果，**同一对话装完下一轮即可调用，不需要重启或新建对话**。也可以手工编辑 mcp.json：改动在"会话创建或切换工作区"时加载（此时是宽松加载——单个文件损坏只会被跳过，不影响其他服务器与会话启动）。

- 切换工作区时**动态重连**：旧工作区的服务器断开并注销工具，新工作区的配置叠加全局生效；`/status` 与顶栏状态可查看连接来源（全局/工作区）与工具数
- **instructions 注入**：服务器在 MCP 握手时提供的使用说明（`initialize.instructions`）会自动拼进系统提示（分服务器标注来源）；用量计入明细的「MCP」分类
- Windows 下 `npx`/`npm`/`pnpm`/`yarn`/`bun` 及 `.cmd`/`.bat` 自动经 `cmd /c` 启动，command 直接写 `npx` 即可；其他可执行文件写绝对路径（JSON 里用正斜杠）
- Python 服务器自动注入 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`（配置的 env 可覆盖），中文参数不乱码
- 服务器 **stdout 只允许输出协议 JSON**（日志必须走 stderr，否则握手必败）；握手超时 20 秒（`mcpHandshakeTimeoutMs` 可调，慢启动服务器可放宽）——首次运行要下载依赖/模型的服务器会启动失败，manage_mcp 会回报原因，先在终端手动跑一次预热再重试；工具调用超时 60s（`mcpCallTimeoutMs` 可调）；单个服务器启动失败不影响其他；进程退出时自动清理子进程
- **信任模型**：MCP 工具是你显式配置的可信工具，不走 pwsh 的工作区守卫与沙箱（按需自行审核配置文件）
- 自定义服务器参考 `scripts/demo-mcp-server.mjs`（stdin/stdout 换行分隔 JSON-RPC 2.0，add/echo 两个工具）
- 传输类型当前仅支持 `stdio`（缺省值）；传输层已抽象（`McpTransportDef` 注册表），未来可扩展 http/SSE

## 技能（Skills）

以 **SKILL.md 目录约定**给 agent 添加可复用指令包。系统提示只注入"技能名 + 描述"清单（几十个 token，在用量明细中单列为"技能"），模型判断任务相关时才调用 `load_skill` 工具加载全文照做——常驻开销极小，全文只花一次。

- **全局技能**：`~/.ZQQ-harness/skills/<技能名>/SKILL.md`（所有工作区可用）
- **工作区技能**：`<工作区根>/skills/<技能名>/SKILL.md`（仅该工作区可用；**同名覆盖全局**）
- frontmatter 提供 `name`（缺省用目录名）与 `description`（用于模型判断何时加载），正文即模型要遵守的完整说明

```markdown
---
name: commit-helper
description: 为本项目生成规范的 git 提交信息
---

# 提交信息规范
（正文：模型加载后要遵守的完整指令……）
```

- **热重载，无需重启**：每轮对话开始自动重扫技能目录，新增/修改/删除技能发消息即生效；`/skills` 可随时手动重扫并列出当前技能；切换工作区/加载旧会话时也会重扫；`/status` 可查看当前生效的技能列表
- 技能目录来源同样是注册制（`SkillSourceDef`），当前注册全局/工作区两个来源

## 用户数据与工作区指令

- 用户数据统一存放在 `~/.ZQQ-harness/`（`~` 即用户主目录，Windows 下为 `C:\Users\<用户>`；代码用 `os.homedir()` 动态定位，非硬编码）：`.credentials.yaml`（API key，仅首次迁移期读取）、`providers.json`（提供方配置，含 key）、`harness.json`（用户级覆盖：模块启停 + 运行阈值，见下节）、`modules\`（外部模块目录，见下节）、`sessions\`（对话记录；拖动排序 `order.json`——只存各工作区对话的手动顺序、不删对话本体，启动自愈清死 id/空键；会话所属工作区被移出列表后作为「孤儿组」显示在树尾，组内可拖动排序、拖动工作区行即把它收编回列表；压缩前备份 `*.precompact-*.json` 环形保留最近 `precompactKeep` 份，默认 3）、`workspaces.json`（工作区列表与树顺序，不设上限）、`mcp.json`（全局 MCP）、`AGENTS.md`（全局工作区指令）、`skills\`（全局技能）、`spill\`（超长工具输出全文，随会话删除清理；启动时按 `spillMaxAgeHours`（默认 168h）清扫超龄）、`attachments\`（图片附件内容寻址库 docs/33——字节按 sha256 只存一份、会话档只存引用；**永不自动清理**，删档不删图）、`tmp\`（沙箱私有临时目录；out/err 采集文件运行结束即删，docs/19；启动时按 `sandboxTmpMaxAgeHours`（默认 24h）清扫残留兜底）；旧版本放在项目根的数据**首次启动自动迁移**（跨盘亦可）
- **AGENTS.md（两级注入）**：全局 `~/.ZQQ-harness/AGENTS.md` 对所有工作区生效；工作区根目录的 `AGENTS.md` 仅该工作区生效，与全局冲突时**以工作区为准**。两者都作为附加系统指令注入（每轮对话开始自动重读，改动即时生效；过长各截断至 16k 字符），在系统提示中全局段在前、工作区段在后

## 用户级配置 harness.json 与外部模块

`~/.ZQQ-harness/harness.json` 是可选文件（缺失 = 全缺省；损坏/字段非法 → 告警并回落缺省，绝不阻止启动；**启动时读取一次，改后需重启**）。**支持 JSONC 注释**（`//` 行注释与 `/* */` 块注释，字符串内的注释符不受影响）——可逐键标注用途；纯 JSON 同样合法：

```json
{
  "disabledModules": ["tools.pwsh", "web.workspaces"],
  "thresholds": {
    "compactionPressure": 0.8,
    "compactionKeepRatio": 0.3,
    "compactionManualKeepTokens": 0,
    "defaultContextLength": 1000000,
    "maxToolRounds": 15,
    "pwshTimeoutMs": 60000,
    "pwshMaxTimeoutMs": 300000,
    "toolResultMaxChars": 48000,
    "subagentMaxConcurrent": 3,
    "subagentMaxTotal": 24,
    "subagentMaxToolRounds": 40,
    "subagentResultMaxChars": 32000,
    "subagentMaxTasks": 12,
    "subagentStatusHistoryMax": 20,
    "subagentWarnContextPct": 25,
    "subagentFollowupContextPct": 35,
    "subagentArchiveContextPct": 50,
    "archiveRenderMaxChars": 160000,
    "escalationMax": 8,
    "agentsMdMaxChars": 16000,
    "mcpHandshakeTimeoutMs": 20000,
    "mcpCallTimeoutMs": 60000,
    "pwshCaptureMaxBytes": 1000000,
    "precompactKeep": 3,
    "spillMaxAgeHours": 168,
    "sandboxTmpMaxAgeHours": 24,
    "visionTimeoutMs": 120000,
    "providerTestTimeoutMs": 20000,
    "textFileMaxBytes": 5242880,
    "readFileDefaultLines": 4000,
    "readFileMaxChars": 200000,
    "readToolResultMaxChars": 120000,
    "subagentTimeoutMinMs": 60000,
    "compactionSummaryMaxChars": 300000,
    "httpBodyMaxBytes": 33554432,
    "imageTokenEst": 800
  }
}
```

- **disabledModules（模块启停）**：按模块名从组合清单过滤（内置与外部模块一视同仁）。禁用不存在的名字会在启动日志提醒（防打字错误）；被保留模块 `dependsOn` 被禁模块 → 启动失败并指名（装配器 fail-fast）。禁用 UI 模块（如 `web.workspaces`）对应功能即消失——请知道自己在做什么。
- **thresholds（阈值覆盖）**：三十六个运行阈值——子代理九个（并发/累计/轮次上限、报告预算、可复用任务数上限、上下文预警线/followup 门槛/强制归档线，docs/10；存档注入渲染预算 `archiveRenderMaxChars` 默认 160k，docs/17）+ **阶段 B 第一批八个**（docs/21 §2.3 / docs/22 §4.2）：`escalationMax` 审批升级额度（默认 8）、`agentsMdMaxChars` AGENTS.md 注入截断（16k）、`mcpHandshakeTimeoutMs`/`mcpCallTimeoutMs` MCP 握手/调用超时（20s/60s——慢 MCP 服务器或首次下载依赖时可放宽）、`pwshCaptureMaxBytes` 输出采集软上限（1MB）、`precompactKeep` 压缩备份保留份数（3，环形覆写）、`spillMaxAgeHours`/`sandboxTmpMaxAgeHours` 启动清扫年龄（168h/24h）+ **阶段 B 第二批九个**（docs/21 §2.3 后段）：`visionTimeoutMs` 视觉分析超时（120s）、`providerTestTimeoutMs` 提供方测试连接超时（20s）、`textFileMaxBytes` 文件三工具大小边界（5MB）、`readFileDefaultLines`/`readFileMaxChars` read_file 缺省行数/单次字符上限（4000/200k）、`readToolResultMaxChars` 阅读类工具（read_file/read_archive/load_skill）修剪预算（120k，docs/40——大文档单次可读量不再被通用预算锁死）、`subagentTimeoutMinMs` 子代理任务可申请超时下限（60s）、`compactionSummaryMaxChars` 压缩摘要输入预算（300k）、`httpBodyMaxBytes` 请求体上限（32MB，**校验强制 ≥ 图片消息 base64 地板值**）、`imageTokenEst` 每图 token 估算（800，换视觉模型可校准）。键省略即用缺省；非法值（越界/类型错）逐项忽略并告警；未知键告警（检查拼写）。生效值收敛在 `config.ts` 单一 `THRESHOLDS` 对象（docs/40 阶段三：`initConfig` 原地 `Object.assign` 重绑，对象身份恒定）下发——所有消费方（压缩触发/保留预算、工具轮次、pwsh 超时、修剪预算、默认上下文、子代理配额与上下文治理、文件工具边界、请求体上限）零改动即被覆盖，`/api/meta` 同步反映。（`spillThreshold` 已废弃——docs/10 起修剪触发即落盘无门槛；已配置的旧键静默忽略不告警。docs/21 阶段 A 起三个压缩键更名为 `compaction*`（历史拼写错误修正），**旧拼写 `compection*` 三键双读兼容**——读到即映射到新键并告警更名提示，建议改用新键。）**可视化编辑（docs/24）**：Web UI 顶栏 ⚙ 打开「运行阈值」面板——分组/说明/范围/默认值全部由服务端 schema 下发（`thresholdSchema()` 单一出处，前端零硬编码），保存走严格校验（任一键非法整体 400 拒绝指名该键）→ 原子写回纯 JSON（注释会丢，值不变）→ `initConfig()` 热应用（各运行时读取点立即生效、`/api/meta` 随之反映，**包括运行中会话的工具轮次上限**；`spillMaxAgeHours`/`sandboxTmpMaxAgeHours` 清扫与 `disabledModules` 装配标「重启后生效」；子代理轮次上限按后续派发生效）。`disabledModules` 面板内只读展示。
- **外部模块目录 `~/.ZQQ-harness/modules/*.ts`**：每个文件 `export default` 一个模块对象（`{ name, dependsOn?, setup(ctx) }`），在内置模块之后按文件名序装载。模块体可以**零 import**——`setup(ctx)` 收到的 `ctx` 上就是各扩展点注册表（`ctx.tools` / `ctx.routes` / `ctx.promptSections` / `ctx.skillSources` …），直接 `register` 即可；需要类型提示时用 `import type` 从本项目 `src/core/*` 引入（`import type` 在类型擦除后零运行时开销，不会产生真实依赖）。**宽松装载**：导入失败 / 缺合法 default 导出 / 与已有模块重名 / `dependsOn` 不在已装配清单 → 打印错误并跳过该文件，不影响其余模块与应用启动；`setup` 抛错仍 fail-fast 退出（错误信息带模块名）。`*.test.ts` 不装载；多个外部模块按文件名序可互相依赖（先装载者可为后者的依赖）。

## 斜杠命令

只保留没有其他 UI 入口的命令：`/help` 帮助 ｜ `/status` 状态（模型/工作区/审批计数/token 与 MCP/技能明细）｜ `/compact` 压缩会话（立即把上下文压到"摘要 + 固定开销"，对话底部显示"上下文已压缩"）。其余操作都有专职 UI：思考档位/沙箱模式/审批策略=顶栏三个下拉（按当前对话记录），切换工作区/新建对话=侧边栏工作区树与「＋ 新对话」，技能=每轮自动重扫。（任务运行中斜杠命令被挡且不误触停止）

## 架构

**模块化架构（docs/4，P0–P8 已全部实施）**：`src/core/` 是零依赖内核（注册表 + 扩展点类型 + 共享机制），`src/modules/` 是能力模块，**产品 = `src/modules.ts` 的 BUILTIN_MODULES 组合清单**——增删能力的唯一登记处。模块之间禁止互相 import（import 图哨兵强制）；共享下沉 core 或经 `HarnessContext` 交换。每类扩展点一张注册表（register 返回 disposer）：系统工具、提供方格式、MCP 传输、沙箱后端、技能来源、系统提示 section、API 路由。用户级启停/阈值覆盖（`harness.json`）与外部模块目录（`~/.ZQQ-harness/modules/*.ts`）在 bootstrap 装配时接入；子代理 seam（`ctx.subagent`）已预留。

```
src/
├── modules.ts            BUILTIN_MODULES 组合清单（产品=这张表，21 个模块）
├── core/                 零依赖内核
│   ├── registry.ts       Registry<T, K>：按键注册/注销，重复注册抛错
│   ├── context.ts        HarnessContext：7 张注册表 + 路径 + sessionHost 接缝
│   ├── types.ts          各扩展点 Definition（SystemToolDef/ProviderFormatDef/
│   │                     McpTransportDef/SandboxBackendDef/SkillSourceDef/RouteDef…）
│   ├── module.ts         HarnessModule + loadModules（依赖校验，fail-fast）+
│   │                     loadExternalModules（外部模块宽松装载）
│   ├── events.ts         SSE 13 事件名单一出处（两端契约测试锁定）
│   ├── sections.ts       系统提示 section 装配（六内置段；"可用工具"行自动生成；
│   │                     base 段按 normal/coordinator 分支渲染；协调者段带精确的
│   │                     子代理工具参考 + 执行纪律（禁止文字冒充工具调用）；两级
│   │                     AGENTS.md 段对 coordinator 不注入——移入「子代理系统提示词
│   │                     说明」段（docs/20，web 层注册）避免重复）
│   ├── host.ts           SessionRuntime / SessionHost 接缝（web 壳实现）
│   ├── http.ts           ServerRequest/readBody/json（路由模块不触碰 node:http）
│   ├── skills.ts         技能扫描/解析机制（skillDirsOf 多来源合并）
│   ├── file-tools.ts     文件三工具共享机制（路径解析/已读台账（hash 乐观锁，per-reader
│   │                     快照）/EOL 归一/二进制嗅探/原子写/精确编辑/写入裁决矩阵+scope）
│   └── contract.test.ts  契约测试：SSE 三端事件名、系统提示 golden、扩展成本哨兵
├── modules/
│   ├── providers/openai|anthropic/   两种接口格式（ProviderFormatDef + thinkingPassback 能力声明）
│   ├── tools/agent-task/  协调者专用 agent_task + agent_followup +
│   │                    archive_subagent + stop_subagent + subagent_status（audience=coordinator）
│   ├── tools/ask-user/    ask_user 询问用户选择题（audience=front——普通+协调者，
│   │                    子代理不注册，docs/32）
│   ├── tools/list-files/  list_files 只读目录清单（audience=coordinator，docs/32）
│   ├── tools/pwsh|load-skill|read-file|read-archive|write-file|edit-file|
│   │        mcp-manage|view-image/  八个系统工具（read_archive=存档注入，docs/17；
│   │        view_image=视觉模型分析图片，docs/10；read-image/=read_image
│   │        视觉直读图片进对话（图像块挂 tool 消息），docs/34）
│   ├── mcp/stdio/        stdio 传输（JSON-RPC 客户端；cmd /c 包装、PYTHONUTF8 注入）
│   ├── sandbox/windows-acl/  受限令牌沙箱后端（koffi 懒加载，available() 探测）
│   ├── skills/fs-source/ 全局+工作区两个技能目录来源
│   └── web-{approval,desktop,providers,sessions,settings,static,workspaces}/  全部 /api/* 路由（web.desktop=DT3 桌面偏好 desktop.json 读写）
│                         + web-static：/app/*.js 前端 ES 模块静态服务（docs/26 F1——
│                         精确注册 + text/javascript + no-cache；新增模块文件需重启注册）
├── agent.ts              Agent 循环（工具 schema 每轮重取；思考存档/回放降级告警；
│                         压缩/溢出重试；setSkills/setProvider/setVision/setSandboxMode/setMcpInstructions；
│                         run 支持 user 消息携带图片——docs/10 R3）
│                         + interject 运行中旁路即时回应与轮末合并（docs/8）——
│                         协调者即时应答携带两件控制工具（stop/归档）并真实执行（docs/18）
│                         + usageAnchor 上下文总量锚定 API 实测 usage
│                         + runSubagent（P8 预留 seam 的子代理运行机制）
├── compaction.ts         压缩：轮边界切点 + 溢出错误识别
├── tokens.ts (+bpe.ts)   真实分词六类计数 + DeepSeek v4 tokenizer 纯 JS BPE
│                         + 图片 token 固定估算（IMAGE_TOKEN_EST，docs/10）
├── config.ts             运行常量 + 前端设置项唯一出处（档位/沙箱选项与别名/默认上下文，
│                         经 /api/meta 下发）+ REASONING_PASSBACK 开关
│                         + harness.json 解析（P8：阈值生效值 + 模块禁用清单；
│                         SA0：子代理四阈值）
├── workspace.ts          工作区判定 + 命令启发式守卫（审批理由生成器 + scope 越界检测）
├── mcp/
│   ├── manager.ts        多服务器管理：断开→合并→重连（宽松加载：坏文件跳过）
│   └── config.ts         mcp.json 严格层：解析校验/条目校验/原子写（损坏拒改）
├── providers/store.ts    providers.json 读写 + 迁移（白名单查格式注册表）
├── approval/types.ts     审批封闭决策词汇 + fail-closed 归一化 + 审计事件
├── sandbox/types.ts + runner.ts   沙箱模式 + 执行器接缝（无后端 fail-closed）
├── llm/provider.ts       LLMProvider 抽象 + ChatMessage.thinking + 用量/分类类型
├── tools/registry.ts     会话工具注册表（错误回传 + 统一修剪 executeWithMeta）
├── tools/prune.ts        头部保留修剪 + 触发即全文落盘（spill，docs/10）
└── web/
    ├── server.ts         瘦壳（≤278 行哨兵：DT0 250→270；2026-11-16 真机回归 270→278——
    │                     WinNAT 端口回退属监听生命周期，合法进壳）：bootstrap 装配
    │                     （harness.json 模块过滤 + 外部模块装载）+ 静态页 + SSE + /api/meta + 路由查表分发
    ├── session-runtime.ts    每会话装配（工具按 kind 分流实例化/MCP 重连/审批串行接缝/
    │                     状态快照/子代理服务注入与存档恢复）
    ├── session-lifecycle.ts  工作区绑定/视图切换/存档（kind/subagents 审计随档）/
    │                     空占位清扫/运行轮 + 协调者收件箱轮末排空（相邻自动送达
    │                     报告合并为一轮，docs/16）
    ├── subagents.ts      子代理家族门面（docs/21 §3.1 D1 拆分）：SubagentService
    │                     （subagentServiceFor）+ 非阻塞派发（tryStartWorker/startWorker
    │                     同步段配额+登记+回执，docs/16）+ 控制入口（applySubagentControl）+
    │                     协调者「子代理系统提示词说明」段（docs/20）；家族公共面 re-export
    │                     （消费方 import 路径不变）
    ├── subagent-worker.ts    worker 装配三态共用件（createWorkerSession 控制句柄/驻留登记 +
    │                     mountWorkerAgent 独立 registry+系统提示 + makeWorkerUi 过程流 UI
    │                     聚合器 + workerMcpToolsOf 会话共享 MCP 懒加载）
    ├── subagent-report.ts    任务执行结算（runOneTask：信号/审批闭包/报告修剪/transcript
    │                     累积/用量守恒/idle↔归档分流）+ 报告格式化（reportMessage）+
    │                     收件箱送达（deliverToCoordinator FIFO，docs/11+16）+
    │                     上下文治理三档（contextPctOf + 35% followup 门槛/50% 强制归档，docs/10）+ 失败归因（docs/18）
    ├── subagent-archive.ts   transcript 落盘（SessionData 同构，docs/17）+ 存档宽容解析 +
    │                     read_archive 解析接缝（archiveSourceOf）+ 归档入口
    │                     （requestArchiveWorker）+ 重启唤醒（reviveFollowup）
    ├── subagent-records.ts   WorkerSession 驻留类型（用量/计时/累计字段）+ 审计记录
    │                     （upsert/reusable/finish）+ 用量聚合上报（守恒）+ 归档终结
    │                     （finalizeArchive）——家族叶子
    ├── sessions.ts       会话存档 + 回收站 + 手动排序 + spill 清理
    ├── workspaces.ts     工作区注册表（树顺序/重排/删除遗忘）
    └── public/           前端（无构建：原生 ES Modules；禁止 node_modules 构建链与
                          前端 npm 依赖，模块间 import 一律相对路径——docs/26 F4 不变量）：
        ├── index.html    骨架 + CSS + 单外链 /app/main.js（≤500 行哨兵锁定；
        │                 F4 前视图代码全在此内联，2,906 行 → 473 行）
        └── app/          ① 纯逻辑五模块（node:test 直测 + checkJs 严检；零依赖、
            │             禁 DOM——哨兵锁定）：replay.js（事件路由/缓冲过滤/乒乓防护）、
            │             turns.js（轮分组/折叠决策）、autoreport.js（送达解析/格式化）、
            │             store.js（手写状态仓 get/set/subscribe + 微任务合并 flush）、
            │             toolinfo.js（工具块展示信息：折叠行摘要与展开体片段，
            │             主对话/时间线共用，docs/28）
            └② 视图七模块（docs/26 F4 大分区，无环分层 dom→state→{drawer,sidebar}→
                          chat→modals→main 入口；import 图经 tsconfig.frontend-view.json
                          检查）：dom.js（el/esc/mdLite/滚动/keyed/post）、state.js
                          （chat/view/prov-set 三区状态仓 + CFG + meta 助手）、drawer.js
                          （子代理抽屉家族 + makeTimeline）、sidebar.js（工作区树/回收站/
                          拖拽；会话切换经回调槽注入）、chat.js（消息渲染/applyState/
                          token 面板/renderHistory）、modals.js（提供方+运行阈值+工作区
                          浏览三模态，纯副作用装载）、main.js（入口：SSE_HANDLERS 表/
                          切换竞态/发送/图片/命令）；drawer/tree 两区 store 随区域模块就地
                          建仓，applyState 为 chatStore 订阅者（docs/26 F2 语义不变）
scripts/
├── smoke.ts              真机冒烟：连通性 / 工具闭环 / 审批拒绝
├── smoke-anthropic.ts    anthropic 路线冒烟：多轮工具 + 思考存档/回放
├── smoke-subagent.ts     SA1 子代理冒烟：真实装配 + worker 工具循环（零 token）
├── smoke-sa2.ts          SA2 协调者产品化冒烟：进程内 + HTTP（零 token）
├── smoke-sa3.ts          SA3 并行派发 + 冲突治理 + 打断/插话/可复用生命周期冒烟（零 token）
├── smoke-sa4.ts          SA4 可观测性冒烟：SSE 事件 + 审计存档往返 + 抽屉前端断言（零 token）
├── e2e-sa4-stub-llm.mjs  浏览器端到端的桩 LLM（本地 OpenAI 兼容 SSE 端点，零 token）
├── e2e-dbg-*-stub.mjs    真机排查复现桩（switch=切走切回实时流 / liveview=工具型 worker
│                         实时视图 / reuse=可复用生命周期四轮 / revive=存档注入+重启唤醒六阶段
│                         HTTP 级端到端；零 token，docs/8-9/17 保留在库）
├── probe-anthropic-sse.ts   直连端点统计 SSE 事件类型（排障探针）
├── probe-mcp-encoding.ts  MCP stdio 中文往返验证探针
└── demo-mcp-server.mjs   最小 MCP 服务器示例（add/echo）
```

**每会话一份 SessionRuntime**（agent/工具注册表/MCP 管理器/设置/审批/中止控制各自独立），这是多会话并行与"每会话独立升级额度/已读台账"的基础。**前端设置项（思考档位、沙箱选项与别名、默认上下文、压缩阈值、提供方格式清单）单一出处是 `config.ts`**，经 `/api/meta` 下发，前端零硬编码。

## 开发

```bash
npm run typecheck        # tsc 类型检查（noEmit，直接 node 跑 TS）
npm test                 # node:test 单元测试 465 项（含契约测试/哨兵与沙箱真实执行测试，需 Windows + pwsh；**显式文件清单**——新增测试文件须同步登记 package.json）
npm run smoke            # 真实 API 冒烟：连通性 / 工具闭环 / 审批拒绝（消耗少量 token）
npm run smoke:anthropic  # anthropic 路线冒烟：多轮工具 + 思考存档/回放（消耗少量 token）
npm run smoke:subagent   # 子代理机制冒烟：真实装配 + 非阻塞派发 + worker 工具循环 + 审批标注（零 token）
npm run smoke:sa2        # 协调者产品化冒烟：进程内装配 + HTTP 面（零 token）
npm run smoke:sa3        # 非阻塞派发与完成送达 + 冲突治理 + 打断即终结/可复用生命周期冒烟（零 token，11 场景）
npm run smoke:sa4        # 可观测性冒烟：SSE subagent 事件 + 审计存档往返 + 前端抽屉源码断言（零 token）
```

约定：TypeScript 直接以 Node 原生 type-stripping 运行（Node ≥22），import 需带 `.ts` 扩展名；`erasableSyntaxOnly`（不用 enum / 构造器参数属性）。运行依赖仅 `openai` SDK + `koffi`（Windows 沙箱 FFI，锁定精确版本）+ node 内置，零框架零构建。**新增系统工具的范式**：`src/modules/tools/<名字>/` 定义 `SystemToolDef`（name/summary/create）→ `src/modules.ts` 清单加一行——系统提示工具行、schema 下发、修剪、审批接缝全部自动生效。

深入设计文档（`docs/`，头部均有实施记录）：

- `1_开发文档-沙箱-审核-上下文管理.md`——沙箱/审核/修剪/压缩的设计基准与实现记录
- `2_开发文档-思考内容管理.md`——思考内容的展示/存储/回传/计数四通路设计（DSH 对齐）
- `3_交接文档-多会话并行与运行中切换.md`——多会话架构、SSE 事件协议、历史 bug 档案与回归清单
- `4_开发文档-模块化架构重构.md`——模块化架构设计 + P0–P8 分阶段实施记录 + 增量特性记录（系统工具扩充、命令瘦身与压缩/收纳修正、逐条确认作用域与工作区基准修正）+ §6 不变量清单
- `5_开发文档-子代理两层架构与大型任务管理.md`——协调者/子代理两层架构 + SA0–SA4 分阶段实施记录 + 多子代理冲突治理专项设计
- `6_交接文档-协调者模式真机反馈三项问题.md`——真机反馈排查交接：停止与审批卡死锁（P0）/ worker 接 MCP（D3 修订）/ worker 过程可见性
- `7_交接文档-协调者审批误报与运行中对话及子代理暂停.md`——第二轮真机反馈交接：scope 守卫误报（正则/源码当路径）/ 协调者运行中持续对话与子代理暂停恢复
- `8_交接文档-运行中即时响应与子代理查看界面改造.md`——第三轮：协调者运行中即时回应（interim 旁路）/ 子代理查看异常排查 / 侧栏抽屉与运行中实时历史轮询
- `9_交接文档-子代理可复用与归档机制.md`——子代理分类：可复用（reusable 派发 + agent_followup 追加 + archive_subagent 归档）与一次性（用完即归档）；归档后只读
- `10_交接文档-子代理上下文治理与修剪简化及视觉支持.md`——子代理上下文占用记录与 35%/50% 双线治理 / 工具结果修剪改「头部保留 + 触发即全文落盘」/ 视觉支持（图片消息 + view_image 工具 + 视觉模型配置）
- `11_交接文档-子代理异常变动报告与详情页跳变修复.md`——暂停即解除阻塞 + 最终结果按序自动送达协调者 / 归档状态文案修正（不再误报待命）/ 详情页阅读位置稳定三修复（轮询就地更新、去预清空、展开态冻结）
- `12_交接文档-子代理抽屉放大与视觉链路修复.md`——抽屉 ⛶ 放大/缩小（全屏↔侧栏）+ 视觉链路真修复（server.ts 适配器丢参——图片从未到达模型；视觉会话系统提示指引 + view_image 自身视觉优先 + Ctrl+V 粘贴收图）
- `13_交接文档-子代理详情折叠块完成即收起.md`——时间线默认展开规则与普通对话对齐：工具块结果到达即折（addToolRes 语义）、思考块产出定型即折（endThink 语义），任意时刻默认只展开进行中的块；回看冻结与手动开关优先级不变
- `14_交接文档-协调者提示词去上下文治理条目.md`——删「子代理上下文开销」提示词条（防协调者向子代理索要其不知道的用量数据）；用量+>25% 预警随报告自动附带（formatWorkerResult 已有，补自动送达路径锁定测试）
- `15_交接文档-agent_tasks退役与同轮并行派发.md`——删 agent_tasks 批量工具（协调者 registry 六件→五件）；并行派发 = 同一轮多个 agent_task 调用（agent.ts 工具循环对协调者同轮多调用并行执行，普通会话保持顺序）
- `16_交接文档-子代理完成即时送达与派发非阻塞化.md`——agent_task/agent_followup 非阻塞派发（派发即返回回执）；每个子代理任务的结算（完成/失败/暂停/归档）一律经收件箱自动送达协调者（忙碌时轮末合并相邻报告为一轮）；界面暂停/归档自动送达状态通知；docs/11 的暂停先行返回（facing）通道退役
- `17_交接文档-过程存档注入与可复用唤醒.md`——存档改主对话 SessionData 同构格式（subagent meta 携带复活用构造期参数）；followup 自动唤醒重启后的可复用子代理（同 subId 历史延续）；read_archive 存档注入工具（JSON→可读文本，兼容新旧存档与主对话记录）
- `18_交接文档-暂停恢复退役与打断即终结及送达摘要.md`——pause/resume_subagent 退役、stop_subagent 打断即终结（一次性归档/可复用转待命，无恢复，打断结算失败报告不送达）；自动送达消息用户气泡默认一行摘要（✓/✗ 着色 + 展开全文）
- `19_交接文档-沙箱同步等待堵塞事件循环修复.md`——windows-acl 执行器等待循环异步化（0 超时探测 + 让出事件循环；长命令运行期间全局 UI/⏹ 打断不再卡死）+ 采集句柄泄漏修复（out/err 文件运行结束即删）
- `20_交接文档-协调者注入子代理系统提示词说明.md`——协调者系统提示注入「子代理（worker）系统提示词说明」段（worker 的工具/技能/MCP 说明/两级 AGENTS.md 原文重放，MCP 首连热更）；AGENTS.md 两段不再单独注入协调者（消除重复）
- `21_开发文档-架构可维护性审计与参数化改进.md`——2026-11-14 全项目架构审计：分层评估、硬编码参数全清单（P0 矛盾修复 / P1 配置化候选 16 键 / P2 常量收敛 / P3 保持现状）、前端渐进改造路线、subagents.ts 拆分方案、分阶段实施路线图与不变量清单——**改参数/改架构前先读**（头部有阶段 A 实施记录：P0 修复 7/8 项已落地）
- `22_交接文档-阶段A维护实施与后续接力.md`——阶段 A 实施交接：git 基线与 commit 结构、本次全部改动清单与验证证据、踩坑记录（npm test 显式清单等）、剩余工作与接力入口（IMAGE_RULES → 阶段 B/C/D）
- `23_交接文档-阶段D结构优化接力.md`——第三棒交接：A/B/C 三段成果摘要（384 测试基线）、阶段 D 三项（subagents.ts 拆五块 / config 惰性化 / 前端渲染统一）的入口与约束、可选阶段 B 第二批 8 键、踩坑记录（双哨兵/模板字面量插值/taskkill 等）与不变量清单
- `24_交接文档-前端设置入口与harness热应用.md`——第四棒交接（**已实施**，头部含实施记录）：Web UI「运行阈值」设置入口——THRESHOLD_RULES 上提 + thresholdSchema 单一出处、web-settings 模块 GET + /save POST（严格校验+原子写+initConfig 热生效）、热生效边界三类（立即跟随/新会话生效/需重启）、schema 驱动前端（零硬编码哨兵）、GUI 冒烟两处修复（确认行顺序、两步关闭确认）
- `25_开发文档-桌面端版本方案.md`——桌面端版本方案（**DT0–DT3 已全部实施**，头部含实施记录）：2026-11-15 架构复审评级 + 三档路线（L0 现状 bat / L1 Edge 应用模式 / L2 Electron 薄壳推荐）+ 服务端就绪化（DT0：127.0.0.1 绑定/动态端口握手/优雅停机）+ 壳落地与打包分发（DT1–DT3）+ 维护纪律（壳不进业务、双入口回归、Electron 升级核对单）
- `26_开发文档-前端架构优化与桌面端统一路线.md`——前端优化与桌面端**统一总路线**（**实施顺序以此为准；F1–F4 已全部实施**，头部含实施记录）：前端五痛点诊断（竞态不可测/状态无封装/整列表重灌/单文件无边界/哨兵联动）+ 核心决策「无构建 ≠ 单文件」（原生 ES Modules + node:test 直测 + checkJs）+ F1 纯逻辑抽离（replay/turns/autoreport 三模块与 web-static 模块）→ F2 store 化（app/store.js 手写状态仓 + ~22 顶层变量五区迁仓 + applyState 订阅化）→ F3 渲染 keyed 收官（抽屉列表/回收站/提供方列表三点 + renderHistory/makeTimeline 豁免及其依据）→ F4 大分区拆文件（视图七模块无环分层 + index.html 骨架化 ≤500 行 + 不变量正式修订）+ 否决记录（不引框架/CDN）+ 与 DT 线的四梯队编排、依赖图、共享基建与统一维护纪律
- `27_操作手册-桌面端打包与冒烟.md`——**给自己看的速查手册**（照抄命令即可，原理看 25/26）：dist/ 里每个产物是什么/怎么用（Setup/portable/win-unpacked/blockmap）、重建安装包完整命令（PS 与 Git Bash 双写法+双镜像原因）、三层冒烟法（自动测试→开发模式人工看→打包版实测清单）、静默装/卸、常见坑速查表（exit 3/卡下载/哨兵红/新模块 404）
- `28_开发文档-会话切换性能与子代理过程流实时化.md`——切换/新建对话性能（会话元数据内存缓存、MCP 连接后台装配、空占位就地换绑）+ 子代理过程流实时化（worker 思考/文字增量 ~120ms 合并流、工具块折叠行摘要与展开体分流〔write 只显内容 / edit 红绿 diff〕，主对话与抽屉同款）+ v0.2.0 真机回归修复记录
- `29_交接文档-真机待办六项修复.md`——真机待办六项处置记录（2026-11-16 已实施）：文件工具优先提示词 / TASKS.md 退役 / 截断阈值上调（含受影响测试校准记录）/ write_file 缺参指引 / 送达气泡即时渲染（turn 锚点复用，服务端零改动）/ token 分类复查结论
- `30_开发文档-权限热切换与审批卡权限更改.md`——运行中改权限即时生效（权限三键 busy 放行、工具 deps live 读、busy 不落盘轮末存档兜底）+ 审批卡「解除沙箱并放行 / 允许并不再询问」（auto 自动放行档：普通卡自动批、提权卡保留人工；apply 补丁先应用后 settle）；含 auto vs 全开放语义速查表
- `31_操作手册-版本更替与发版清单.md`——**给自己看的发版速查**（与 docs/27 配套：27 讲打包与冒烟，31 讲发版前后动哪些文件）：版本号只改 package.json 一处（lockfile/UI/源码均无版本号的实证）、发版前提四条（文档/README 三处/活数字/预检）、两提交惯例、双产物+latest.yml+koffi DLL（@koromix 分包查法）验收清单、推送命令与七条版本更替专属坑
- `39_交接文档-Anthropic路线缓存断点默认注入.md`——cache_control 三端实验（MiMo 挂 user 末块激活缓存+报告/GLM 真不支持/DeepSeek 无副作用）→ 默认注入末消息末块 + 400 去标重试兜底；smoke:anthropic 需传本机提供方 id 的附注
- `38_交接文档-Anthropic格式缓存命中的输入口径修正.md`——命中率 100% 之谜：DeepSeek-anthropic 的 input_tokens 只算未命中（官方语义，实测 R2=178+1024）——按官方公式总输入=input+cache_read+cache_creation 统一修复（GLM/MiMo no-op），附各家缓存命中率计算链路全景表（勘误：MiMo openai 长上下文实测有缓存有报告；GLM 两路线均不缓存；跨格式共享缓存后端）
- `37_交接文档-DeepSeek与MiMo的Anthropic格式接入核查.md`——两家新 anthropic 端点真机实测（三端 usage/签名/disabled 全景表）+ 两处补齐：`output_tokens_details.thinking_tokens` 读入 reasoningTokens（跨格式「其中思考」对齐）、off 档显式 disabled + 官方 400 去参重试兜底
- `36_交接文档-首轮装配进度可视化.md`——首条消息的装配阶段可视化：startTurn 按**真实装配时序**广播三段 info（🧩 系统提示装配〔breakdown 同源数字〕→ 🔌 MCP 注入〔协调者走子代理口径、无配置省略〕→ ✅ 请求已发出，紧贴 agent.run）；rt.assemblyShown 瞬态标志每运行实例只展示一次（重启/恢复档首条消息同样展示）；复用 info 事件零前端改动
- `35_交接文档-真机待办四项修复.md`——真机待办四项处置记录：①协调者编排计时（子代理运行期间 turnStartedAt 保持、settleCoordinatorClock 收口——等待空窗计入「本次/累计」）②抽屉列表行两行结构（⏱/上下文徽标上第一行与名称并排）③提供方用量兼容（四家端点实测形状表：anthropic 格式 GLM 输入实值在 message_delta / openai 格式 cached_tokens 双字段）④休眠待命归档（syncDrawer idle 状态修正 + archiveDormantRecord 记录级归档，SubagentControlIo 接缝）
- `34_开发文档-read_image直读图片工具.md`——视觉会话直读工作区图片（图像块挂 tool 消息进入对话，下一轮原生看到）：registry `executeImage` 可选带图返回 + agent 回填挂 tool 消息 + 提供方投影（anthropic=tool_result 内图像块；openai 兼容=紧随合成 user 多模态消息）+ selfVision 闸门（纯文本模型拒绝）+ 魔数识别 + docs/33 附件引用持久化；与 view_image 的互补关系和 DSH 对齐/偏差
- `33_开发文档-图片附件内容寻址存储.md`——图片字节按 sha256 落 `attachments/v1/objects/` 一份（去重/不可变/永不自动清理），会话档只存 `{mime, ref}` 引用不再嵌 base64；恢复时 sha256 校验 + 丢失降级标注；与 DSH 的偏差（不做 EXIF 重编码/Files API 复用/append-only 日志，零原生依赖边界）
- `32_交接文档-协调者状态表目录清单与询问工具及子代理MCP注入修复.md`——协调者三件直用工具（subagent_status 状态表 / list_files 只读目录清单 / ask_user 向用户提问选择题，受众模型三值 `worker/coordinator/front`——子代理不注册 ask_user）+ 子代理 MCP 注入修复三件套（协调者 mcpReady 首轮闸门 / 失败宽限重试 / 说明段附 MCP 工具清单与未连接警示——根因：首轮无闸门 + godot 冷启动超握手超时永不重试 + 说明段只收有 instructions 的服务器）+ 协调者提示词同步完善与两条新纪律（追问进度查询 / 交付前抽查产出物）；含哨兵调整记录（D1 六件套、index.html 500→520、sa4 P2 红线口径）与真机验收指引

## 已知限制

- 会话压缩是物理替换、不可逆（自动留 precompact 备份兜底）；压缩摘要质量依赖模型
- 沙箱边界见[安全模型](#沙箱安全模型)：只约束写/删，不约束读与网络；硬链接/NUL 例外；授权需要目录 DACL 写权限
- MCP 工具不走守卫与沙箱（配置即信任）；当前仅 stdio 传输
- read-only 沙箱模式下文件三工具的写入是**审批放行**（批准后全权限写入），不是 OS 级拦截——OS 沙箱裁决只作用于 run_pwsh
- 文件三工具不支持目录、二进制与超过 5MB 的文件（明确报错并指向 run_pwsh）
- 输出超采集上限（默认 1MB，`pwshCaptureMaxBytes` 可调）时超出部分丢弃（头部已注明）
- 会话运行态常驻内存，不随切换淘汰；同一工作区多会话会各自启动一份 MCP 服务器进程
- manage_mcp 的重连只作用于当前会话；其他已开会话需新建对话或切换工作区才加载新配置
- 协调者会话（🎯）实质工作没有直接工具：不能直用 MCP/技能/写文件/跑命令（docs/32 起有三件只读/交互直用件：`subagent_status` 状态表 / `list_files` 目录文件名清单 / `ask_user` 向用户提问），一切实际工作经 agent_task 子代理完成（docs/5 D1/D10；并行 = 同轮多个 agent_task 调用，docs/15；**派发非阻塞**——立即返回「已派发」回执，完成/失败/归档报告作为消息自动送达（打断结算不重复送达，docs/18），docs/16；需要读文件**内容**时派一个「读文件并汇报」的子代理；协调者系统提示带「子代理（worker）系统提示词说明」段——worker 的工具/技能/MCP/AGENTS.md 原文，段尾附 MCP 工具清单与未连接警示（docs/32），两级 AGENTS.md 不再单独注入协调者，docs/20）；运行中可打断子代理（stop_subagent + 界面 ⏹，docs/18 打断即终结——没有暂停/恢复，一次性随之归档、可复用转待命；**界面打断/归档会自动送达状态通知**，docs/11/16）；可复用子代理（docs/9）任务完成后保留上下文待命、可被 agent_followup 反复追加任务；服务重启后运行实例不在线，但 agent_followup 会**自动从过程存档唤醒**它（docs/17：同 subId 历史延续；存档缺失/损坏才降级为重派指引，新 worker 可用 read_archive 读存档接续上下文；**休眠待命记录也可直接归档**（工具/界面均可，docs/35）——不必先复活）；已归档的不可唤醒（接续 = 重派 + read_archive）；followup 仅接受空闲态（执行中的目标会收到明确指引文案；被打断的可复用子代理已转 idle、直接 followup 接续，docs/18）；运行中插话的即时回应在合并进历史前刷新/切走再切回会短暂消失（窗口≈一次文本回应时长），合并后随快照重现（docs/8）
- 子代理**带本会话配置的全部 MCP 工具**（docs/6 P2 修订 docs/5 D3：连接挂在协调者会话闲置的 rt.mcp 上全会话共享；协调者自己不装配 mcp__ 工具、说明段只有工具清单/未连接警示，docs/32）；配置在**会话创建或绑工作区时读一次**（docs/32 起创建即预热 + mcpReady 首轮闸门 + 失败宽限重试一次；此前是首个 worker 启动时才读），会话中途改 mcp.json 不影响已初始化的连接
- 子代理中间过程不进前台历史：前台只保留任务书与最终报告摘要（用量计入会话合计，超长报告落 spill）；运行中在侧栏抽屉可见（列表行 + 详情页轮询服务端实时历史，跨刷新不丢；轮询粒度 1.5s，进行中的单条消息完成前不入历史）与 /status 审计计数可见，刷新后审计记录恢复
- read_image 读入的图片随历史**每轮重放**（持续占视觉 token，与贴图一体适用；压缩遮蔽后不再进请求）；UI 的工具块不渲染工具结果图片（模型侧可见，用户看到的是信封文字——docs/34 已知边界）
- 图片附件库无 GC（docs/33：永不自动删除是设计——字节只存一份磁盘占用可控，但删除会话不回收附件空间；手动清理 `~/.ZQQ-harness/attachments/` 后，历史消息里的图恢复时降级为「附件丢失」标注，会话可用）
- 普通会话内工具调用顺序执行（文件工具有先后语义）；**协调者同轮的多个工具调用并行执行**（docs/15——`agent_tasks` 批量工具退役，并行派发 = 同轮多个 `agent_task`；docs/16——派发非阻塞、结算报告自动送达），受并发上限（subagentMaxConcurrent，默认 3）约束，超出的派发在同步段**立即拒绝不排队**；空闲协调者每份送达报告各开一轮处理（忙碌积压的报告在轮末合并，docs/16）；文件写入有 hash 乐观锁（读取后被并行子代理/外部进程改过即拒，重读后可自愈）与 scope 写入分区（文件工具硬拒、pwsh 守卫强制弹卡——只读命令豁免：白名单 cmdlet 且无写形态不弹；守卫是启发式（正则/源码文本已免疫误报），与沙箱同为诚实边界，docs/5 §5 + docs/7 W1）；pwsh 侧写入不受台账约束（OS 沙箱裁决），这是乐观锁的诚实边界
- 并行子代理的审批卡按会话串行（一次一卡），带「🤖 来自子代理」来源标注
- 图片 token 是**固定估算**（每张 800，docs/10）：各 vision API 实际计量规则不同，差值进"其他"类——上下文占比是估算口径（与主对话面板同一估算器）；图片随会话档永久落盘（base64 膨胀 ~37%），无清理机制，大图请节制
- view_image 每次调用是独立 LLM 请求（计入会话合计；有自身视觉的会话用它读盘上图片时用的也是本会话模型），连续多问同一张图不共享上下文；视觉提供方故障按错误文本回传，不静默降级；任务运行中不能发图（前端隐藏 📎 + 服务端 409 双拦）
- `harness.json` 与外部模块目录都是**启动期读取**，改后需重启；禁用 UI 类模块后前端对应操作会得到 404（属预期行为）；外部模块无沙箱隔离，等同内置代码的信任级别
