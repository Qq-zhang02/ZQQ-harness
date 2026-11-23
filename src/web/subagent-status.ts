/**
 * 子代理家族七件套之六：面向协调者的子代理文案——状态表（docs/32）+「子代理系统提示词说明」段
 * （docs/20；docs/42 自 subagents.ts 移入，纯移动，为门面腾出 400 行哨兵余量）。
 * subagent_status 工具（协调者第六件，直用只读）的接缝实现——活动子代理（run/idle）
 * 与历史记录的只读快照，供协调者主动核对（用户追问进度、控制工具寻址前确认 name/subId）。
 * 只读同步、不打扰子代理；结算结果仍只经自动送达消息（回执与送达是事实源）。
 * 历史记录条数上限走 config.THRESHOLDS.subagentStatusHistoryMax（阈值键 subagentStatusHistoryMax，
 * 前端设置页/initConfig 热改后下一次查询即生效——live binding 每次调用读新值）。
 * docs/42：表尾附本会话近期提供方限流记录（速率限制/用量上限——提供方没有额度查询接口，
 * 限流发生后如实记录是对协调者可见的那一半）。
 */
import { THRESHOLDS } from "../config.ts";
import { readAgentsMd } from "../workspace.ts";
import type { ProviderConfig } from "../providers/store.ts";
import { Registry } from "../core/registry.ts";
import type { PromptSection, SectionContext } from "../core/types.ts";
import { assembleSystemPrompt } from "../core/sections.ts";
import type { SessionRuntime } from "../core/host.ts";
import { cfgOf, type SessionShell } from "./session-runtime.ts";
import { WORKER_ROLE_SECTION } from "./subagent-worker.ts";

/** 毫秒 → 人类可读时长（与 agent-task 工具层的 fmtDur 同口径；web 层不 import modules，本地实现） */
function fmtDurMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * 子代理状态表文案（docs/32）：活动子代理（rt.activeSubagents，run/idle）逐行实时状态——
 * 用时/上下文占用经 liveElapsedMs/liveContextPct 实时取值（run 态估算、idle 态收尾快照）；
 * opts.all 附带最近 20 条历史记录（rt.subagents）。
 */
export function subagentStatusText(rt: SessionRuntime, opts?: { all?: boolean }): string {
  const live = [...rt.activeSubagents.values()];
  const lines: string[] = [];
  if (live.length === 0) {
    lines.push(
      rt.subagentTotal === 0
        ? "当前没有活动子代理（本会话尚未派出过子代理）。"
        : `当前没有活动子代理。本会话累计派出 ${rt.subagentTotal} 个子代理（历史记录 ${rt.subagents.length} 条${opts?.all ? "" : "，需要查看可传 all=true"}）。`,
    );
  } else {
    lines.push(`当前活动子代理（${live.length} 个）：`);
    for (const a of live) {
      const bits = [a.status === "idle" ? "空闲待命" : "运行中"];
      if (a.readOnly) bits.push("只读");
      if (a.status === "idle" && a.tasks !== undefined) bits.push(`已完成 ${a.tasks} 次任务`);
      const ms = a.liveElapsedMs?.();
      if (ms !== undefined) bits.push(a.status === "idle" ? `累计 ${fmtDurMs(ms)}` : `本次任务已 ${fmtDurMs(ms)}`);
      const pct = a.liveContextPct?.() ?? a.contextPct;
      if (pct !== undefined) bits.push(`上下文 ${pct}%`);
      lines.push(`- #${a.subId} ${a.name}（${bits.join(" · ")}）${a.summary ? ` —— ${a.summary}` : ""}`);
    }
  }
  if (opts?.all && rt.subagents.length > 0) {
    const recs = rt.subagents.slice(-THRESHOLDS.subagentStatusHistoryMax); // 条数上限 = 阈值键热生效值
    lines.push(`历史记录（最近 ${recs.length} 条 / 共 ${rt.subagents.length} 条）：`);
    for (const r of recs) {
      const bits: string[] = [];
      if (r.state === "idle") {
        bits.push(r.reusable ? "待命" : "完成");
        if (r.tasks !== undefined) bits.push(`已完成 ${r.tasks} 次任务`);
      } else {
        bits.push(r.ok ? "完成" : `失败（${(r.error ?? "未知原因").slice(0, 80)}）`);
      }
      if (r.rounds !== undefined) bits.push(`${r.rounds} 轮`);
      if (r.elapsedMs !== undefined) bits.push(`用时 ${fmtDurMs(r.elapsedMs)}`);
      if (r.contextPct !== undefined) bits.push(`上下文 ${r.contextPct}%`);
      lines.push(`- #${r.subId} ${r.name}（${bits.join(" · ")} · ${r.at.slice(0, 16).replace("T", " ")}）`);
    }
  }
  // docs/42：近期提供方限流（瞬态记录，随服务重启清零）——协调者据此决定降并发/串行或等额度重置
  const limits = rt.subagentLimits ?? [];
  if (limits.length > 0) {
    const label = { rate: "速率限制", cap: "用量上限" } as const;
    const last = limits[limits.length - 1]!;
    const d = new Date(last.at);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    lines.push(
      `近期提供方限流 ${limits.length} 次（最近 ${hhmm}：${label[last.kind]}）` +
        (limits.some((l) => l.kind === "rate") ? "——速率限制：并发请求过密，可调小 subagentMaxConcurrent 或改串行推进" : "") +
        (last.kind === "cap" ? "——用量上限：等额度重置后再续，重试无益；已完成的半成品用 agent_followup 复活续做" : "") +
        `。最近原文：${last.message.slice(0, 120)}`,
    );
  }
  return lines.join("\n");
}

