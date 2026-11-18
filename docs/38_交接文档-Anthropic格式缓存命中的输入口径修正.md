# 38 · 交接文档——Anthropic 格式缓存命中的输入口径修正（命中率 100% 之谜）

> 状态：**已实施**（2026-11-18，随本轮收尾；typecheck 三段过 + npm test 518/518 全绿 + smoke:sa4 11/11）。
> 来源：用户追问「各家缓存命中的计算是什么情况，DeepSeek 的 Anthropic 格式缓存命中为什么是 100」。

## 各家缓存命中率的计算链路（现状全景）

显示口径（前端 `cacheRatePct`）：**命中率 = 累计命中 token ÷ 累计输入 token**（`totals.cacheHit / totals.prompt`，
均为 API 实测累加）。分母「输入」必须是**总输入**（含命中部分）——openai 格式各家 `prompt_tokens` 本来就是
全量，没问题；anthropic 格式掉了坑（见下）。

| 提供方 | 格式 | 命中字段 | 输入字段语义 | 修复前命中率 |
|---|---|---|---|---|
| DeepSeek | openai | `prompt_cache_hit_tokens` | `prompt_tokens` = 全量（hit+miss） | ✅ 正确 |
| GLM | openai | `prompt_tokens_details.cached_tokens`（docs/35 起读） | 全量 | ✅ 正确（**但实测该端点不缓存**：重复前缀 cached 恒 0） |
| MiMo | openai | `prompt_tokens_details.cached_tokens`（**长上下文才给**：短消息时字段为 null——实测 1337 token 前缀命中 1280） | 全量 | ✅ 正确（docs/35 补读正好接住） |
| GLM | anthropic | `cache_read_input_tokens`（实测恒 0——该端点未开缓存计费） | `input_tokens` = 全量 | 0%（真没命中） |
| MiMo | anthropic | 无字段（后端大概率在缓存——与 openai 格式共享缓存后端，见下） | 全量 | 不可见 |
| **DeepSeek** | **anthropic** | `cache_read_input_tokens` | **官方语义：`input_tokens` 只算未命中部分！**（命中在 cache_read/cache_creation） | ❌ **被钳 100% + 输入累计漏算** |

**勘误（追记实测，2026-11-18）**：本文初版把 MiMo openai 记为"端点不给字段"——那是**短消息**（12 token，
不触发缓存）探测的误导；长前缀（~1300 token）实测 MiMo openai 缓存且报告（cached 1280/1337）。同轮
另证：DeepSeek 与 MiMo 的**两种格式共享缓存后端**（跨格式的同前缀"第一次请求"即命中早前另一格式留下的
缓存）；GLM **两条路线均不缓存**（openai 重复前缀 cached 恒 0）。GLM-anthropic 未启用缓存是否因未发
官方协议要求的 `cache_control` 断点标记，待后续实验（候选功能：提供方可选注入 cache_control）。

## 实证（同前缀连发两回，2026-11-18）

DeepSeek-anthropic：R1 `input=1199, read=0`；R2 **`input=178（只剩未命中）, cache_read=1024（命中前缀）`**
——真实总输入 178+1024=1202（与 R1 的 1199+新增尾部吻合）。这是官方 Anthropic 的 usage 语义
（总输入 = input + cache_read + cache_creation），此前代码裸取 `input_tokens` 当总输入：
- 命中率 = 1024/178 → `Math.min(100, …)` 钳到 **100%**（用户所见）；
- 输入累计也**漏掉命中部分**（顶栏输入偏小，上下文锚定 `usageAnchor` 同样锚在偏小值上）。

GLM-anthropic（input 全量、read 恒 0）与 MiMo（无字段）不受影响——加和公式对它们是 no-op。

## 修复（anthropic/provider.ts 两处）

- `message_start` 与 `message_delta` 的用量合并统一按官方公式：
  **`promptTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`**，
  `cacheHitTokens = cache_read_input_tokens`（命中读；写入计不进命中率——它是花钱写缓存，不是省钱）。
- 逐字段择新覆盖的既有合并语义不变（GLM 的 0 占位→delta 实值路径、畸形流补建路径照旧）。

修复后 DeepSeek-anthropic：总输入回到真实值（1202 量级），命中率显示真实百分比（上例 85%）；
顺带 usageAnchor 锚到全量，上下文估算更准。**历史会话档里已累计的偏小输入/虚高命中无法回填**
（同 docs/35 口径：那是当时端点形状下的实况）。

## 验证

- 单测 3 处（19/19 全过）：docs/35 混合形状用例断言 13→17（总输入含命中）；docs/37 DeepSeek 用例
  34→39；新增实测样本专项（178+1024=1202、命中率 85% 且 <100%，不再钳 100）。
- `npm test` 518/518；typecheck 三段过；smoke:sa4 11/11。

—— 完 ——
