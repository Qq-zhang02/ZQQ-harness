import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USER_DIR_LAYOUT, USER_DIR_NAME } from "./userdir.ts";
import type { SandboxMode } from "./sandbox/types.ts";
import { SANDBOX_MODES } from "./sandbox/types.ts";
import type { EffortSetting } from "./llm/provider.ts";

export interface AppConfig {
  maxToolRounds: number;
  pwshTimeoutMs: number;
  pwshMaxTimeoutMs: number;
}

// ---- harness.json（P8）：~/.ZQQ-harness/harness.json 用户级覆盖（模块启停 + 运行阈值）----
// docs/21 §3.3 / docs/23 D2 起**导入期不读该文件**：下方全部生效常量以纯缺省初始化（export let），
// 由 initConfig() 显式装载并重绑——server.ts bootstrap 调用一次；测试与直调入口因此不受
// 真机 harness.json 感染（npm test 确定性；要测覆盖行为就显式 initConfig({...})）。
// 消费方仍按常量名直接引用（live binding，initConfig 后自动见到新值）；唯一纪律：
// **不得在模块顶层（导入期）消费这些常量**——那会在 initConfig 前冻结缺省值
// （mcp-manage 的排错清单是先例，已改惰性构造；contract.test.ts 哨兵锁定本机制）。
// 解析仍是 lenient：文件缺失/JSON 损坏 → 全缺省，字段非法 → 逐项忽略，均告警不阻止启动。
// 模块启停在 server.ts bootstrap 消费 HARNESS_CONFIG.disabledModules 过滤组合清单
// （依赖校验仍由 loadModules 承担：被保留模块依赖被禁模块 → 启动失败并指名）。

/** 阈值生效值：key 与本文件导出的常量一一对应（camelCase）。 */
export interface EffectiveThresholds {
  /** 上下文压缩触发阈值（(0,1]）。docs/21 §2.2-④：键名由 compectionPressure（拼写错误）
   *  更名为 compactionPressure，解析层双读兼容旧键（旧键告警更名提示）。 */
  compactionPressure: number;
  /** @deprecated 落盘（spill）阈值——docs/10 R2 起废弃：修剪改为「只保留头部 + 触发即全文
   *  落盘」，不再有门槛。键保留解析仅为兼容已写入 harness.json 的旧配置（不产生未知键
   *  告警），运行时无消费方。 */
  spillThreshold: number;
  /** 压缩保留预算比例（(0,1]）；原名 compectionKeepRatio（拼写更正） */
  compactionKeepRatio: number;
  /** 手动 /compact 保留预算（≥0 整数 token；0=全部进摘要）；原名 compectionManualKeepTokens */
  compactionManualKeepTokens: number;
  /** 上下文长度缺省值（>0，提供方表单缺省与前端占比兜底） */
  defaultContextLength: number;
  /** 工具调用轮次上限（≥1 整数） */
  maxToolRounds: number;
  /** run_pwsh 缺省超时（≥1000ms） */
  pwshTimeoutMs: number;
  /** run_pwsh 最大超时（≥1000ms，且 ≥ pwshTimeoutMs） */
  pwshMaxTimeoutMs: number;
  /** 注册表级工具结果修剪预算（>0 整数，字符） */
  toolResultMaxChars: number;
  /** 并行子代理（worker）并发上限（≥1 整数，超出立即报错回传不排队） */
  subagentMaxConcurrent: number;
  /** 每会话子代理累计上限（≥1 整数，超出立即报错回传） */
  subagentMaxTotal: number;
  /** 子代理（worker）工具调用轮次上限（≥1 整数，沿用"达上限收尾总结"机制） */
  subagentMaxToolRounds: number;
  /** 子代理最终报告字符预算（>0 整数，超出修剪并提示 spill 全文路径） */
  subagentResultMaxChars: number;
  /** 可复用子代理每实例任务数上限（≥1 整数，超出 followup 立即报错回传；docs/9） */
  subagentMaxTasks: number;
  /** 可复用子代理的 followup 上下文门槛（(0,100] 整数百分比；上次任务收尾时上下文占用
   *  ≥ 该值则拒绝追加任务——上下文过长易产生幻觉，docs/10 R1） */
  subagentFollowupContextPct: number;
  /** 子代理上下文过长预警线（(0,100] 整数百分比；任务收尾占用 > 该值时报告/待命提示附
   *  「上下文过长」预警——仍可追加（≥ subagentFollowupContextPct 才拒收），docs/10 R1 修订） */
  subagentWarnContextPct: number;
  /** 可复用子代理的强制归档线（(0,100] 整数百分比；任务完成时上下文占用 > 该值则不转
   *  待命直接归档，docs/10 R1） */
  subagentArchiveContextPct: number;
  /** subagent_status 状态表附带的历史记录条数上限（≥1 整数；all=true 附最近 N 条，docs/32） */
  subagentStatusHistoryMax: number;
  /** read_archive 存档渲染字符预算（>0 整数；渲染文本超出截为头部 + 省略标记，docs/17） */
  archiveRenderMaxChars: number;
  // ---- 阶段 B 第一批（docs/21 §2.3 前 8 键，docs/22 §4.2）----
  /** 会话级审批升级额度（≥1 整数；沙箱拒绝后的"带 justification 转人工"累计上限） */
  escalationMax: number;
  /** 两级 AGENTS.md 注入截断预算（>0 整数字符） */
  agentsMdMaxChars: number;
  /** MCP stdio 握手超时（≥1000ms；首次运行要下载依赖的服务器可能超 20s） */
  mcpHandshakeTimeoutMs: number;
  /** MCP 工具调用缺省超时（≥1000ms；manager 不传参时全部 mcp__ 工具生效此值） */
  mcpCallTimeoutMs: number;
  /** run_pwsh 输出采集软上限（>0 整数字节；超过停止采集防撑爆内存，修剪由注册表层负责） */
  pwshCaptureMaxBytes: number;
  /** precompact 压缩备份保留份数（≥1 整数；环形覆写——写第 n+1 份前删最老） */
  precompactKeep: number;
  /** spill 目录年龄清扫阈值（≥1 整数小时；启动时清理超过该年龄的会话 spill 目录） */
  spillMaxAgeHours: number;
  /** 沙箱 tmp 目录年龄清扫阈值（≥1 整数小时；启动时清理，与 spill 同策略） */
  sandboxTmpMaxAgeHours: number;
  // ---- 阶段 B 第二批（docs/21 §2.3 后 9 键；随 docs/24 设置页同批可视化）----
  /** view_image 视觉分析超时（≥1000ms；图片理解普遍慢于纯文本，默认给足 120s） */
  visionTimeoutMs: number;
  /** 提供方「测试连接」超时（≥1000ms；慢端点/中转站可调大） */
  providerTestTimeoutMs: number;
  /** 文件三工具（read/write/edit）的适用文件大小边界（>0 整数字节；超出提示改用 run_pwsh） */
  textFileMaxBytes: number;
  /** read_file 缺省读取行数（≥1 整数；大文件/日志分析可调大） */
  readFileDefaultLines: number;
  /** read_file 单次返回字符上限（>0 整数；注册表修剪前先自行收口） */
  readFileMaxChars: number;
  /** agent_task/followup 可申请超时的最小值（≥1000ms；schema/校验/提示词三处共用） */
  subagentTimeoutMinMs: number;
  /** 压缩摘要输入预算（>0 整数字符；超长会话的摘要质量上限，超出截头部） */
  compactionSummaryMaxChars: number;
  /** HTTP 请求体上限（整数字节；**不得低于图片消息 base64 地板值**——规则校验强制，
   *  历史 bug：1MB 上限曾先于图片校验拦截全部图片上传） */
  httpBodyMaxBytes: number;
  /** 每张图片的 token 固定估算（≥1 整数；换视觉模型后可校准口径） */
  imageTokenEst: number;
}

