# 交接文档：前端设置入口与 harness.json 热应用（2026-11-14）

> **给下一个对话**：用户要在 Web UI 加「设置」入口，可视化编辑 `~/.ZQQ-harness/harness.json` 的运行阈值。**后端读写面与热应用前提已全部就位**（上一对话完成：JSONC 注释支持 + 用户目录全键注释模板 + D2 的 `initConfig()` 可重复调用重绑）。你从这里实施前端入口与配套路由。**先读 README「维护导航」，再读本文档；动架构前按需读 docs/21 §5（不变量）。**

---

## ⭐ 实施记录（2026-11-15，§2-§4 全部落地——前端入口 + 读写路由 + 热应用）

`npm run typecheck` 通过；`npm test` **395 项全绿 0 skip**（388 基线 + 3 config + 3 web-settings + 1 哨兵）；smoke:sa2 全过、sa4 10/10；活服验证（隔离 USERPROFILE + 独立端口）与浏览器 GUI 冒烟全过（见下）。以下为与 §3 方案骨架的差异与落地细节（**以代码为准**）：

- **读路径单一出处（§3.1）**：`parseHarnessConfig` 内部局部 rules 表上提为模块级导出 **`THRESHOLD_RULES`**——每键 `{ hint, desc?, group?, range, restart?, deprecated? }`；**range 是声明式数值范围**（`{integer?, min?, max?, exclusiveMin?, exclusiveMax?}`），lenient 读校验谓词由 `rangePass()` 从它派生（不再手写 `test` 函数——校验语义与 UI 约束零漂移可能）。新增导出 `THRESHOLD_GROUPS`（六组展示序 + 中文标题）与 **`thresholdSchema()`**（返回 `{ groups, entries }`，25 活跃键；`def` 从 `resolveThresholds({})` 取，废弃键 spillThreshold 标 `deprecated` 不入表）。GET 响应在方案骨架上多带 `effective`（= `resolveThresholds(HARNESS_CONFIG.thresholds)`，表单初值）与 `desc`/`exclusiveMin` 等字段（UI 直渲需要）。
- **写路径 fail-closed（§3.2）**：严格校验落在 config.ts 的 **`validateThresholdsStrict()`**（与 rules 表同文件同出处；web-settings 只是薄包装）：非对象整体拒绝、未知键/废弃键/类型错/范围错**逐键指名 + 整体拒绝不落盘**。**pwsh 交叉校验取严格口径**：对「提交项 + 缺省回填」的组合判定 `max < timeout` 直接 400（lenient 读侧的静默抬升保留给手写文件——同一规则两种包装，读宽容写严格）。POST 路径因路由注册表按 path 唯一键而定为 **`POST /api/settings/harness/save`**（沿 `/api/providers` GET + `/save` POST 先例）；`disabledModules` 原样透传（只读展示）。落盘 `writeTextAtomic`（core/file-tools 既有原子写）+ 纯 JSON + 尾换行；成功后 `initConfig(cfg)` 热应用。
- **新模块 `modules/web-settings/`**（`web.settings`，modules.ts +1 行；server.ts 零改动仍 249 行）：路径取 **`ctx.paths.userDir` + `USER_DIR_LAYOUT.harnessFile`**（与 `config.harnessFilePath()` 同一文件——bootstrap 传真实用户目录；**测试传临时目录，不触真机文件**，这是比 inject/homedir-override 干净的隔离缝）。无需 sessionHost（全局文件不经会话）。
- **前端（§3.4）**：顶栏 ⚙ 徽标按钮 → `#setModal` 模态（provider 面板同款骨架）；表单**完全 schema 驱动**（六组吸顶分节、每键 desc/key/默认值/hint/数值输入/单键 ↺、组级「组内恢复默认」、全局「恢复默认值」）；restart 键黄色「重启后生效」徽标；头部说明带「写回纯 JSON 注释会丢」「构造期参数新会话生效」两条诚实声明。新代码沿 D3 纪律：el 不带第三参、动态内容全 textContent、id 运行时拼 `set-` + key。提交先过客户端轻校验（整数/含边界 min/max，含边界映射到 input 属性；**开边界交给服务端**）→ 400 返回 `errors[]` 逐键标红。
- **GUI 冒烟发现并修复两处**：①保存确认行被 `refreshSnapshot()` 的整列重渲染抹掉（renderHistory 先 `chat.innerHTML=""`）——改为**先刷新后确认**（`.then(sysLine)`）；②「有未保存修改关闭」最初用 native `confirm()`——会阻塞嵌入式 webview 渲染进程（自动化直接卡死实测复现），且全库无此先例——改为**两步按钮**（「关闭」→「确认关闭」，CFG.CONFIRM_SET_MS 3s 自动复位，沿「删除→确认删除」惯例）。
- **哨兵（§5）**：contract.test.ts 新增 docs/24 哨兵——①设置模态区域（HTML 块 + JS 段切片）不得出现任何阈值键名 + 必须经 `setSchema.entries` 渲染 + 经 `/api/settings/harness` 通信（**全文件键名检查不可行**：`defaultContextLength` 等是 meta 契约的合法消费，与表单硬编码无关；默认值数字字面量同理不做断言——0/3/8 等小数字无法与 CSS 区分，键名已锁住硬编码路径）；②web-settings 源码必须含 `validateThresholdsStrict(` / `writeTextAtomic(` / `initConfig(`（fail-closed + 原子写 + 热应用唯一出口，沿 P8 锁法）。
- **活服验证（隔离 USERPROFILE，全程零真机数据触碰）**：GET 25 键/六组 schema → POST `compactionPressure=0.5` → **`/api/meta` 立即 0.5**（热生效证据）→ 落盘纯 JSON（`JSON.parse` 直读通过、无 `.tmp` 残留）→ **杀进程重启后 meta 仍 0.5**（持久性）→ 越界 POST（`subagentMaxConcurrent:0`）→ 400 指名该键、**文件逐字节未动、meta 未变** → pwsh 交叉（只提交 timeout=400000）→ 400 提示同步调大 max。**GUI 冒烟（浏览器自动化，7 项全过）**：模态打开六组渲染/初值=持久化值（截图取证）、单键 ↺ 恢复、客户端越界标红+错误文案（截图取证）、服务端开边界 400 标红且模态不关、合法保存后模态关+确认行+meta 热更新、两步关闭确认（拒绝保持/确认关闭）、组内恢复默认；关闭未保存的脏值（maxToolRounds=22）**未泄漏进文件**。

