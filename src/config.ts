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
// 导入期解析一次（lenient：文件缺失/JSON 损坏 → 全缺省，字段非法 → 逐项忽略，均告警不阻止启动）。
// 下面的阈值常量与 DEFAULTS 都是"生效值"（resolveThresholds 输出）——消费方零改动；
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
      const rules: Record<keyof EffectiveThresholds, { hint: string; test: (n: number) => boolean }> = {
        compactionPressure: { hint: "(0,1] 的小数", test: (n) => n > 0 && n <= 1 },
        compactionKeepRatio: { hint: "(0,1] 的小数", test: (n) => n > 0 && n <= 1 },
        compactionManualKeepTokens: { hint: "≥0 的整数 token", test: (n) => Number.isInteger(n) && n >= 0 },
        spillThreshold: { hint: "≥0 的整数字符数", test: (n) => Number.isInteger(n) && n >= 0 },
        defaultContextLength: { hint: ">0 的数字", test: (n) => n > 0 },
        maxToolRounds: { hint: "≥1 的整数", test: (n) => Number.isInteger(n) && n >= 1 },
        pwshTimeoutMs: { hint: "≥1000 的毫秒数", test: (n) => n >= 1_000 },
        pwshMaxTimeoutMs: { hint: "≥1000 的毫秒数", test: (n) => n >= 1_000 },
        toolResultMaxChars: { hint: ">0 的整数字符数", test: (n) => Number.isInteger(n) && n > 0 },
        subagentMaxConcurrent: { hint: "≥1 的整数", test: (n) => Number.isInteger(n) && n >= 1 },
        subagentMaxTotal: { hint: "≥1 的整数", test: (n) => Number.isInteger(n) && n >= 1 },
        subagentMaxToolRounds: { hint: "≥1 的整数", test: (n) => Number.isInteger(n) && n >= 1 },
        subagentResultMaxChars: { hint: ">0 的整数字符数", test: (n) => Number.isInteger(n) && n > 0 },
        subagentMaxTasks: { hint: "≥1 的整数", test: (n) => Number.isInteger(n) && n >= 1 },
        subagentFollowupContextPct: { hint: "(0,100] 的整数百分比", test: (n) => Number.isInteger(n) && n > 0 && n <= 100 },
        subagentWarnContextPct: { hint: "(0,100] 的整数百分比", test: (n) => Number.isInteger(n) && n > 0 && n <= 100 },
        subagentArchiveContextPct: { hint: "(0,100] 的整数百分比", test: (n) => Number.isInteger(n) && n > 0 && n <= 100 },
        archiveRenderMaxChars: { hint: ">0 的整数字符数", test: (n) => Number.isInteger(n) && n > 0 },
        escalationMax: { hint: "≥1 的整数", test: (n) => Number.isInteger(n) && n >= 1 },
        agentsMdMaxChars: { hint: ">0 的整数字符数", test: (n) => Number.isInteger(n) && n > 0 },
        mcpHandshakeTimeoutMs: { hint: "≥1000 的毫秒数", test: (n) => n >= 1_000 },
        mcpCallTimeoutMs: { hint: "≥1000 的毫秒数", test: (n) => n >= 1_000 },
        pwshCaptureMaxBytes: { hint: ">0 的整数字节数", test: (n) => Number.isInteger(n) && n > 0 },
        precompactKeep: { hint: "≥1 的整数份数", test: (n) => Number.isInteger(n) && n >= 1 },
        spillMaxAgeHours: { hint: "≥1 的整数小时", test: (n) => Number.isInteger(n) && n >= 1 },
        sandboxTmpMaxAgeHours: { hint: "≥1 的整数小时", test: (n) => Number.isInteger(n) && n >= 1 },
      };
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
        const rule = (rules as Record<string, (typeof rules)[keyof EffectiveThresholds]>)[key];
        if (!rule) {
          warnings.push(`未知阈值 "${key}"，已忽略（检查拼写）`);
          continue;
        }
        const n = normalized[key];
        if (typeof n !== "number" || !Number.isFinite(n) || !rule.test(n)) {
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
    toolResultMaxChars: t.toolResultMaxChars ?? 24_000,
    subagentMaxConcurrent: t.subagentMaxConcurrent ?? 3,
    subagentMaxTotal: t.subagentMaxTotal ?? 24,
    subagentMaxToolRounds: t.subagentMaxToolRounds ?? 40,
    subagentResultMaxChars: t.subagentResultMaxChars ?? 8_000,
    subagentMaxTasks: t.subagentMaxTasks ?? 12,
    subagentFollowupContextPct: t.subagentFollowupContextPct ?? 35,
    subagentWarnContextPct: t.subagentWarnContextPct ?? 25,
    subagentArchiveContextPct: t.subagentArchiveContextPct ?? 50,
    archiveRenderMaxChars: t.archiveRenderMaxChars ?? 80_000,
    escalationMax: t.escalationMax ?? 8,
    agentsMdMaxChars: t.agentsMdMaxChars ?? 16_000,
    mcpHandshakeTimeoutMs: t.mcpHandshakeTimeoutMs ?? 20_000,
    mcpCallTimeoutMs: t.mcpCallTimeoutMs ?? 60_000,
    pwshCaptureMaxBytes: t.pwshCaptureMaxBytes ?? 1_000_000,
    precompactKeep: t.precompactKeep ?? 3,
    spillMaxAgeHours: t.spillMaxAgeHours ?? 168,
    sandboxTmpMaxAgeHours: t.sandboxTmpMaxAgeHours ?? 24,
  };
  if (out.pwshMaxTimeoutMs < out.pwshTimeoutMs) out.pwshMaxTimeoutMs = out.pwshTimeoutMs;
  return out;
}