/** harness.json thresholds 的覆盖项：键可省略 = 用缺省。 */
export type ThresholdOverrides = Partial<Record<keyof EffectiveThresholds, number>>;

/** docs/21 §2.2-④：历史拼写错误键名 → 规范名（解析层双读兼容——旧键读到即映射到新键并
 *  告警更名提示；新旧同存时新键优先）。删除本表前先确认无用户配置仍写旧键。 */
const RENAMED_THRESHOLD_KEYS: Readonly<Record<string, keyof EffectiveThresholds>> = {
  compectionPressure: "compactionPressure",
  compectionKeepRatio: "compactionKeepRatio",
  compectionManualKeepTokens: "compactionManualKeepTokens",
};

export interface HarnessConfig {
  /** 要禁用的模块名（如 "tools.pwsh"，内置与外部一视同仁） */
  disabledModules: string[];
  thresholds: ThresholdOverrides;
}

/** 消息图片规则（docs/10 R3；docs/22 §4.1 四重定义收敛）：≤4 张、单张解码后 ≤5MB、
 *  mime 白名单——后端 parseChatImages 校验与前端校验/按钮 title（经 /api/meta 下发）的
 *  单一出处。mimes 取值须与 ChatImage["mime"] 联合类型一致（web-sessions.test.ts 锁定）。
 *  view_image 工具的磁盘文件规则（≤8MB）是另一套语义，不在此收敛。
 *  （定义在阈值规则表之前——HTTP_BODY_FLOOR_BYTES 由它派生。） */
export const IMAGE_RULES = {
  maxCount: 4,
  maxBytes: 5 * 1024 * 1024,
  mimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

/** httpBodyMaxBytes 的地板值（≥ 图片消息极限体积）：maxCount 张解码图 base64 膨胀 ×4/3 + 1MB 余量。
 *  历史 bug 教训（docs/21 §2.2-①）：1MB 请求体上限曾先于图片校验拦截全部图片上传——
 *  该键可配置后必须挡在地板值之上（rules 校验 + 严格写 400 双闸），config.test 锁定。 */
export const HTTP_BODY_FLOOR_BYTES = Math.ceil((IMAGE_RULES.maxCount * IMAGE_RULES.maxBytes * 4) / 3) + 1024 * 1024;

/** tool 事件的完整参数广播上限（docs/28 P2-2，显示层协议常量）：makeUi/makeWorkerUi 给前端
 *  发 args（write_file 的 content / edit_file 的 old_string+new_string 展开体渲染需要全量，
 *  argsPreview 的 160 字符不够）时截到该值——与前端 CFG.TRUNC_TOOL_FULL（工具结果全文显示
 *  截断）同量级；超出截断 + 标记，极端大文件正文只显示头部（完整内容模型侧照旧）。 */
export const TOOL_EVENT_ARGS_MAX_CHARS = 20_000;

// ---- 阈值规则表（docs/24 上提为模块级导出）：每键合法范围的唯一出处 ----
// lenient 读（parseHarnessConfig 逐项忽略+告警）与 fail-closed 写（validateThresholdsStrict
// 整体 400 拒绝）共用同一份定义，仅包装语义不同；thresholdSchema() 把它（+缺省值/分组/
// 重启标注）下发给前端设置页——前端零硬编码（键清单不许出现第二份）。

/** 阈值分组（展示顺序 + 中文标题；group 键与 THRESHOLD_RULES 对应）。 */
export const THRESHOLD_GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "general", label: "通用" },
  { key: "compaction", label: "上下文压缩" },
  { key: "pwsh", label: "run_pwsh（PowerShell 工具）" },
  { key: "subagent", label: "子代理" },
  { key: "mcp", label: "MCP" },
  { key: "vision", label: "图片与视觉" },
  { key: "sweep", label: "启动清扫" },
];

/** 声明式数值范围（校验谓词与 UI 输入约束共用；含边界值用 min/max，开边界用 exclusive*）。 */
export interface ThresholdRange {
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
}

export interface ThresholdRule {
  /** 范围说明（lenient 告警与 400 文案共用，如 "(0,1] 的小数"） */
  hint: string;
  /** 一行用途说明（schema 下发给前端表单 label；废弃键不给也不下发） */
  desc?: string;
  /** 所属分组键（THRESHOLD_GROUPS；废弃键无分组不进 schema） */
  group?: string;
  range: ThresholdRange;
  /** 重启才生效（清扫只在 bootstrap 跑一次；schema 下发供 UI 标注） */
  restart?: boolean;
  /** 解析兼容保留（如 spillThreshold）：读取容忍、schema 不下发、严格写拒绝 */
  deprecated?: boolean;
}

/** 范围判定（THRESHOLD_RULES 的唯一校验谓词——lenient/严格两种包装都经它）。 */
function rangePass(range: ThresholdRange, n: number): boolean {
  if (range.integer && !Number.isInteger(n)) return false;
  if (range.min !== undefined && n < range.min) return false;
  if (range.max !== undefined && n > range.max) return false;
  if (range.exclusiveMin !== undefined && n <= range.exclusiveMin) return false;
  if (range.exclusiveMax !== undefined && n >= range.exclusiveMax) return false;
  return true;
}

