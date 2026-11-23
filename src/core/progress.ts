/**
 * 过程历史的纯分析（docs/42）：对一段 ChatMessage[] 提取「做到哪了」的结构化事实——子代理家族
 * （失败报告的残局速览、唤醒简报）与 read_archive 摘要版、agent_task 的限流建议共用同一口径，
 * 故下沉 core（模块之间禁止互采；web 与 modules/tools 都只依赖 core）。
 * 全部是纯函数：不读盘、不认识会话/工作区——磁盘变动扫描在 web/subagent-brief.ts。
 */
import type { ChatMessage, ToolCallRequest } from "../llm/provider.ts";

/** 一次工具调用及其结果（按 toolCallId 配对）。结果缺失 = 调用发出后尚未回填（被中断）。 */
export interface ToolEvent {
  call: ToolCallRequest;
  result?: string;
}

/** 宽容解析调用参数（arguments 是原始 JSON 串，损坏/非对象返回空对象）。 */
export function callArgs(c: ToolCallRequest): Record<string, unknown> {
  try {
    const a = JSON.parse(c.arguments) as unknown;
    return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 历史里的全部工具调用（发起顺序）与各自的结果。 */
export function toolEventsOf(messages: readonly ChatMessage[]): ToolEvent[] {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.toolCallId, m.content);
  const out: ToolEvent[] = [];
  for (const m of messages) if (m.role === "assistant") for (const call of m.toolCalls ?? []) out.push({ call, ...(results.has(call.id) ? { result: results.get(call.id) } : {}) });
  return out;
}

/**
 * 工具调用是否成功——按各工具的成功回执判定：run_pwsh 看 `exit code: 0`（超时/被杀/非零都算
 * 失败）；其余工具失败回执一律以「错误」开头（注册表兜底的「工具执行出错」同算），且必须已有
 * 结果（调用发出后被中断 = 未完成）。
 */
export function toolOk(e: ToolEvent): boolean {
  if (e.result === undefined) return false;
  if (e.call.name === "run_pwsh") return /^exit code: 0(?!\d)/.test(e.result);
  return !/^(错误|工具执行出错)/.test(e.result);
}

/** 单行截断（压掉换行与多余空白；超长截断并标记）。 */
export function clipLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 工具调用的一行摘要：路径类工具报真实 path，run_pwsh 报命令首段；拿不到就只报工具名。
 * 绝不回退到「第一个字符串参数」——那会把 write_file/edit_file 的 content/new_string 源码
 * 当成路径混进「写入文件」清单（真机实录：摘要里出现 `with open(c.TAB / "tab_R1_4_…`）。
 */
export function toolCallLine(e: ToolEvent): string {
  const a = callArgs(e.call);
  const path = typeof a.path === "string" ? a.path.trim() : "";
  if (path) return `${e.call.name} ${path}`;
  const command = typeof a.command === "string" ? a.command.trim() : "";
  if (command) return `${e.call.name} ${clipLine(command, 80)}`;
  return e.call.name;
}

/** run_pwsh 失败的归因短句（取结果首行：超时 / exit N / 启动失败）。 */
function pwshFailWhy(result: string): string {
  if (result.includes("超时被终止")) return "超时";
  if (result.includes("被用户中断")) return "被中断";
  const m = /^exit code: (\S+)/.exec(result);
  return m ? `exit ${m[1]}` : clipLine(result, 40);
}

/** 「做到哪了」的结构化事实。 */
export interface ProgressFacts {
  /** 已回填结果的工具调用数 */
  done: number;
  /** 发起的调用总数 */
  calls: number;
  /** 成功写入（write_file/edit_file）的路径，按首次出现去重 */
  written: string[];
  /** 成功读取（read_file）的路径，按首次出现去重 */
  read: string[];
  /** 已查看的图片（read_image 成功）路径，按首次出现去重 */
  images: string[];
  /** 最后一次成功的 run_pwsh 命令（单行截断） */
  lastOkCommand?: string;
  /** 最近 3 个调用的一行摘要（含成败标记） */
  recent: string[];
  /** 最后一条有正文的助手消息 */
  lastText?: string;
}

const pushOnce = (list: string[], v: string): void => {
  if (v && !list.includes(v)) list.push(v);
};

export function progressFactsOf(messages: readonly ChatMessage[]): ProgressFacts {
  const events = toolEventsOf(messages);
  const facts: ProgressFacts = { done: 0, calls: events.length, written: [], read: [], images: [], recent: [] };
  for (const e of events) {
    if (e.result === undefined) continue;
    facts.done++;
    const a = callArgs(e.call);
    const path = typeof a.path === "string" ? a.path.trim() : "";
    if (toolOk(e)) {
      if ((e.call.name === "write_file" || e.call.name === "edit_file") && path) pushOnce(facts.written, path);
      else if (e.call.name === "read_file" && path) pushOnce(facts.read, path);
      else if (e.call.name === "read_image" && path) pushOnce(facts.images, path);
      else if (e.call.name === "run_pwsh" && typeof a.command === "string" && a.command.trim()) facts.lastOkCommand = clipLine(a.command, 100);
    }
  }
  facts.recent = events.slice(-3).map(toolEventLine);
  const lastText = [...messages].reverse().find((m): m is Extract<ChatMessage, { role: "assistant" }> => m.role === "assistant" && !!(m.content ?? "").trim())?.content?.trim();
  if (lastText) facts.lastText = lastText;
  return facts;
}

/** 一次调用的一行摘要 + 状态标记：未回填 / 失败（run_pwsh 给出超时、exit N 等归因）。 */
export function toolEventLine(e: ToolEvent): string {
  const line = toolCallLine(e);
  if (e.result === undefined) return `${line}（未完成——调用发出后被中断）`;
  return toolOk(e) ? line : `${line}（${e.call.name === "run_pwsh" ? pwshFailWhy(e.result) : "失败"}）`;
}

/**
 * 残局速览（docs/41 起；docs/42 修正口径）：从历史提取「做到哪」——已完成调用统计 / 真实写入
 * 文件 / 最后成功的命令 / 最近动作（带成败）/ 最后一条助手文本（截 600 字）。历史里除任务书外
 * 没有任何实际进展（如超时发生在首轮 LLM 调用中）返回 undefined——不造假速览。
 */
export function progressDigestOf(messages: readonly ChatMessage[]): string | undefined {
  const f = progressFactsOf(messages);
  if (f.done === 0 && f.calls === 0 && !f.lastText) return undefined;
  const lines: string[] = [];
  lines.push(
    `已完成 ${f.done} 个工具调用${f.calls > f.done ? `（发起 ${f.calls} 个，${f.calls - f.done} 个未回填）` : f.calls > 0 ? `（发起 ${f.calls} 个）` : ""}` +
      `${f.written.length > 0 ? `；经文件工具写入 ${f.written.length} 个：${f.written.slice(0, 8).join("、")}${f.written.length > 8 ? ` 等 ${f.written.length} 个` : ""}` : "；未经文件工具写入"}` +
      (f.images.length > 0 ? `；已查看图片 ${f.images.length} 张` : "") + "。",
  );
  if (f.lastOkCommand) lines.push(`最后成功的命令：${f.lastOkCommand}`);
  if (f.recent.length > 0) lines.push("最近动作：" + f.recent.map((r) => `\n- ${r}`).join(""));
  if (f.lastText) lines.push(`最后进展：${f.lastText.length > 600 ? `${f.lastText.slice(0, 600)}…（截断）` : f.lastText}`);
  return lines.join("\n");
}

// ---------- 提供方限流识别（docs/42） ----------

/** 提供方限流的两类：rate=速率限制（并发/频率过高，降并发或稍后重试）；cap=用量上限（周期额度
 *  用尽，须等重置——与余额不足同归此类：都不是「再试一次」能解决的）。 */
export type ProviderLimitKind = "rate" | "cap";

/**
 * 从错误文案识别提供方限流（docs/42）。提供方没有额度查询接口，「事前知道余额」做不到——
 * 限流发生后如实归类并给出对应建议，是能做的那一半。速率类特征优先于额度类（两家文案都带
 * 「上限/限制」字样时，速率限制有更具体的特征词）。认不出返回 undefined（不臆测）。
 */
export function providerLimitOf(error: string | undefined): ProviderLimitKind | undefined {
  if (!error) return undefined;
  if (/rate[\s_-]?limit|速率限制|频率限制|请求过于频繁|too many requests|\b429\b|requests?\s*(?:per|\/)\s*(?:second|minute|day)|\brpm\b|\btpm\b/i.test(error)) return "rate";
  if (/使用上限|用量上限|额度上限|限额|额度不足|余额不足|quota|exceed|insufficient|usage cap|上限/i.test(error)) return "cap";
  return undefined;
}
