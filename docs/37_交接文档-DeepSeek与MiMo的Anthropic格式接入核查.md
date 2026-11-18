# 37 · 交接文档——DeepSeek 与 MiMo 的 Anthropic 格式接入核查（端点实测 + 两处补齐）

> 状态：**已实施**（2026-11-18，随本轮收尾；typecheck 三段过 + npm test 517/517 全绿 + smoke:sa4 11/11）。
> 来源：用户新增两个提供方配置（`DeepSeek-anthropic` @ api.deepseek.com/anthropic、`MiMo-v2.6-flash-anthropic` @ api.xiaomimimo.com/anthropic），要求核查接入情况。

## 端点实测（真流式探测，2026-11-18）

| 端点（anthropic 格式） | input 实值 | 缓存命中 | 思考 token | thinking 签名 | 显式 disabled |
|---|---|---|---|---|---|
| GLM（open.bigmodel.cn/api/anthropic） | message_start 恒 0，实值在 message_delta（docs/35 已修） | `cache_read_input_tokens` | 无独立字段 | **非空签名**（回放合规） | ✅ 接受且生效 |
| **DeepSeek（api.deepseek.com/anthropic）** | **message_start 即实值**，delta 也有 | `cache_read_input_tokens`（另有 cache_creation 写入计，不消费——与 openai 路线只读命中口径一致） | **`output_tokens_details.thinking_tokens`**（官方协议无此字段） | **非空签名**（回放合规） | ✅ 接受且生效 |
| **MiMo（api.xiaomimimo.com/anthropic）** | **message_start 即实值**，delta 也有 | 无 | 无独立字段 | **空签名**（signature_delta 事件在、值为空串——按「空签名合法、逐字回放」规则可用） | ✅ 接受且生效 |

关键发现：**三家兼容端的共同坑——不发 thinking 参数 ≠ 关思考**。官方 Anthropic 协议里缺省即关；三家兼容端缺省=模型默认行为=思考照跑（实测不带参数全部产出 thinking 块）。当前 provider 的 off 档不发参数 → 在这三家关不掉思考（静默烧 token）。三家均接受显式 `thinking:{type:"disabled"}` 且生效；官方 Anthropic 对 disabled 报 400（协议只认 enabled）。

## 核查结论 + 两处补齐（anthropic/provider.ts）

1. **usage 读取：现状已兼容**（docs/35 的 message_delta 兜底合并覆盖了三种形状——实值在 start / 在 delta / cache 与思考附加字段）。**补一处**：DeepSeek 的 `output_tokens_details.thinking_tokens` 读入 `reasoningTokens`——同账号 openai 路线「其中思考」有数、anthropic 路线此前没有，现在对齐。
2. **off 档真关思考**：effort=off 显式发 `thinking:{type:"disabled"}`；若端点 400（官方 Anthropic 只认 enabled）→ **去掉思考参数重试一次**——官方缺省本就是关，语义不变；兼容端首试即中，无额外开销。default 档照旧不发参数（API 自己决定），low/high/max 照旧 enabled+budget。

既有不变量复核：思考回放门（budget 才回放）不受影响——off/default 不回放、thinking 块照常存档；`max_tokens` 推导（无 budget 缺省 8192）不变；空签名（MiMo）走 replayableThinking 的「逐字回放」分支，不触降级告警。

## 验证

- 单测 `anthropic/provider.test.ts` 新增 3 项（18/18 全过）：off 显式 disabled + default/high 对照；官方 400 → 去参重试恰好一次且重试体无 thinking；DeepSeek 形状 usage 四字段（input 实值在 start / cache / thinking_tokens 单列）。
- 旧测试一处断言更新：「off 不发思考参数」→「off 显式 disabled」（行为修订的契约化）。
- `npm test` 517/517；typecheck 三段过；smoke:sa4 11/11。

—— 完 ——