/** 全部阈值键的规则表（含废弃键；序 = 模板/文档展示序）。 */
export const THRESHOLD_RULES: Readonly<Record<keyof EffectiveThresholds, ThresholdRule>> = {
  defaultContextLength: {
    hint: ">0 的数字", desc: "上下文长度缺省值（token）——新提供方表单缺省与前端占比显示的兜底", group: "general",
    range: { exclusiveMin: 0 },
  },
  maxToolRounds: {
    hint: "≥1 的整数", desc: "每轮任务的工具调用轮次上限——达到上限后强制收尾总结", group: "general",
    range: { integer: true, min: 1 },
  },
  toolResultMaxChars: {
    hint: ">0 的整数字符数", desc: "工具结果修剪预算（字符）——run_pwsh 与全部 mcp__ 工具统一生效，超出截断", group: "general",
    range: { integer: true, exclusiveMin: 0 },
  },
  agentsMdMaxChars: {
    hint: ">0 的整数字符数", desc: "两级 AGENTS.md 注入截断预算（字符）——超出截断，防撑爆系统提示", group: "general",
    range: { integer: true, exclusiveMin: 0 },
  },
  escalationMax: {
    hint: "≥1 的整数", desc: "审批升级额度——沙箱拒绝后「带理由转人工」的每会话累计上限", group: "general",
    range: { integer: true, min: 1 },
  },
  textFileMaxBytes: {
    hint: ">0 的整数字节数", desc: "文件三工具（read/write/edit）的适用文件大小边界——超出提示改用 run_pwsh", group: "general",
    range: { integer: true, exclusiveMin: 0 },
  },
  readFileDefaultLines: {
    hint: "≥1 的整数行数", desc: "read_file 缺省读取行数——大文件/日志分析可调大（limit 参数可单次覆盖）", group: "general",
    range: { integer: true, min: 1 },
  },
  readFileMaxChars: {
    hint: ">0 的整数字符数", desc: "read_file 单次返回字符上限——进注册表修剪前先自行收口", group: "general",
    range: { integer: true, exclusiveMin: 0 },
  },
  httpBodyMaxBytes: {
    hint: `≥${Math.round(HTTP_BODY_FLOOR_BYTES / 1024 / 1024)}MB 的整数字节数`, desc: "HTTP 请求体上限——不得低于图片消息 base64 地板值（防图片上传被提前拦截）", group: "general",
    range: { integer: true, min: HTTP_BODY_FLOOR_BYTES },
  },
  providerTestTimeoutMs: {
    hint: "≥1000 的毫秒数", desc: "提供方「测试连接」超时——慢端点/中转站可调大", group: "general",
    range: { min: 1_000 },
  },
  compactionPressure: {
    hint: "(0,1] 的小数", desc: "自动压缩触发线——上下文占用达到该比例先压缩再跑轮", group: "compaction",
    range: { exclusiveMin: 0, max: 1 },
  },
  compactionKeepRatio: {
    hint: "(0,1] 的小数", desc: "自动压缩保留预算——尾部完整轮次保留约该比例的上下文窗口", group: "compaction",
    range: { exclusiveMin: 0, max: 1 },
  },
  compactionManualKeepTokens: {
    hint: "≥0 的整数 token", desc: "手动 /compact 保留预算（token；0=全部历史进摘要，压到最小）", group: "compaction",
    range: { integer: true, min: 0 },
  },
  precompactKeep: {
    hint: "≥1 的整数份数", desc: "压缩前备份保留份数（环形覆写）——写新份前删最老", group: "compaction",
    range: { integer: true, min: 1 },
  },
  compactionSummaryMaxChars: {
    hint: ">0 的整数字符数", desc: "压缩摘要输入预算——超长会话的摘要质量上限（超出截头部，备份里仍有全文）", group: "compaction",
    range: { integer: true, exclusiveMin: 0 },
  },
  pwshTimeoutMs: {
    hint: "≥1000 的毫秒数", desc: "run_pwsh 缺省超时", group: "pwsh",
    range: { min: 1_000 },
  },
  pwshMaxTimeoutMs: {
    hint: "≥1000 的毫秒数", desc: "run_pwsh 单次可申请的最大超时（低于缺省超时会在解析层被抬到缺省）", group: "pwsh",
    range: { min: 1_000 },
  },
  pwshCaptureMaxBytes: {
    hint: ">0 的整数字节数", desc: "run_pwsh 输出采集软上限（字节）——超过即停止采集防撑爆内存；展示截断另由 toolResultMaxChars 负责", group: "pwsh",
    range: { integer: true, exclusiveMin: 0 },
  },
  subagentMaxConcurrent: {
    hint: "≥1 的整数", desc: "子代理并发上限——同轮并行派发超出部分立即报错回传（不排队）", group: "subagent",
    range: { integer: true, min: 1 },
  },
  subagentMaxTotal: {
    hint: "≥1 的整数", desc: "每会话子代理累计派出上限——防大型任务成本失控", group: "subagent",
    range: { integer: true, min: 1 },
  },
  subagentMaxToolRounds: {
    hint: "≥1 的整数", desc: "子代理工具轮次上限——达上限收尾总结，保证总能交报告", group: "subagent",
    range: { integer: true, min: 1 },
  },
  subagentResultMaxChars: {
    hint: ">0 的整数字符数", desc: "子代理最终报告字符预算——超出修剪；剪掉量大时全文落 spill 供 read_archive 接续", group: "subagent",
    range: { integer: true, exclusiveMin: 0 },
  },
  subagentMaxTasks: {
    hint: "≥1 的整数", desc: "可复用子代理每实例任务数上限——超出 agent_followup 拒绝", group: "subagent",
    range: { integer: true, min: 1 },
  },
  subagentWarnContextPct: {
    hint: "(0,100] 的整数百分比", desc: "子代理上下文预警线——任务收尾占用超过该值，报告附「上下文过长」预警（仍可追加任务）", group: "subagent",
    range: { integer: true, exclusiveMin: 0, max: 100 },
  },
  subagentFollowupContextPct: {
    hint: "(0,100] 的整数百分比", desc: "followup 拒收线——占用达到该值直接拒绝追加（上下文过长易幻觉），指引归档重派", group: "subagent",
    range: { integer: true, exclusiveMin: 0, max: 100 },
  },
  subagentArchiveContextPct: {
    hint: "(0,100] 的整数百分比", desc: "强制归档线——任务完成时占用超过该值不转待命、直接归档", group: "subagent",
    range: { integer: true, exclusiveMin: 0, max: 100 },
  },
  archiveRenderMaxChars: {
    hint: ">0 的整数字符数", desc: "read_archive 渲染预算（字符）——存档转可读文本超出截头部，防整档灌满接收方上下文", group: "subagent",
    range: { integer: true, exclusiveMin: 0 },
  },
  subagentTimeoutMinMs: {
    hint: "≥1000 的毫秒数", desc: "agent_task/followup 可申请超时（timeoutMs）的最小值——schema/校验/提示词三处同源", group: "subagent",
    range: { min: 1_000 },
  },
  subagentStatusHistoryMax: {
    hint: "≥1 的整数条数", desc: "subagent_status 状态表 all=true 附带的历史记录条数上限（取最近 N 条；工具描述与提示词文案同源插值）", group: "subagent",
    range: { integer: true, min: 1 },
  },
  mcpHandshakeTimeoutMs: {
    hint: "≥1000 的毫秒数", desc: "MCP stdio 握手超时——首次运行要下载依赖/模型的服务器可调大", group: "mcp",
    range: { min: 1_000 },
  },
  mcpCallTimeoutMs: {
    hint: "≥1000 的毫秒数", desc: "MCP 工具调用缺省超时——全部 mcp__ 工具生效", group: "mcp",
    range: { min: 1_000 },
  },
  visionTimeoutMs: {
    hint: "≥1000 的毫秒数", desc: "view_image 视觉分析超时——图片理解普遍慢于纯文本，大图/慢模型可调大", group: "vision",
    range: { min: 1_000 },
  },
  imageTokenEst: {
    hint: "≥1 的整数 token", desc: "每张图片的 token 固定估算——仅影响用量估算显示与压缩判定，换视觉模型后可校准", group: "vision",
    range: { integer: true, min: 1 },
  },
  spillMaxAgeHours: {
    hint: "≥1 的整数小时", desc: "spill 过程档案清扫年龄（小时）——启动时删除超龄的会话 spill 目录", group: "sweep",
    range: { integer: true, min: 1 }, restart: true,
  },
  sandboxTmpMaxAgeHours: {
    hint: "≥1 的整数小时", desc: "沙箱 tmp 清扫年龄（小时）——启动时清理超龄临时目录", group: "sweep",
    range: { integer: true, min: 1 }, restart: true,
  },
  // 废弃键（docs/10 R2）：读取容忍（无未知键告警）、schema 不下发、严格写拒绝。
  spillThreshold: { hint: "≥0 的整数字符数", range: { integer: true, min: 0 }, deprecated: true },
};

