/**
 * agent_task 工具实现（docs/5 §3.3）：协调者派 worker 的唯一通道。任务项 schema、
 * 参数校验与结果格式化；worker 运行机制在 web/subagents.ts（经 SystemToolDeps.subagent
 * 服务接缝，模块零 import 壳）。docs/9：任务项增 reusable（可复用子代理——任务完成后
 * 驻留待命），另注册 agent_followup（追加任务）与 archive_subagent（归档）；docs/18：
 * 暂停/恢复退役，stop_subagent（打断即终结）取代 pause/resume 两件。
 */
import type { Tool } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { SubagentRequest, SubagentResult } from "../../../core/types.ts";
import { normalizeEffort } from "../../../providers/store.ts";
// docs/21 §2.2-③：timeoutMs 下限单一出处（schema/校验/提示词三处曾各自写死 60000）
import { SUBAGENT_TIMEOUT_MIN_MS } from "../../../config.ts";
import { AUTO_DELIVERY_PREFIXES } from "../../../core/events.ts";

/** 单个任务项的参数 schema（agent_task 平铺；agent_tasks 包一层 tasks 数组）。 */
export const TASK_ITEM_PROPERTIES: Record<string, unknown> = {
  name: { type: "string", description: "可选，子任务短名（ASCII，如 impl-auth；用于审批卡与报告标注）" },
  description: { type: "string", description: "一句话任务摘要（必填，审批卡与事件展示用）" },
  task: {
    type: "string",
    description: "完整任务书（必填，自包含——子代理看不到本对话历史）：目标、背景与约束、涉及路径、期望产出（文件落点 + 报告结构）",
  },
  scope: { type: "array", items: { type: "string" }, description: "可选，允许写入的相对路径前缀（缺省整个工作区）" },
  effort: { type: "string", enum: ["off", "low", "high", "max", "default"], description: "可选，思考档位（缺省继承本会话当前档位）" },
  timeoutMs: { type: "integer", minimum: SUBAGENT_TIMEOUT_MIN_MS, description: `可选，超时毫秒数（最小 ${SUBAGENT_TIMEOUT_MIN_MS}；缺省不限时）` },
  reusable: {
    type: "boolean",
    description:
      "可选，可复用子代理（docs/9）：任务完成后保留待命（完整上下文延续），后续用 agent_followup 按 name/subId 追加任务、不再使用时 archive_subagent 归档。" +
      "同一专业方向要跨多次任务延续时才用；缺省 false=一次性（用完即自动归档）。",
  },
};

/** 解析并校验一个任务项；非法返回错误文案（字符串），合法返回请求字段。 */
export function parseTaskItem(args: Record<string, unknown>): { error: string } | SubagentRequest {
  const description = String(args.description ?? "").trim();
  if (!description) return { error: "错误：description 不能为空——用一句话概括这个子任务（审批卡与结果标注用）。" };
  const task = String(args.task ?? "").trim();
  if (!task) return { error: "错误：task 不能为空——任务书必须自包含（子代理看不到本对话历史）。" };
  const req: SubagentRequest = { task, description };
  const name = String(args.name ?? "").trim();
  if (name) {
    if (name.length > 64) return { error: "错误：name 过长（≤64 字符）——它只用作短名标注。" };
    req.name = name;
  }
  if (args.scope !== undefined) {
    if (!Array.isArray(args.scope) || args.scope.length === 0 || args.scope.some((s) => typeof s !== "string" || !String(s).trim())) {
      return { error: "错误：scope 必须是非空的相对路径前缀数组（如 [\"src/auth\"]）；不需要限制就省略该参数。" };
    }
    req.scope = (args.scope as unknown[]).map((s) => String(s).trim());
  }
  if (args.effort !== undefined && args.effort !== null && args.effort !== "") {
    const effort = normalizeEffort(args.effort);
    if (!effort) return { error: "错误：effort 只能是 off/low/high/max/default 之一。" };
    req.effort = effort;
  }
  if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
    const n = Number(args.timeoutMs);
    if (!Number.isFinite(n) || n < SUBAGENT_TIMEOUT_MIN_MS) return { error: `错误：timeoutMs 必须 ≥${SUBAGENT_TIMEOUT_MIN_MS} 毫秒。` };
    req.timeoutMs = Math.floor(n);
  }
  if (args.reusable !== undefined && args.reusable !== null && args.reusable !== false) {
    if (args.reusable !== true) return { error: "错误：reusable 只能是布尔值（true=可复用；缺省 false=一次性）。" };
    req.reusable = true;
  }
  return req;
}