---

## 1. 当前状态（接手前确认）

```bash
cd F:/MyClaw/ZQQ-harness
git log --oneline -3      # 44f67f5 feat(config) JSONC+模板 → 4855a40 D3 首块 → 25cadaf D2 initConfig
npm run typecheck         # 通过
npm test                  # 388 项全绿 0 skip
```

**已就位的地基**（全部有测试与活服验证，直接复用、不要重建）：

- `~/.ZQQ-harness/harness.json` 已存在：25 个活跃阈值键写入默认值 + 逐键中文注释（六组分区）+ `disabledModules` 模块名清单注释；行为与无文件时逐字节一致。
- `src/config.ts`：`loadHarnessConfig(path?)`（lenient 读，**支持 JSONC 注释**）、`parseHarnessConfig(raw)`（纯函数校验/归一，逐项忽略+告警）、`stripJsonComments(text)`（字符串安全注释剥离）、`initConfig(cfg?)`（**可重复调用**：重绑全部 `export let` 生效常量，live binding——全部消费点下一次读取即见新值；缺省参读真实文件）。
- 范围校验规则表在 `parseHarnessConfig` 内部（局部 `rules` 对象：每键 `{ hint, test }`）——**这是每键合法范围的唯一出处**。

## 2. 任务目标

用户原话需求：「前端添加一个设置入口，可改这些数值（harness.json 的阈值）」。即：Web UI 模态里分组展示全部阈值（说明/当前值/默认值/范围），编辑后保存 → 校验 → 原子写 `harness.json` → **热生效**（理想免重启；做不到的键明确标「重启生效」）。