export interface ThresholdSchemaEntry {
  key: keyof EffectiveThresholds;
  group: string;
  hint: string;
  desc: string;
  /** 缺省值（resolveThresholds({}) 同源——不与 rules 表另立数值） */
  def: number;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  integer?: boolean;
  restart?: boolean;
}

/** 阈值元数据（前端设置页的单一出处）：活跃键全量 + 分组标题；废弃键不入表。 */
export function thresholdSchema(): { groups: typeof THRESHOLD_GROUPS; entries: ThresholdSchemaEntry[] } {
  const defaults = resolveThresholds({});
  const entries: ThresholdSchemaEntry[] = [];
  for (const g of THRESHOLD_GROUPS) {
    for (const [key, rule] of Object.entries(THRESHOLD_RULES) as Array<[keyof EffectiveThresholds, ThresholdRule]>) {
      if (rule.deprecated || rule.group !== g.key) continue;
      entries.push({
        key,
        group: g.key,
        hint: rule.hint,
        desc: rule.desc ?? key,
        def: defaults[key],
        ...rule.range,
        ...(rule.restart ? { restart: true } : {}),
      });
    }
  }
  return { groups: THRESHOLD_GROUPS, entries };
}

/** 严格写校验（fail-closed，与 parseHarnessConfig 的 lenient 语义相反）：任一键非法 → 整体拒绝。
 *  消费方 = 前端设置页的 POST（用户在界面上改，要即时反馈、不落盘脏数据）。
 *  pwsh 交叉校验取严格口径：max < timeout 直接拒绝（lenient 读侧的静默抬升保留给手写文件）。 */
export function validateThresholdsStrict(
  raw: unknown,
): { ok: true; thresholds: ThresholdOverrides } | { ok: false; errors: Array<{ key: string; message: string }> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ key: "", message: "thresholds 必须是对象（键 → 数值）" }] };
  }
  const errors: Array<{ key: string; message: string }> = [];
  const out: ThresholdOverrides = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const rule = (THRESHOLD_RULES as Record<string, ThresholdRule | undefined>)[key];
    if (!rule) {
      errors.push({ key, message: `未知阈值键 "${key}"（不在可配置清单中，检查拼写）` });
      continue;
    }
    if (rule.deprecated) {
      errors.push({ key, message: `"${key}" 已废弃（运行时无消费方），请从表单移除` });
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || !rangePass(rule.range, v)) {
      errors.push({ key, message: `"${key}" 的值 ${JSON.stringify(v)} 不合法（应为${rule.hint}）` });
      continue;
    }
    out[key as keyof EffectiveThresholds] = v;
  }
  if (errors.length > 0) return { ok: false, errors };
  // pwsh 交叉校验对「提交项 + 缺省回填」的整体判定（整体替换语义：未提交的键按缺省参与组合）
  const eff = resolveThresholds(out);
  const pure = resolveThresholds({});
  const rawMax = out.pwshMaxTimeoutMs ?? pure.pwshMaxTimeoutMs;
  if (rawMax < eff.pwshTimeoutMs) {
    return {
      ok: false,
      errors: [
        {
          key: "pwshMaxTimeoutMs",
          message: `"pwshMaxTimeoutMs"（${rawMax}）不得低于 "pwshTimeoutMs"（当前生效 ${eff.pwshTimeoutMs}）——请先调大最大超时或调小缺省超时`,
        },
      ],
    };
  }
  return { ok: true, thresholds: out };
}