/** 用量数字 → 12.3k 风格。 */
function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** 毫秒 → 人类可读时长（<1m 只显秒；<1h 分秒；≥1h 时分）。 */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** 过程档案入口标记（docs/6 P3 方案 A）：前端把该标记渲染成可点的「📄 过程」链接
 *  （随工具结果入历史，刷新/重放后仍在；文件在 spill 盘上）。对模型只是一行存档说明。 */
function transcriptTag(r: SubagentResult): string {
  return r.transcript !== undefined && r.subId !== undefined ? `\n[[过程档案#${r.subId}]]` : "";
}

/** 工具结果统一格式（docs/5 §3.3；docs/16 起作为自动送达报告的正文——不再直接作为工具
 *  结果，格式约定与历史保持一致）。docs/9：可复用结果追加待命提示（报告文本是协调者感知
 *  子代理存活状态的唯一事实源——SSE 事件不进协调者历史）；stats 前插「第 N 次任务」（N≥2）。
 *  行首格式 `[子代理 X 完成/失败]` 保持不变（前端批次统计正则依赖）。
 *  docs/10 R1（修订三档）：stats 带「上下文 X%」；待命提示按占用分四态——≤ 预警线正常
 *  待命、> 预警线（默认 25%）附「上下文过长」预警（仍可追加）、≥ 拒收线（默认 35%）警告
 *  会被拒、被强制归档（> 归档线，默认 50%）时整段替换为归档说明。
 *  docs/11 W1：archived:"request" → 归档请求中止的收尾说明（不再误报「已保留待命」）。 */
export function formatWorkerResult(r: SubagentResult, name: string, thresholds?: { warnPct?: number; followupPct: number }): string {
  const usage = r.usage;
  const stats = [
    r.taskNo !== undefined && r.taskNo > 1 ? `第 ${r.taskNo} 次任务` : null,
    r.rounds !== undefined ? `${r.rounds} 轮` : null,
    r.elapsedMs !== undefined ? `用时 ${fmtDur(r.elapsedMs)}` : null,
    usage ? `输入 ${k(usage.prompt)} / 输出 ${k(usage.completion)} tokens` : null,
    r.contextPct !== undefined ? `上下文 ${r.contextPct}%` : null,
  ].filter(Boolean);
  const followupPct = thresholds?.followupPct ?? 35;
  const warnPct = thresholds?.warnPct ?? 25;
  let standby = "";
  if (r.reusable && r.subId !== undefined) {
    const readArchiveHint = `任务书可让它先用 read_archive（subId=${r.subId}）读过程存档接续上下文 [[过程档案#${r.subId}]]`;
    if (r.archived === "request") {
      standby =
        `\n（该子代理已按归档请求归档（当前任务被中止）——不可再用 agent_followup 追加任务。` +
        `需要继续该方向的工作时用 agent_task 重新派发${r.transcript !== undefined ? `，${readArchiveHint}` : ""}。）`;
    } else if (r.forceArchived || r.archived === "context") {
      standby =
        `\n（该子代理的上下文占用已达 ${r.contextPct ?? "?"}%（超过上限，易因上下文过长产生幻觉），已自动归档——不可再用 agent_followup 追加任务。` +
        `需要继续工作时用 agent_task 重新派发，${readArchiveHint}。）`;
    } else if (r.contextPct !== undefined && r.contextPct >= followupPct) {
      standby =
        `\n（该子代理可复用：${name}#${r.subId} 已保留待命，但其上下文占用 ${r.contextPct}% 已达追加上限（${followupPct}%）——agent_followup 将被拒绝；` +
        `需要继续工作时用 archive_subagent 归档后 agent_task 重新派发（${readArchiveHint}）。）`;
    } else if (r.contextPct !== undefined && r.contextPct > warnPct) {
      standby =
        `\n（该子代理可复用：${name}#${r.subId} 已保留待命，后续任务用 agent_followup 按 name/subId 追加。` +
        `⚠ 上下文过长预警：其上下文占用 ${r.contextPct}% 已超过 ${warnPct}%——上下文过长的子代理继续任务容易产生幻觉，建议尽快用 archive_subagent 归档并 agent_task 重新派发（新${readArchiveHint}）；达到 ${followupPct}% 后追加将被拒绝。）`;
    } else {
      standby = `\n（该子代理可复用：${name}#${r.subId} 已保留待命，后续任务用 agent_followup 按 name/subId 追加；不再使用时用 archive_subagent 归档。）`;
    }
  }
  if (r.ok) {
    const head = stats.length > 0 ? `[子代理 ${name} 完成] ${stats.join(" · ")}` : `[子代理 ${name} 完成]`;
    return `${head}\n---\n${r.text}${transcriptTag(r)}${standby}`;
  }
  const why = r.error ?? "未知原因";
  const tail = stats.length > 0 ? `[子代理 ${name} 失败] ${why}（${stats.join(" · ")}）` : `[子代理 ${name} 失败] ${why}`;
  return tail + transcriptTag(r) + standby;
}