## 3. 方案骨架（建议；可按实现判断调整，重大偏离在 docs 记录里写明理由）

### 3.1 读路径：阈值元数据单一出处（新）

- `config.ts` 把 `parseHarnessConfig` 内部的 `rules` 局部表**上提为模块级导出**，并新增导出 `thresholdSchema()`：返回 `[{ key, group, hint, def, min?, max?, integer?, restart? }]`（`def` 从 `resolveThresholds({})` 取、`restart` 标注启动类键——spill/sandbox 清扫与 disabledModules 装配）。**不许出现第二份键清单**（单一出处不变量；哨兵建议见 §5）。
- 新模块 `src/modules/web-settings/`（沿 web-* 路由模块模式，`modules.ts` 组合清单 +1 行）：
  - `GET /api/settings/harness` → `{ config: HARNESS_CONFIG, schema, fileExists }`；
  - `POST /api/settings/harness` → body `{ thresholds }`，见 3.2。
- `/api/meta` **不动**（meta 是前端常驻契约面，设置页是专用按需路由，别把 25 键塞进每次快照）。

### 3.2 写路径：严格校验 + 原子写 + 热生效

- **写入口 fail-closed**（与读的 lenient 语义相反、别混用）：任一键类型/范围非法 → 400 指名该键与合法范围，**整体拒绝**、不落盘。范围判定复用上提后的 rules 表（同一份定义、两种包装语义）。
- 合并语义建议**整体替换 thresholds**（表单加载全量、提交全量，最简）；disabledModules 原样透传保留。
- 落盘：`harnessFilePath()` 写临时文件 + `rename` 原子替换（先例：mcp-manage 的「校验-原子替换」）。写回用 `JSON.stringify(cfg, null, 2)` 纯 JSON——**注释会丢**（模板顶部已声明此点，非 bug；进阶的「按行替换值保注释」首版不做）。
- 写成功后调用 `initConfig(newCfg)` → 全部消费点 live binding 热生效（`/api/meta` 下一次请求立即反映，这是热生效的活体验证锚点）。

### 3.3 热生效边界（UI 标注 + 验收口径都要写对）

- **立即跟随**（下一次读取即新值）：meta 下发、新会话装配、子代理派发配额、pwsh 超时、修剪预算、MCP 超时等运行时读取点。
- **不跟随**：已装配 Agent 实例的构造期参数（如主会话 `maxToolRounds` 在 createRuntime 时捕获）——运行中会话沿用旧值，**新会话生效**（可接受，UI 注明）。
- **必须重启**：`spillMaxAgeHours`/`sandboxTmpMaxAgeHours`（清扫只在 bootstrap 跑一次）、`disabledModules`（模块装配一次性）。schema 的 `restart` 标记即为此。
- **disabledModules 首版只读展示**（高危：禁 `web.*` 或被依赖模块 → 功能消失/启动失败；将来开放也要强警告+重启标注）。

### 3.4 前端 UI（无构建单文件红线）

- 入口：顶栏「…」菜单加「⚙ 运行阈值」项，或与提供方管理同款的模态面板（先例：provider 面板 / wsBrowse 模态）。
- 表单按 `schema.group` 六组分区；每键 = label + hint 说明 + 数值输入（min/max/integer 约束）+ 默认值展示 + 单键「恢复默认」；组级/全局「恢复默认」。
- 新代码纪律（D3 起）：`el()` 不带第三参 / `textContent` 填动态内容 / `esc()` 兜底；提交后错误逐键标红；有未保存更改时关闭模态要确认。
- 前端**零硬编码**阈值范围/说明文案/默认值——全部来自 GET 的 schema（契约面 = 专用路由响应，同 meta 精神）。

## 4. 实施入口（文件级）