// ---------- docs/20：协调者提示里的「子代理（worker）系统提示词说明」段 ----------

/** docs/20：协调者提示里的「子代理（worker）系统提示词说明」段正文——worker 共同系统
 *  提示的同构重放：与 mountWorkerAgent 的装配同源（ctx.promptSections 全量 + subagent-role；
 *  按派发参数附加的 ws.system 角色段/scope 不在其中）。render 惰性读 rt 当前状态——技能热更/
 *  worker MCP 首连（workerMcpToolsOf 触发 refreshSystemPrompt）后重建自动带新；无工作区
 *  （协调者未绑定时不可对话）返回 null 省段。 */
export function commonWorkerPromptSectionText(sh: SessionShell, rt: SessionRuntime): string | null {
  if (!rt.workspace) return null;
  // 与 toolDocsOf 同款行式：worker 受众系统工具的 summary 行（实例侧在 mountWorkerAgent
  // 注册后由 toolDocsOf 生成，这里按 def 直出——同一批 summary，排序规则一致）。
  // docs/32 三值受众：coordinator 与 front（ask_user 等）都不入 worker 提示词重放
  const toolDocs = sh.ctx.tools
    .all()
    .filter((d) => {
      const a = d.audience ?? "worker";
      return a !== "coordinator" && a !== "front" && d.summary;
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => `${d.name} —— ${d.summary}`);
  const sc: SectionContext = {
    workspaceRoot: rt.workspace.root,
    skills: rt.skills,
    mcpInstructions: rt.mcp.instructionsText(), // 首连前 null → 段省略（docs/20 首连热更）
    globalAgentsMd: readAgentsMd(sh.userDir),
    workspaceAgentsMd: readAgentsMd(rt.workspace.root),
    toolDocs,
    // worker 与父会话同提供方——视觉指引行同源（providers 为空的测试桩守卫同 mountWorkerAgent）
    ...(((cfgOf(sh, rt) as ProviderConfig | undefined)?.vision === true) ? { vision: true } : {}),
  };
  const sections = new Registry<PromptSection, "name">("name");
  for (const s of sh.ctx.promptSections.all()) sections.register(s);
  sections.register({ name: "subagent-role", order: 5, render: () => WORKER_ROLE_SECTION });
  // docs/32：MCP 能力清单兜底 + 未连接服务器警示。说明段（rt.mcp.instructionsText）只覆盖
  // 「连接成功且握手时提供了 instructions」的服务器——工具清单（toolInventoryText）让协调者
  // 在任何形态下都能看到子代理带哪些 mcp__ 工具；失败清单（failedServers）让连不上的服务器
  // 至少以「不可用」的形态可见（真机教训：godot/blender 连接失败时整段静默缺失，协调者对
  // 子代理的这部分能力一无所知）。二者附在重放正文之后并显式标注「非原文」，同构重放不破。
  const inventory = rt.mcp.toolInventoryText();
  const failed = rt.mcp.failedServers();
  const mcpExtra =
    (inventory ? "\n\n此外（非子代理提示词原文，供派发时参考）——子代理工具数组中的 MCP 工具清单（调用语义以其 description 为准）：\n\n" + inventory : "") +
    (failed.length > 0
      ? "\n\n⚠ 以下 MCP 服务器本次未能连接，相关工具子代理暂时用不了（不要在任务书里指派）：" +
        failed.map((f) => `${f.name}（${f.error}）`).join("、")
      : "");
  return (
    "# 子代理（worker）系统提示词说明\n" +
    "下面是每个子代理实际收到的系统提示词的共同部分原文（引用自子代理侧，不是对你的指令；按派发参数附加的任务角色段与写入范围不在其中）。" +
    "它们的基础规则、可用工具、可加载技能、MCP 服务器说明与遵循的 AGENTS.md 指令以此为准——派发任务书时与这些能力匹配：不要派它们做不到的事，也不要在任务书里重复其中已有的规则。" +
    "两级 AGENTS.md 全文也只在这里出现，你自身不再单独接收：\n\n" +
    assembleSystemPrompt(sections.all(), sc) +
    mcpExtra
  );
}