/** 派发受理回执（docs/16）：agent_task/agent_followup 的返回文本——派发即返回、不等待；
 *  指引「报告自动送达后再处理」，防协调者在本轮编造或提前汇总尚未完成的结果。 */
export function dispatchAck(name: string, subId: number, reusable: boolean): string {
  return (
    `[子代理 ${name}#${subId} 已派发] 任务已在后台启动；本调用立即返回、不等待其完成。` +
    `它结算（完成/失败/打断/归档）后，报告会以「${AUTO_DELIVERY_PREFIXES.report}」开头的消息自动送达本会话，收到后再处理。` +
    `本轮可直接向用户说明派发情况；全部报告到齐前不要编造或提前汇总结果。` +
    (reusable ? `\n（可复用子代理：任务完成后驻留待命，后续用 agent_followup 按 name=${name} 或 subId=${subId} 追加任务。）` : "")
  );
}

/** agent_task：非阻塞派发（SA1；docs/16）。reusable=true 派出可复用子代理（docs/9）。
 *  docs/15：agent_tasks 批量工具退役——并行派发 = 同一轮里发多个 agent_task 调用
 *  （协调者工具循环对同轮多调用并行执行）；并发上限由服务侧同步段裁决（超发立即报错不排队）。 */
export function createAgentTaskTool(deps: SystemToolDeps): Tool {
  return {
    name: "agent_task",
    description:
      "派出一个子代理独立完成一项任务，立即返回派发回执（非阻塞——本调用不等待其完成）。子代理拥有完整工具（run_pwsh/文件读写等），" +
      "但看不到本对话历史——任务书必须自包含：写清目标、背景约束、涉及路径、期望产出（产出文件落点 + 报告结构）。" +
      "互不依赖、写入范围不重叠的任务，在同一轮里发多个 agent_task 调用即可并行派出（超出并发上限的调用立即报错回执、不排队）。" +
      "任务结算（完成/失败/打断/归档）后，其报告会以「" + AUTO_DELIVERY_PREFIXES.report + "」开头的消息按完成顺序自动送达本会话，到齐后再汇总交付。" +
      "同一专业方向要跨多次任务延续时给 reusable=true" +
      "（它完成后保留全部上下文待命，后续 agent_followup 追加任务、archive_subagent 归档；缺省一次性用完即归档）。",
    parameters: { type: "object", properties: TASK_ITEM_PROPERTIES, required: ["description", "task"] },
    async execute(args, ctx) {
      const svc = deps.subagent;
      if (!svc) return "错误：子代理服务不可用（本会话不是协调者会话）。";
      const parsed = parseTaskItem(args);
      if ("error" in parsed) return parsed.error;
      const r = svc.dispatch(parsed, ctx.signal);
      if (!r.ok) return r.error;
      return dispatchAck(r.name, r.subId, parsed.reusable === true);
    },
  };
}

