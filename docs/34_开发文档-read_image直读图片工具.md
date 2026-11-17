# 34 · 开发文档——read_image 直读图片工具（视觉会话图像块进对话）

> 状态：**已实施**（2026-11-17，随 v0.3.8 发布；预检三件套全绿——typecheck 三段过 + npm test **502/502** + smoke:sa4 **11/11**）。
> 来源：用户提出「给视觉模型添加一个直接读取图片的工具，而不是使用视觉工具来返回消息」，并附 DSH（DeepSeek harness）`read_image` 机制调研作参考。

## §0 设计

**问题**：此前视觉会话的模型要看盘上图片只有 `view_image`——它把字节发给视觉模型解析后返回**文字描述**（有自身视觉的会话也是绕一道），模型从不直接看到图。本轮新增 **`read_image`**：读取工作区图片文件，把图片作为**图像块挂到本工具的 tool 消息**进入对话——下一轮请求模型原生看到（与贴图同一条 docs/33 附件/回放管线）。

| 环节 | 做法 |
|---|---|
| 工具接口 | `Tool` 新增**可选** `executeImage(args, ctx): Promise<{text, images}>`——`executeWithMeta` 优先走它、二者只执行其一；`execute`（string）保持全体 20+ 工具契约不变（read_image 的 execute 只是回退兜底，返回无图说明文本）。`ToolExecResult` 增 `images?`，文本修剪不丢图像（图像是内容本体） |
| 回填 | `agent.ts` 工具循环两处 backfill（并行/顺序）把 `r.images` 挂到 tool 消息（`ChatMessage` tool 变体增 `images?`） |
| 提供方投影 | **anthropic**：tool_result 官方支持 content 数组 → `[text, image base64 块…]`；**openai 兼容**：tool role 在该面只收文本 → 投影为「tool 文本消息 + 紧随合成 user 多模态消息」（历史形状不变、路由兼容面最宽）。toSdkMessages 改 flatMap（各分支统一返回数组） |
| 视觉闸门 | `selfVision()=null`（会话模型无视觉）→ 工具层直接拒绝并指引 view_image——**纯文本模型不会先存再变占位**（DSH 同款门禁思路；有自身视觉免配视觉模型，docs/12 R2 同源） |
| 格式识别 | 文件魔数嗅探（PNG/JPEG/GIF87a+89a/WebP/RIFF），无扩展名也能识别；不认识 → 拒绝并指引转格式 |
| 大小/路径 | 单张 ≤ `IMAGE_RULES.maxBytes`（5MB，超限指引压缩）；路径守卫与 read_file 同口径（isInsideWorkspace，相对路径） |
| 持久化 | 工具只返回字节；落盘走 docs/33 内容寻址（`toStoredMessages` 扩到 tool 消息——引用形态、去重；恢复同口径校验）。**不做 EXIF 重编码**（零原生依赖边界，同 docs/33 偏差） |
| 用量估算 | tokens.ts：tool 消息图像与 user 图像同款 `IMAGE_TOKEN_EST` 固定估算 |
| 提示词 | `VISION_LINE_WORKER` 改口（有视觉读盘图用 read_image 直看；view_image 降位为无视觉模型的借视觉通道）；`VISION_LINE_COORDINATOR` 同步（子代理读图工具两态）；golden 快照同步更新 |

**与 view_image 的互补**：read_image=模型有视觉、原生看图（无中间 LLM 调用、零额外用量）；view_image=借视觉模型出文字描述（无视觉主模型的唯一出路，独立 LLM 请求计用量）。二者并存，工具描述与视觉指引行已划清边界。

## §1 与 DSH 的偏差

- **不做「存了再降级占位」**：DSH 纯文本路由会把已存的图投影成 `[image omitted…]` 占位——本仓库工具层就拒绝（闸门前置），历史里不存在「模型看不到的图像块」。
- **无 Files API 复用**：OpenAI 兼容路由每轮重放 base64 数据块（与贴图一致）；无 file-id 抽象。
- **UI 不渲染工具结果图片**（已知边界）：工具块只显示信封文字（`[已读取图片 pic.png] 格式 image/png · 12.3 KB…`），图像模型侧可见；历史重放/抽屉同理。
- **重复读同一张图** = 重复图像块重复付视觉 token（DSH 同款 occurrence 语义）——工具信封文字已自带提醒。

## §2 实施

`tools/registry.ts`（ToolOutput 联合方案被否——会波及数十处测试调用点，改可选 `executeImage` 零波及）→ `llm/provider.ts`（tool 变体 images）→ `agent.ts` 两处回填 → `tokens.ts` → openai/anthropic 两提供方投影 → `web/attachments.ts`（引用变换扩到 tool 消息）→ 新模块 `modules/tools/read-image/`（audience=worker：普通会话+子代理；协调者不注册，红线不变）→ `modules.ts` 登记 → toolinfo.js（折叠头 `读图 <path>`、展开体只留结果）。

## §3 测试与真机验收

新测试：read-image.test.ts 4 用例（闸门/成功/守卫与魔数/大小与各格式魔数/execute 回退）；openai.provider.test + anthropic.provider.test 各 1 投影用例；attachments.test 补 tool 消息引用往返；contract golden（两条视觉指引行）显式更新。

真机验收：视觉会话让模型「读 xxx.png 并描述」→ 应见 read_image 工具块，下一轮模型直接描述图片内容（不经转述）；无视觉会话调用 → 收到拒绝与 view_image 指引；重复读同一张 → 模型应自我克制（信封已提醒）。