| 文件 | 改动 |
|---|---|
| `src/config.ts` | rules 表上提导出 + `thresholdSchema()`（+测试） |
| `src/modules/web-settings/index.ts` | 新模块：GET/POST 路由（经 ctx.routes 注册；全局文件不经会话——参考 web-providers 拿单例的接缝方式） |
| `src/modules.ts` | 组合清单 +1 行 |
| `src/web/public/index.html` | 顶栏入口 + 设置模态 + 提交逻辑 |
| `src/modules/web-settings/web-settings.test.ts` | 新测试文件——**必须登记 package.json test script（显式清单）** |
| `src/core/contract.test.ts` | 建议加哨兵（见 §5） |

## 5. 哨兵与验收

- 哨兵建议（contract.test.ts）：① index.html 不得出现阈值键名/min-max 数字字面量的硬编码（schema 单一出处）；② 写路由必须调 `initConfig`（热应用唯一出口，沿 P8 锁法）。
- 验收：typecheck + 测试全绿（新增文件已登记）；smoke:sa2/sa4 不回归；**活服验证**（`USERPROFILE=$(mktemp -d)` 隔离）：GET 返回 25 键 schema → POST 改 `compactionPressure=0.5` → `/api/meta` **立即**变 0.5（热生效证据）→ 文件落盘为纯 JSON 且重启后仍是 0.5 → POST 越界值（如 `subagentMaxConcurrent: 0`）→ 400 指名该键、文件未被破坏 → 手工 GUI 冒烟（模态分组/恢复默认/错误标红）。
- 完成后：docs/24 头部补实施记录（沿 21-23 惯例）+ README 导航更新 + 独立 commit。

## 6. 踩坑（本任务相关，必读）

1. **server.ts ≤250 行双哨兵**——路由全部进 web-settings 模块，server.ts 零改动。
2. **npm test 是显式文件清单**——新 .test.ts 不同步登记 package.json 就静默不跑（历史踩过）。
3. **modules/** 内禁止跨模块目录 import**——web-settings 只经 `ctx` 接缝与 config.ts（config 非模块、不受限）。
4. 前端字符串形态：双引号串用 `"…" + x + "…"` 拼接；**模板字面量（反引号）内必须 `${x}`**——批量替换先看目标行是哪种。
5. 活服验证一律临时 `USERPROFILE` 隔离（防动真实用户数据；清扫 bootstrap 会真的删超龄目录）；杀服务用精确 PID + `cmd //c "taskkill /F /PID <pid>"`（Git Bash 直接 taskkill 会被路径改写）。
6. 读/写校验语义两套：**读 lenient**（`parseHarnessConfig` 逐项忽略+告警——文件是用户手写的，要宽容启动）；**写严格**（UI 提交→400 拒绝——用户在界面上改，要即时反馈）。共用同一份 rules，仅包装不同。
7. JSONC：读取接受注释（`stripJsonComments`）；写回纯 JSON 丢注释是**预期行为**（模板顶部已声明）。
8. 热生效验收别写错口径：运行中会话的 Agent 构造参数不跟随（新会话才生效）；启动类键标「重启生效」。

## 7. 不变量（改动前重读 docs/21 §5）

重点：阈值范围/说明/默认值**单一出处 = config.ts**（前端与路由零硬编码，schema 下发）；fail-closed 写入口；无构建单文件前端；server.ts ≤250 行；模块禁互 import；热应用只经 `initConfig()`（唯一重绑出口）；前端契约面 = meta + 专用路由响应（不硬编码数字/文案）。

## 8. 快速上下文（不重读全部文档的最低限度）

- 前置 commit：`44f67f5`（JSONC + 全键注释模板）、`25cadaf`（D2 initConfig 热应用前提）、`4855a40`（D3 前端 keyed 样板——新前端代码照 reconcileKeyed/make-update 纪律写）。
- 模板文件：`~/.ZQQ-harness/harness.json`（25 键 + 注释；六组：通用/压缩/pwsh/子代理/MCP/清扫）。
- 五分钟全局感：README「维护导航」→ `src/config.ts`（全部运行参数唯一出处）→ `modules/web-providers/`（web-* 路由模块样板）→ `web/public/index.html`（模态先例）。

—— 完 ——