/**
 * stop_subagent（W2-S；docs/18 起暂停/恢复机制退役，打断即终结）：协调者主动打断运行中
 * 的 worker——立即中止进行中的 LLM 请求与工具执行（pwsh 进程随信号终止，已完成的进度
 * 保留在历史、半截内容作废）。一次性子代理随即归档；可复用子代理转空闲待命（保留全部
 * 上下文），继续该方向的工作只能用 agent_followup 发新任务书——没有「恢复」，被打断的
 * 任务不会自动续跑。按 name（派发时协调者自己指定的名字）或 subId（SSE 事件/报告标注的
 * #N）匹配。
 */
export function createStopSubagentTool(deps: SystemToolDeps): Tool {
  return {
    name: "stop_subagent",
    description:
      "打断一个正在运行的子代理的当前任务：立即中止它进行中的 LLM 请求与工具执行（pwsh 进程终止；已完成的进度保留，半截内容作废）。" +
      "一次性子代理随之归档；可复用子代理转为空闲待命（保留已有上下文）——继续该方向的工作用 agent_followup 发新任务书（没有恢复机制，被打断的任务不会自动续跑）。" +
      "用户要求停止某个子代理、或某子代理方向明显跑偏要立即止损时使用。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "子代理短名（派发时指定的 name；同名者全部生效）" },
        subId: { type: "integer", description: "可选，子代理序号（SSE 事件/报告标注里的 #N）；与 name 同给时以 subId 为准" },
      },
    },
    async execute(args) {
      if (!deps.subagentControl) return "错误：子代理控制不可用（本会话不是协调者会话）。";
      const name = args.name === undefined || args.name === null ? undefined : String(args.name).trim();
      const subId = args.subId === undefined || args.subId === null ? undefined : Number(args.subId);
      if (!name && subId === undefined) return "错误：需要 name 或 subId 之一来指定子代理。";
      if (subId !== undefined && (!Number.isInteger(subId) || subId < 1)) return "错误：subId 必须是正整数。";
      const target = subId !== undefined ? { subId, ...(name ? { name } : {}) } : { name: name! };
      return deps.subagentControl(target, "stop");
    },
  };
}

/**
 * agent_followup（docs/9）：向空闲待命的可复用子代理追加任务。它保留此前全部任务的
 * 历史上下文（记得自己读过/写过什么）——任务书不必自包含，可引用之前的进展；新目标与
 * 期望产出仍要写清。只接受空闲待命的可复用子代理；已归档/一次性子代理不可追加（改用
 * agent_task 重新派发）。scope/effort 等沿用首次派发。docs/16：非阻塞派发——立即返回
 * 受理回执，任务结算后的报告自动送达本会话。
 */
export function createAgentFollowupTool(deps: SystemToolDeps): Tool {
  return {
    name: "agent_followup",
    description:
      "向一个空闲待命的可复用子代理（agent_task 带 reusable=true 派出的）追加新任务，立即返回派发回执（非阻塞——本调用不等待其完成）。" +
      "它保留之前全部任务的历史上下文——任务书可引用之前的进展（如「继续上次的重构，接着处理 X」），但新目标与期望产出要写清。" +
      "只接受空闲待命状态；已归档或一次性子代理不可追加，请改用 agent_task。任务结算（完成/失败/打断/归档）后，" +
      "其报告会以「" + AUTO_DELIVERY_PREFIXES.report + "」开头的消息自动送达本会话。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "可复用子代理短名（首次派发时指定的 name；与 subId 同给以 subId 为准；同名多个时必须用 subId）" },
        subId: { type: "integer", description: "可复用子代理序号（SSE 事件/报告标注里的 #N）" },
        description: { type: "string", description: "一句话任务摘要（事件与抽屉展示用，建议填）" },
        task: { type: "string", description: "新任务书：目标与期望产出（可引用该子代理的既有上下文——它记得之前的任务）" },
        timeoutMs: { type: "integer", minimum: SUBAGENT_TIMEOUT_MIN_MS, description: `可选，本任务的超时毫秒数（最小 ${SUBAGENT_TIMEOUT_MIN_MS}；缺省不限时；scope/effort 沿用首次派发）` },
      },
      required: ["task"],
    },
    async execute(args, ctx) {
      const svc = deps.subagent;
      if (!svc) return "错误：子代理服务不可用（本会话不是协调者会话）。";
      const name = args.name === undefined || args.name === null ? undefined : String(args.name).trim();
      const subId = args.subId === undefined || args.subId === null ? undefined : Number(args.subId);
      if (!name && subId === undefined) return "错误：需要 name 或 subId 之一来指定可复用子代理。";
      if (subId !== undefined && (!Number.isInteger(subId) || subId < 1)) return "错误：subId 必须是正整数。";
      const task = String(args.task ?? "").trim();
      if (!task) return "错误：task 不能为空——写清新任务的目标与期望产出。";
      let timeoutMs: number | undefined;
      if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
        const n = Number(args.timeoutMs);
        if (!Number.isFinite(n) || n < SUBAGENT_TIMEOUT_MIN_MS) return `错误：timeoutMs 必须 ≥${SUBAGENT_TIMEOUT_MIN_MS} 毫秒。`;
        timeoutMs = Math.floor(n);
      }
      const description = args.description === undefined || args.description === null ? undefined : String(args.description).trim() || undefined;
      const target = subId !== undefined ? { subId, ...(name ? { name } : {}) } : { name: name! };
      const r = svc.followup(target, { task, ...(description ? { description } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, ctx.signal);
      if (!r.ok) return r.error;
      return dispatchAck(r.name, r.subId, true);
    },
  };
}