/** 解析 harness.json 内容（纯函数，供测试）：非法顶层/字段逐项忽略并给出告警文案。 */
export function parseHarnessConfig(raw: unknown): { config: HarnessConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: HarnessConfig = { disabledModules: [], thresholds: {} };
  if (raw === undefined || raw === null) return { config, warnings };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("顶层必须是 JSON 对象，已忽略整个文件");
    return { config, warnings };
  }
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key !== "disabledModules" && key !== "thresholds") warnings.push(`未知顶层键 "${key}"，已忽略（检查拼写）`);
  }
  if (v.disabledModules !== undefined) {
    if (!Array.isArray(v.disabledModules)) {
      warnings.push("disabledModules 必须是字符串数组，已忽略");
    } else {
      for (const x of v.disabledModules) {
        if (typeof x !== "string" || !x.trim() || /\s/.test(x.trim())) {
          warnings.push(`disabledModules 含非法项 ${JSON.stringify(x)}，已跳过`);
          continue;
        }
        if (!config.disabledModules.includes(x.trim())) config.disabledModules.push(x.trim());
      }
    }
  }
  if (v.thresholds !== undefined) {
    if (!v.thresholds || typeof v.thresholds !== "object" || Array.isArray(v.thresholds)) {
      warnings.push("thresholds 必须是对象，已忽略");
    } else {
      const t = v.thresholds as Record<string, unknown>;
      // 先做旧键→新键归一（docs/21 §2.2-④）：旧拼写键一律告警更名提示，值仅在无新键时采纳
      const normalized: Record<string, unknown> = {};
      for (const rawKey of Object.keys(t)) {
        const renamed = RENAMED_THRESHOLD_KEYS[rawKey];
        if (!renamed) {
          normalized[rawKey] = t[rawKey];
          continue;
        }
        warnings.push(`阈值键 "${rawKey}" 已更名 "${renamed}"（拼写修正），兼容读取，建议改用新键`);
        if (!(renamed in t)) normalized[renamed] = t[rawKey];
      }
      for (const key of Object.keys(normalized)) {
        const rule = (THRESHOLD_RULES as Record<string, ThresholdRule | undefined>)[key];
        if (!rule) {
          warnings.push(`未知阈值 "${key}"，已忽略（检查拼写）`);
          continue;
        }
        const n = normalized[key];
        if (typeof n !== "number" || !Number.isFinite(n) || !rangePass(rule.range, n)) {
          warnings.push(`阈值 "${key}" 的值 ${JSON.stringify(n)} 不合法（应为${rule.hint}），已忽略`);
          continue;
        }
        config.thresholds[key as keyof EffectiveThresholds] = n;
      }
    }
  }
  return { config, warnings };
}

/** 缺省值 + 覆盖项 → 生效值（含 pwsh 超时交叉校验：最大超时不得低于缺省超时）。 */
export function resolveThresholds(t: ThresholdOverrides): EffectiveThresholds {
  const out: EffectiveThresholds = {
    compactionPressure: t.compactionPressure ?? 0.8,
    spillThreshold: t.spillThreshold ?? 20_000,
    compactionKeepRatio: t.compactionKeepRatio ?? 0.3,
    compactionManualKeepTokens: t.compactionManualKeepTokens ?? 0,
    defaultContextLength: t.defaultContextLength ?? 1_000_000,
    maxToolRounds: t.maxToolRounds ?? 15,
    pwshTimeoutMs: t.pwshTimeoutMs ?? 60_000,
    pwshMaxTimeoutMs: t.pwshMaxTimeoutMs ?? 300_000,
    toolResultMaxChars: t.toolResultMaxChars ?? 48_000,
    subagentMaxConcurrent: t.subagentMaxConcurrent ?? 3,
    subagentMaxTotal: t.subagentMaxTotal ?? 24,
    subagentMaxToolRounds: t.subagentMaxToolRounds ?? 40,
    subagentResultMaxChars: t.subagentResultMaxChars ?? 16_000,
    subagentMaxTasks: t.subagentMaxTasks ?? 12,
    subagentFollowupContextPct: t.subagentFollowupContextPct ?? 35,
    subagentWarnContextPct: t.subagentWarnContextPct ?? 25,
    subagentArchiveContextPct: t.subagentArchiveContextPct ?? 50,
    archiveRenderMaxChars: t.archiveRenderMaxChars ?? 160_000,
    escalationMax: t.escalationMax ?? 8,
    agentsMdMaxChars: t.agentsMdMaxChars ?? 16_000,
    mcpHandshakeTimeoutMs: t.mcpHandshakeTimeoutMs ?? 20_000,
    mcpCallTimeoutMs: t.mcpCallTimeoutMs ?? 60_000,
    pwshCaptureMaxBytes: t.pwshCaptureMaxBytes ?? 1_000_000,
    precompactKeep: t.precompactKeep ?? 3,
    spillMaxAgeHours: t.spillMaxAgeHours ?? 168,
    sandboxTmpMaxAgeHours: t.sandboxTmpMaxAgeHours ?? 24,
    visionTimeoutMs: t.visionTimeoutMs ?? 120_000,
    providerTestTimeoutMs: t.providerTestTimeoutMs ?? 20_000,
    textFileMaxBytes: t.textFileMaxBytes ?? 5 * 1024 * 1024,
    readFileDefaultLines: t.readFileDefaultLines ?? 4_000,
    readFileMaxChars: t.readFileMaxChars ?? 200_000,
    subagentTimeoutMinMs: t.subagentTimeoutMinMs ?? 60_000,
    subagentStatusHistoryMax: t.subagentStatusHistoryMax ?? 20,
    compactionSummaryMaxChars: t.compactionSummaryMaxChars ?? 300_000,
    httpBodyMaxBytes: t.httpBodyMaxBytes ?? 32 * 1024 * 1024,
    imageTokenEst: t.imageTokenEst ?? 800,
  };
  if (out.pwshMaxTimeoutMs < out.pwshTimeoutMs) out.pwshMaxTimeoutMs = out.pwshTimeoutMs;
  return out;
}

/** harness.json 的规范位置：~/.ZQQ-harness/harness.json */
export function harnessFilePath(): string {
  return join(homedir(), USER_DIR_NAME, USER_DIR_LAYOUT.harnessFile);
}