/** harness.json 的规范位置：~/.ZQQ-harness/harness.json */
export function harnessFilePath(): string {
  return join(homedir(), USER_DIR_NAME, USER_DIR_LAYOUT.harnessFile);
}

/** 读取 harness.json（lenient）：缺失 → 全缺省；JSON 损坏 → 全缺省 + 告警；字段非法 → 逐项忽略 + 告警。 */
export function loadHarnessConfig(path = harnessFilePath()): HarnessConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { disabledModules: [], thresholds: {} }; // 文件不存在（常态），静默用缺省
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error(`[harness.json] 解析失败（${e instanceof Error ? e.message : String(e)}），本次启动全部使用缺省值`);
    return { disabledModules: [], thresholds: {} };
  }
  const { config, warnings } = parseHarnessConfig(raw);
  for (const w of warnings) console.error(`[harness.json] ${w}`);
  return config;
}

/** 导入期解析一次（与 credentialsFilePath 同一用户目录约定）；消费方经下方生效常量取值。 */
const HARNESS = loadHarnessConfig();

/** harness.json 解析结果：server.ts bootstrap 用 disabledModules 过滤组合清单（P8）。 */
export const HARNESS_CONFIG: HarnessConfig = HARNESS;

const EFFECTIVE = resolveThresholds(HARNESS.thresholds);

export const DEFAULTS = {
  maxToolRounds: EFFECTIVE.maxToolRounds,
  pwshTimeoutMs: EFFECTIVE.pwshTimeoutMs,
  pwshMaxTimeoutMs: EFFECTIVE.pwshMaxTimeoutMs,
  /** 注册表级工具结果修剪预算（字符）：对 run_pwsh 与所有 mcp__ 工具统一生效 */
  toolResultMaxChars: EFFECTIVE.toolResultMaxChars,
};

/** 上下文压缩触发阈值：contextPressure >= 该值时先压缩再跑轮（UI 同步预警高亮，阈值随 meta 下发）。 */
export const COMPACTION_PRESSURE = EFFECTIVE.compactionPressure;
// spillThreshold 已废弃（docs/10 R2）：修剪改为「只保留头部 + 触发即全文落盘」，无门槛；
// 键仅为兼容旧 harness.json 保留解析（见 EffectiveThresholds 注释），不再导出常量。

/** 压缩保留预算：尾部完整轮次保留约 30% 上下文窗口的 token（自动触发/溢出兜底用）。 */
export const COMPACTION_KEEP_RATIO = EFFECTIVE.compactionKeepRatio;

/**
 * 手动压缩（/api/compact）的保留预算（token）：用户主动 /compact 的预期是"立即显著变小"。
 * 取 0 = 不保留尾部轮次，全部历史进摘要（知识由摘要承载，压缩前有 precompact 备份兜底）。
 * 若沿用 KEEP_RATIO × 上下文长度（1M 提供方=30 万 token），切点算法"保留最多"会几乎切不动
 * （实测表现即"压缩后上下文没变"）；即便设 4k，短对话仍会只摘要一条消息、上下文不降反升。
 * 自动触发/溢出兜底仍走 KEEP_RATIO（保留工作集），语义分开。
 */
export const COMPACTION_MANUAL_KEEP_TOKENS = EFFECTIVE.compactionManualKeepTokens;

/** 上下文长度的缺省值（提供方表单缺省、前端占比显示兜底）：随 /api/meta 下发，前端不再硬编码。 */
export const DEFAULT_CONTEXT_LENGTH = EFFECTIVE.defaultContextLength;

/** 子代理（worker）并发上限：并行派发（docs/15：同轮多个 agent_task 调用）超出部分立即报错回传（不排队）。 */
export const SUBAGENT_MAX_CONCURRENT = EFFECTIVE.subagentMaxConcurrent;

/** 每会话子代理累计上限：超出立即报错回传（防大型任务成本失控）。 */
export const SUBAGENT_MAX_TOTAL = EFFECTIVE.subagentMaxTotal;

/** 子代理（worker）工具调用轮次上限：沿用 Agent 的"达上限收尾总结"机制。 */
export const SUBAGENT_MAX_TOOL_ROUNDS = EFFECTIVE.subagentMaxToolRounds;

