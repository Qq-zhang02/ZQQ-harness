# 39 · 交接文档——Anthropic 路线 cache_control 断点默认注入（MiMo 缓存激活）

> 状态：**已实施**（2026-11-18，随本轮收尾；typecheck 三段过 + npm test 520/520 全绿 + smoke:sa4 11/11 + smoke:anthropic 真机多轮工具冒烟通过）。
> 来源：docs/38 勘误留下的问题——「GLM-anthropic 未启用缓存是否因未发官方协议要求的 `cache_control` 断点标记」，用户要求实测。

## 实测结论（cache_control 三端实验，2026-11-18）

标记放法两试：A=挂 system（块数组带 cache_control）、B=挂 user 前缀块（长前缀 ~1300 token，同前缀两连发）：

| 端点 | A（system） | B（user 末块） | 结论 |
|---|---|---|---|
| **MiMo-anthropic** | 无效果（无缓存字段） | **R2 `input=62 + cache_read=1280`——命中可见！** | **B 挂法激活缓存且激活报告**；语义为官方口径（input 只算未命中，docs/38 公式正好接住） |
| GLM-anthropic | read 恒 0 | read 恒 0 | 真不支持（标记被忽略，不报错） |
| DeepSeek-anthropic | — | 两轮 read=1024 照旧、无副作用 | 自动缓存不受影响 |

## 实现（anthropic/provider.ts）

- **默认注入**（无配置开关）：`toAnthropicMessages` 之后，给**最后一条消息的末块**注入
  `cache_control: {type: "ephemeral"}`（官方推荐的会话式断点位——缓存覆盖其全部前缀
  〔system+工具 schema+历史〕，下一轮请求天然命中；纯文本 user 消息就地转块数组）。
  三端实测全安全：MiMo 激活、DeepSeek 无副作用、GLM 忽略；官方 Anthropic 本就是协议预期用法。
- **400 去标重试兜底**：未知兼容端若对标记报 400 → 剥离全部 cache_control 重试一次（与
  docs/37 的 disabled 去参重试同路——最坏多一次请求，退回该端原生缓存行为）。
- 与思考回放/图片块/工具结果合并路径正交：标记只加在既有映射产物的末块上，不改变块序。

## 效果

- **MiMo-anthropic**：长对话开始真实省钱（命中部分缓存价）且命中率可见（docs/35 起读
  `cache_read_input_tokens`，docs/38 起总输入口径正确——本注入正好把数据源点亮）。
- DeepSeek-anthropic：行为不变（本来就自动缓存）。
- GLM：无变化（端点不支持，标记被忽略）。
- 官方 Anthropic（未来若接）：即为其缓存机制的正确启用方式（注意官方写缓存 1.25 倍价、
  命中约 0.1 倍价——多轮会话净省，单轮一次性问答略有写溢价）。

## 验证

- 单测 2 项（21/21 全过）：默认注入（纯文本转块标记）+ 带图末块标记/400 去标重试恰好一次。
- `npm test` 520/520；typecheck 三段过；smoke:sa4 11/11；**smoke:anthropic 真机冒烟**
  （deepseek-97249102，多轮工具循环 + 思考存档回放全链路带标记实测通过）。
- 附注：smoke:anthropic 缺省找 `deepseek-anthropic` 这个 id，本机实际配置是
  `deepseek-97249102`——`npm run smoke:anthropic -- deepseek-97249102` 传参即可（脚本本就支持 argv[2]）。

—— 完 ——