/** 剥离 JSONC 注释（`//` 行注释与 `/* … *\/` 块注释）：逐字符扫描并跟踪字符串字面量与
 *  转义——字符串内的注释符（如 URL `"https://…"`）原样保留；行注释保留换行、块注释替换
 *  为单空格（防相邻 token 粘连）。harness.json 因此允许自带文档注释（逐键说明用途的
 *  全键模板见用户目录；写回方可以不写注释，解析两种都接受）。纯函数，供测试。 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1; // 行注释：连同内容丢弃，保留换行
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, text.length);
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 读取 harness.json（lenient）：缺失 → 全缺省；JSON 损坏 → 全缺省 + 告警；字段非法 → 逐项忽略 + 告警。
 *  支持 JSONC 注释（见 stripJsonComments）——注释不是必需，纯 JSON 同样合法。 */
export function loadHarnessConfig(path = harnessFilePath()): HarnessConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { disabledModules: [], thresholds: {} }; // 文件不存在（常态），静默用缺省
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (e) {
    console.error(`[harness.json] 解析失败（${e instanceof Error ? e.message : String(e)}），本次启动全部使用缺省值`);
    return { disabledModules: [], thresholds: {} };
  }
  const { config, warnings } = parseHarnessConfig(raw);
  for (const w of warnings) console.error(`[harness.json] ${w}`);
  return config;
}

/** 生效常量的纯缺省初值（导入期不读任何环境文件——initConfig 前的确定状态）。 */
const DEFAULT_EFFECTIVE = resolveThresholds({});

/** harness.json 装载结果（initConfig 重绑；导入期 = 空配置）：server.ts bootstrap 用
 *  disabledModules 过滤组合清单（P8）。 */
export let HARNESS_CONFIG: HarnessConfig = { disabledModules: [], thresholds: {} };

export let DEFAULTS = {
  maxToolRounds: DEFAULT_EFFECTIVE.maxToolRounds,
  pwshTimeoutMs: DEFAULT_EFFECTIVE.pwshTimeoutMs,
  pwshMaxTimeoutMs: DEFAULT_EFFECTIVE.pwshMaxTimeoutMs,
  /** 注册表级工具结果修剪预算（字符）：对 run_pwsh 与所有 mcp__ 工具统一生效 */
  toolResultMaxChars: DEFAULT_EFFECTIVE.toolResultMaxChars,
};

/** 上下文压缩触发阈值：contextPressure >= 该值时先压缩再跑轮（UI 同步预警高亮，阈值随 meta 下发）。 */
export let COMPACTION_PRESSURE = DEFAULT_EFFECTIVE.compactionPressure;
// spillThreshold 已废弃（docs/10 R2）：修剪改为「只保留头部 + 触发即全文落盘」，无门槛；
// 键仅为兼容旧 harness.json 保留解析（见 EffectiveThresholds 注释），不再导出常量。

/** 压缩保留预算：尾部完整轮次保留约 30% 上下文窗口的 token（自动触发/溢出兜底用）。 */
export let COMPACTION_KEEP_RATIO = DEFAULT_EFFECTIVE.compactionKeepRatio;

/**
 * 手动压缩（/api/compact）的保留预算（token）：用户主动 /compact 的预期是"立即显著变小"。
 * 取 0 = 不保留尾部轮次，全部历史进摘要（知识由摘要承载，压缩前有 precompact 备份兜底）。
 * 若沿用 KEEP_RATIO × 上下文长度（1M 提供方=30 万 token），切点算法"保留最多"会几乎切不动
 * （实测表现即"压缩后上下文没变"）；即便设 4k，短对话仍会只摘要一条消息、上下文不降反升。
 * 自动触发/溢出兜底仍走 KEEP_RATIO（保留工作集），语义分开。
 */
export let COMPACTION_MANUAL_KEEP_TOKENS = DEFAULT_EFFECTIVE.compactionManualKeepTokens;

/** 上下文长度的缺省值（提供方表单缺省、前端占比显示兜底）：随 /api/meta 下发，前端不再硬编码。 */
export let DEFAULT_CONTEXT_LENGTH = DEFAULT_EFFECTIVE.defaultContextLength;

/** 子代理（worker）并发上限：并行派发（docs/15：同轮多个 agent_task 调用）超出部分立即报错回传（不排队）。 */
export let SUBAGENT_MAX_CONCURRENT = DEFAULT_EFFECTIVE.subagentMaxConcurrent;

/** 每会话子代理累计上限：超出立即报错回传（防大型任务成本失控）。 */
export let SUBAGENT_MAX_TOTAL = DEFAULT_EFFECTIVE.subagentMaxTotal;

/** 子代理（worker）工具调用轮次上限：沿用 Agent 的"达上限收尾总结"机制。 */
export let SUBAGENT_MAX_TOOL_ROUNDS = DEFAULT_EFFECTIVE.subagentMaxToolRounds;

/** 子代理最终报告字符预算：超出修剪为预算内文本 + spill 全文引用。 */
export let SUBAGENT_RESULT_MAX_CHARS = DEFAULT_EFFECTIVE.subagentResultMaxChars;

/** 可复用子代理每实例任务数上限（docs/9）：超出 agent_followup 立即报错回传（防无限追加成本失控）。 */
export let SUBAGENT_MAX_TASKS = DEFAULT_EFFECTIVE.subagentMaxTasks;

/** 可复用子代理的 followup 上下文门槛（docs/10 R1，默认 35%）：上次任务收尾时上下文占用
 *  ≥ 该值则 agent_followup 直接拒绝（上下文过长易幻觉；服务端硬闸，不依赖模型自觉）。 */
export let SUBAGENT_FOLLOWUP_CONTEXT_PCT = DEFAULT_EFFECTIVE.subagentFollowupContextPct;

/** 子代理上下文过长预警线（docs/10 R1 修订，默认 25%）：任务收尾占用 > 该值时结果文本/
 *  待命提示附「上下文过长」预警（>30 预警、≥35 拒收、>50 强制归档三档的前档）。 */
export let SUBAGENT_WARN_CONTEXT_PCT = DEFAULT_EFFECTIVE.subagentWarnContextPct;

/** 可复用子代理的强制归档线（docs/10 R1，默认 50%）：任务完成时上下文占用 > 该值则不转
 *  待命、直接归档（继续驻留只会诱导协调者向高幻觉风险实例追加任务）。 */
export let SUBAGENT_ARCHIVE_CONTEXT_PCT = DEFAULT_EFFECTIVE.subagentArchiveContextPct;

/** read_archive 存档渲染字符预算（docs/17，默认 160k）：JSON→可读文本超出截为头部 + 省略标记
 *  （pruneToolResult 同款），防整份多任务存档一次性灌满接收方上下文。 */
export let ARCHIVE_RENDER_MAX_CHARS = DEFAULT_EFFECTIVE.archiveRenderMaxChars;