/**
 * subagent_status（docs/32）：查看当前子代理状态表——活动子代理（运行中/空闲待命）的
 * 实时状态（subId/name/用时/上下文占用/任务摘要）与可选的历史记录摘要。只读快照、立即返回，
 * 不打扰子代理也不等待任务；送达消息仍是结算结果的唯一来源，本工具用于主动核对
 * （用户追问进度、控制工具寻址前确认 name/subId）。
 */
export function createSubagentStatusTool(deps: SystemToolDeps): Tool {
  return {
    name: "subagent_status",
    description:
      "查看当前子代理状态表：活动子代理（运行中/空闲待命）的 subId/name/实时用时/上下文占用/任务摘要，all=true 可附带最近 20 条历史记录摘要。" +
      "只读快照、立即返回，不打扰子代理也不等待任务完成。用户追问进度、或调用控制工具前核对 name/subId 时使用。" +
      "注意：任务的最终结果仍以「" + AUTO_DELIVERY_PREFIXES.report + "」送达消息为准，本工具不能代替报告。",
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "可选，附带历史记录摘要（最近 20 条已结算/待命记录）；缺省只看当前活动子代理" },
      },
    },
    async execute(args) {
      if (!deps.subagentStatus) return "错误：子代理状态查询不可用（本会话不是协调者会话）。";
      return deps.subagentStatus(args.all === true ? { all: true } : {});
    },
  };
}

/** archive_subagent（docs/9）：归档可复用子代理——空闲待命且确定不再使用时调用；执行中
 *  归档会中止其当前任务。归档后仅可查看过程存档，不可再派任务。一次性子代理无需归档。 */
export function createArchiveSubagentTool(deps: SystemToolDeps): Tool {
  return {
    name: "archive_subagent",
    description:
      "归档一个可复用子代理：归档后仅可查看其过程存档，不可再用 agent_followup 派任务。它空闲待命且确定不再使用时调用；" +
      "若它正在执行任务，归档会先中止其当前任务（立即终止也可用 stop_subagent 打断——它转空闲待命不归档）。一次性子代理任务结束即自动归档，无需（也不支持）本工具。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "可复用子代理短名（首次派发时指定的 name；同名者全部生效）" },
        subId: { type: "integer", description: "可复用子代理序号（SSE 事件/报告标注里的 #N）；与 name 同给时以 subId 为准" },
      },
    },
    async execute(args) {
      if (!deps.subagentControl) return "错误：子代理控制不可用（本会话不是协调者会话）。";
      const name = args.name === undefined || args.name === null ? undefined : String(args.name).trim();
      const subId = args.subId === undefined || args.subId === null ? undefined : Number(args.subId);
      if (!name && subId === undefined) return "错误：需要 name 或 subId 之一来指定可复用子代理。";
      if (subId !== undefined && (!Number.isInteger(subId) || subId < 1)) return "错误：subId 必须是正整数。";
      const target = subId !== undefined ? { subId, ...(name ? { name } : {}) } : { name: name! };
      return deps.subagentControl(target, "archive");
    },
  };
}