/** 子代理最终报告字符预算：超出修剪为预算内文本 + spill 全文引用。 */
export const SUBAGENT_RESULT_MAX_CHARS = EFFECTIVE.subagentResultMaxChars;

/** 可复用子代理每实例任务数上限（docs/9）：超出 agent_followup 立即报错回传（防无限追加成本失控）。 */
export const SUBAGENT_MAX_TASKS = EFFECTIVE.subagentMaxTasks;

/** 可复用子代理的 followup 上下文门槛（docs/10 R1，默认 35%）：上次任务收尾时上下文占用
 *  ≥ 该值则 agent_followup 直接拒绝（上下文过长易幻觉；服务端硬闸，不依赖模型自觉）。 */
export const SUBAGENT_FOLLOWUP_CONTEXT_PCT = EFFECTIVE.subagentFollowupContextPct;

/** 子代理上下文过长预警线（docs/10 R1 修订，默认 25%）：任务收尾占用 > 该值时结果文本/
 *  待命提示附「上下文过长」预警（>30 预警、≥35 拒收、>50 强制归档三档的前档）。 */
export const SUBAGENT_WARN_CONTEXT_PCT = EFFECTIVE.subagentWarnContextPct;

/** 可复用子代理的强制归档线（docs/10 R1，默认 50%）：任务完成时上下文占用 > 该值则不转
 *  待命、直接归档（继续驻留只会诱导协调者向高幻觉风险实例追加任务）。 */
export const SUBAGENT_ARCHIVE_CONTEXT_PCT = EFFECTIVE.subagentArchiveContextPct;

/** read_archive 存档渲染字符预算（docs/17，默认 80k）：JSON→可读文本超出截为头部 + 省略标记
 *  （pruneToolResult 同款），防整份多任务存档一次性灌满接收方上下文。 */
export const ARCHIVE_RENDER_MAX_CHARS = EFFECTIVE.archiveRenderMaxChars;

// ---- 阶段 B 第一批（docs/21 §2.3 前 8 键，docs/22 §4.2）：全部经 harness.json thresholds 可覆盖 ----

/** 会话级审批升级额度（默认 8）：沙箱拒绝后带 justification 转人工的累计上限（pwsh.ts 消费）。 */
export const ESCALATION_MAX = EFFECTIVE.escalationMax;

/** 两级 AGENTS.md 注入截断预算（默认 16000 字符；workspace.ts 消费）。 */
export const AGENTS_MD_MAX_CHARS = EFFECTIVE.agentsMdMaxChars;

/** run_pwsh 输出采集软上限（默认 1MB）：超过停止采集防撑爆内存，输出修剪由注册表层统一负责。 */
export const PWSH_CAPTURE_MAX_BYTES = EFFECTIVE.pwshCaptureMaxBytes;

/** precompact 压缩备份保留份数（默认 3）：backupBeforeCompact 环形覆写——写第 n+1 份前删最老。 */
export const PRECOMPACT_KEEP = EFFECTIVE.precompactKeep;

/** spill 目录年龄清扫阈值（默认 168h=7 天）：启动时 sweepStaleSpill 清理超龄会话 spill 目录。 */
export const SPILL_MAX_AGE_HOURS = EFFECTIVE.spillMaxAgeHours;

/** 沙箱 tmp 目录年龄清扫阈值（默认 24h）：启动时 sweepStaleSandboxTmp 传参生效值。 */
export const SANDBOX_TMP_MAX_AGE_HOURS = EFFECTIVE.sandboxTmpMaxAgeHours;

// ---- 跨文件共享的运行常量（docs/21 §2.2/§2.4：单一出处，消重复定义；阶段 B 第二批候选键） ----

/** 子代理任务 timeoutMs 的最小值（agent-task schema/校验/提示词三处共用同一出处；
 *  阶段 B 候选阈值键 subagentTimeoutMinMs） */
export const SUBAGENT_TIMEOUT_MIN_MS = 60_000;

/** MCP stdio 握手超时（默认 20s；transport 与 mcp-manage 提示词共用——文案插值自动跟随覆盖值）。 */
export const MCP_HANDSHAKE_TIMEOUT_MS = EFFECTIVE.mcpHandshakeTimeoutMs;

/** MCP 工具调用缺省超时（默认 60s；manager 不传参时全部 mcp__ 工具生效此值）。 */
export const MCP_CALL_TIMEOUT_MS = EFFECTIVE.mcpCallTimeoutMs;

/** 消息图片规则（docs/10 R3；docs/22 §4.1 四重定义收敛）：≤4 张、单张解码后 ≤5MB、
 *  mime 白名单——后端 parseChatImages 校验与前端校验/按钮 title（经 /api/meta 下发）的
 *  单一出处。mimes 取值须与 ChatImage["mime"] 联合类型一致（web-sessions.test.ts 锁定）。
 *  view_image 工具的磁盘文件规则（≤8MB）是另一套语义，不在此收敛。 */
export const IMAGE_RULES = {
  maxCount: 4,
  maxBytes: 5 * 1024 * 1024,
  mimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

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