// ---- 阶段 B 第一批（docs/21 §2.3 前 8 键，docs/22 §4.2）：全部经 harness.json thresholds 可覆盖 ----

/** 会话级审批升级额度（默认 8）：沙箱拒绝后带 justification 转人工的累计上限（pwsh.ts 消费）。 */
export let ESCALATION_MAX = DEFAULT_EFFECTIVE.escalationMax;

/** 两级 AGENTS.md 注入截断预算（默认 16000 字符；workspace.ts 消费）。 */
export let AGENTS_MD_MAX_CHARS = DEFAULT_EFFECTIVE.agentsMdMaxChars;

/** run_pwsh 输出采集软上限（默认 1MB）：超过停止采集防撑爆内存，输出修剪由注册表层统一负责。 */
export let PWSH_CAPTURE_MAX_BYTES = DEFAULT_EFFECTIVE.pwshCaptureMaxBytes;

/** precompact 压缩备份保留份数（默认 3）：backupBeforeCompact 环形覆写——写第 n+1 份前删最老。 */
export let PRECOMPACT_KEEP = DEFAULT_EFFECTIVE.precompactKeep;

/** spill 目录年龄清扫阈值（默认 168h=7 天）：启动时 sweepStaleSpill 清理超龄会话 spill 目录。 */
export let SPILL_MAX_AGE_HOURS = DEFAULT_EFFECTIVE.spillMaxAgeHours;

/** 沙箱 tmp 目录年龄清扫阈值（默认 24h）：启动时 sweepStaleSandboxTmp 传参生效值。 */
export let SANDBOX_TMP_MAX_AGE_HOURS = DEFAULT_EFFECTIVE.sandboxTmpMaxAgeHours;

/** MCP stdio 握手超时（默认 20s；transport 与 mcp-manage 提示词共用——文案插值自动跟随覆盖值）。 */
export let MCP_HANDSHAKE_TIMEOUT_MS = DEFAULT_EFFECTIVE.mcpHandshakeTimeoutMs;

/** MCP 工具调用缺省超时（默认 60s；manager 不传参时全部 mcp__ 工具生效此值）。 */
export let MCP_CALL_TIMEOUT_MS = DEFAULT_EFFECTIVE.mcpCallTimeoutMs;

// ---- 阶段 B 第二批（docs/21 §2.3 后 9 键；文件大小/读取行数/超时/估算口径的边界类） ----

/** view_image 视觉分析超时（默认 120s——图片理解普遍慢于纯文本）。 */
export let VISION_TIMEOUT_MS = DEFAULT_EFFECTIVE.visionTimeoutMs;

/** 提供方「测试连接」超时（默认 20s）。 */
export let PROVIDER_TEST_TIMEOUT_MS = DEFAULT_EFFECTIVE.providerTestTimeoutMs;

/** 文件三工具（read/write/edit）的适用文件大小边界（默认 5MB；file-tools 消费并 re-export）。 */
export let TEXT_FILE_MAX_BYTES = DEFAULT_EFFECTIVE.textFileMaxBytes;

/** read_file 缺省读取行数（默认 4000）。 */
export let READ_FILE_DEFAULT_LINES = DEFAULT_EFFECTIVE.readFileDefaultLines;

/** read_file 单次返回字符上限（默认 200k——注册表修剪前先自行收口）。 */
export let READ_FILE_MAX_CHARS = DEFAULT_EFFECTIVE.readFileMaxChars;

/** 压缩摘要输入预算（默认 300k 字符；超出截头部，备份里仍有全文）。 */
export let COMPACTION_SUMMARY_MAX_CHARS = DEFAULT_EFFECTIVE.compactionSummaryMaxChars;

/** HTTP 请求体上限（默认 32MB；校验强制 ≥ HTTP_BODY_FLOOR_BYTES——core/http 消费并 re-export）。 */
export let HTTP_BODY_MAX_BYTES = DEFAULT_EFFECTIVE.httpBodyMaxBytes;

/** 每张图片的 token 固定估算（默认 800；tokens.ts 消费并 re-export）。 */
export let IMAGE_TOKEN_EST = DEFAULT_EFFECTIVE.imageTokenEst;

/**
 * 显式装载 harness.json 并重绑全部生效常量（docs/21 §3.3 / docs/23 D2）：
 * - server.ts bootstrap 调用一次（缺省参读规范位置文件，lenient）；
 * - 测试/直调入口**不调用**即保持纯缺省（导入态不受真机 ~/.ZQQ-harness/harness.json 感染）；
 *   要验证覆盖行为就显式传 cfg（如 initConfig({ disabledModules: [], thresholds: {...}) }），
 *   重置回缺省传空配置即可——可重复调用，最后一次生效。
 * 前置纪律：调用前不得有模块在导入期消费过生效常量（那会冻结初值，见文件头注释）。
 */
export function initConfig(cfg: HarnessConfig = loadHarnessConfig()): HarnessConfig {
  HARNESS_CONFIG = cfg;
  const eff = resolveThresholds(cfg.thresholds);
  DEFAULTS = {
    maxToolRounds: eff.maxToolRounds,
    pwshTimeoutMs: eff.pwshTimeoutMs,
    pwshMaxTimeoutMs: eff.pwshMaxTimeoutMs,
    toolResultMaxChars: eff.toolResultMaxChars,
  };
  COMPACTION_PRESSURE = eff.compactionPressure;
  COMPACTION_KEEP_RATIO = eff.compactionKeepRatio;
  COMPACTION_MANUAL_KEEP_TOKENS = eff.compactionManualKeepTokens;
  DEFAULT_CONTEXT_LENGTH = eff.defaultContextLength;
  SUBAGENT_MAX_CONCURRENT = eff.subagentMaxConcurrent;
  SUBAGENT_MAX_TOTAL = eff.subagentMaxTotal;
  SUBAGENT_MAX_TOOL_ROUNDS = eff.subagentMaxToolRounds;
  SUBAGENT_RESULT_MAX_CHARS = eff.subagentResultMaxChars;
  SUBAGENT_MAX_TASKS = eff.subagentMaxTasks;
  SUBAGENT_FOLLOWUP_CONTEXT_PCT = eff.subagentFollowupContextPct;
  SUBAGENT_WARN_CONTEXT_PCT = eff.subagentWarnContextPct;
  SUBAGENT_ARCHIVE_CONTEXT_PCT = eff.subagentArchiveContextPct;
  ARCHIVE_RENDER_MAX_CHARS = eff.archiveRenderMaxChars;
  ESCALATION_MAX = eff.escalationMax;
  AGENTS_MD_MAX_CHARS = eff.agentsMdMaxChars;
  PWSH_CAPTURE_MAX_BYTES = eff.pwshCaptureMaxBytes;
  PRECOMPACT_KEEP = eff.precompactKeep;
  SPILL_MAX_AGE_HOURS = eff.spillMaxAgeHours;
  SANDBOX_TMP_MAX_AGE_HOURS = eff.sandboxTmpMaxAgeHours;
  MCP_HANDSHAKE_TIMEOUT_MS = eff.mcpHandshakeTimeoutMs;
  MCP_CALL_TIMEOUT_MS = eff.mcpCallTimeoutMs;
  VISION_TIMEOUT_MS = eff.visionTimeoutMs;
  PROVIDER_TEST_TIMEOUT_MS = eff.providerTestTimeoutMs;
  TEXT_FILE_MAX_BYTES = eff.textFileMaxBytes;
  READ_FILE_DEFAULT_LINES = eff.readFileDefaultLines;
  READ_FILE_MAX_CHARS = eff.readFileMaxChars;
  SUBAGENT_TIMEOUT_MIN_MS = eff.subagentTimeoutMinMs;
  SUBAGENT_STATUS_HISTORY_MAX = eff.subagentStatusHistoryMax;
  COMPACTION_SUMMARY_MAX_CHARS = eff.compactionSummaryMaxChars;
  HTTP_BODY_MAX_BYTES = eff.httpBodyMaxBytes;
  IMAGE_TOKEN_EST = eff.imageTokenEst;
  return cfg;
}

// ---- 跨文件共享的运行常量（docs/21 §2.2/§2.4：单一出处，消重复定义） ----

/** 子代理任务 timeoutMs 的最小值（agent-task schema/校验/提示词三处共用同一出处；
 *  阶段 B 第二批已配置化——阈值键 subagentTimeoutMinMs，initConfig 重绑） */
export let SUBAGENT_TIMEOUT_MIN_MS = DEFAULT_EFFECTIVE.subagentTimeoutMinMs;

/** subagent_status 状态表 all=true 附带的历史记录条数上限（最近 N 条；docs/32，
 *  阈值键 subagentStatusHistoryMax——工具描述/提示词文案同源插值，initConfig 重绑热生效） */
export let SUBAGENT_STATUS_HISTORY_MAX = DEFAULT_EFFECTIVE.subagentStatusHistoryMax;

/**
 * 前端设置项唯一出处（模块化架构重构 §4.11/§5）：随 /api/meta 下发，
 * 前端的思考档位/沙箱档位 option、档位文案、/think levels、/sandbox 别名全部由此渲染。
 */
export const EFFORT_OPTIONS: ReadonlyArray<{ value: EffortSetting; label: string; form: string }> = [
  { value: "default", label: "💭 默认", form: "默认（不添加思考参数）" },
  { value: "off", label: "💭 关", form: "关（显式关闭思考）" },
  { value: "low", label: "💭 低", form: "低" },
  { value: "high", label: "💭 高", form: "高" },
  { value: "max", label: "💭 最高", form: "最高" },
];

export const SANDBOX_OPTIONS: ReadonlyArray<{ value: SandboxMode; label: string; text: string }> =
  SANDBOX_MODES.map((m) =>
    m === "read-only"
      ? { value: m, label: "🔒 只读", text: "只读" }
      : m === "workspace-write"
        ? { value: m, label: "🗂 工作区可写", text: "工作区可写" }
        : { value: m, label: "⚠ 全开放（守卫+审批）", text: "全开放（守卫+审批）" },
  );

/** /sandbox 别名表（三档全名恒可用，缩写在此）；/think 的 on→high 同理属命令语义，留在前端。 */
export const SANDBOX_ALIASES: Readonly<Record<string, SandboxMode>> = {
  readonly: "read-only",
  ro: "read-only",
  ws: "workspace-write",
  full: "danger-full-access",
};

/**
 * DeepSeek（openai 路线）思考回传开关：env REASONING_PASSBACK=1/on/true/yes 开启，默认关。
 * 依据：实测不回传 reasoning_content 也无 400，默认关省 token；若 DeepSeek 收紧校验
 * （thinking 模式 + tools 请求要求回传历史思考），置 on 即合规，零代码改动。
 * 仅在思考档位（low/high/max）生效；anthropic 路线思考块恒回传，不受本开关控制。
 */
export function reasoningPassbackEnabled(): boolean {
  const v = process.env.REASONING_PASSBACK?.trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

/** 思考模式判定：low/high/max 为思考模式；default（不发参数）与 off（显式关闭）都不是。 */
export function isThinkingEffort(e: EffortSetting): boolean {
  return e === "low" || e === "high" || e === "max";
}

/** 解析极简 "KEY: value" 行式 YAML（.credentials.yaml 就是这种格式，避免引入 yaml 依赖）。 */
export function parseCredentialsYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** API key 文件的规范位置：~/.ZQQ-harness/.credentials.yaml（用户目录，随账号自动定位） */
export function credentialsFilePath(): string {
  return join(homedir(), USER_DIR_NAME, USER_DIR_LAYOUT.credentialsFile);
}

/** 环境变量优先；否则按顺序在给定候选路径里找 .credentials.yaml。找不到抛错。 */
export function loadApiKey(credentialFilePaths: string[]): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  for (const p of credentialFilePaths) {
    try {
      const key = parseCredentialsYaml(readFileSync(p, "utf8"))["DEEPSEEK_API_KEY"]?.trim();
      if (key) return key;
    } catch {
      // 文件不存在，继续找下一个
    }
  }
  throw new Error(
    "找不到 DEEPSEEK_API_KEY：请设置环境变量 DEEPSEEK_API_KEY，或在启动目录/工作区根目录放置 .credentials.yaml（内容形如 DEEPSEEK_API_KEY: sk-xxx）",
  );
}

/** 运行参数（pwsh 超时、工具轮次上限）。提供方连接信息在 providers.json 管理。 */
export function loadConfig(_cwd?: string): AppConfig {
  return {
    maxToolRounds: DEFAULTS.maxToolRounds,
    pwshTimeoutMs: DEFAULTS.pwshTimeoutMs,
    pwshMaxTimeoutMs: DEFAULTS.pwshMaxTimeoutMs,
  };
}
