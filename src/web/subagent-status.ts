/**
 * 子代理家族六件套之六：子代理状态表文案（docs/32 自 subagents.ts 拆出）。
 * subagent_status 工具（协调者第六件，直用只读）的接缝实现——活动子代理（run/idle）
 * 与历史记录的只读快照，供协调者主动核对（用户追问进度、控制工具寻址前确认 name/subId）。
 * 只读同步、不打扰子代理；结算结果仍只经自动送达消息（回执与送达是事实源）。
 * 历史记录条数上限走 config.SUBAGENT_STATUS_HISTORY_MAX（阈值键 subagentStatusHistoryMax，
 * 前端设置页/initConfig 热改后下一次查询即生效——live binding 每次调用读新值）。
 */
import { SUBAGENT_STATUS_HISTORY_MAX } from "../config.ts";
import type { SessionRuntime } from "../core/host.ts";

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
      if (a.status === "idle" && a.tasks !== undefined) bits.push(`已完成 ${a.tasks} 次任务`);
      const ms = a.liveElapsedMs?.();
      if (ms !== undefined) bits.push(a.status === "idle" ? `累计 ${fmtDurMs(ms)}` : `本次任务已 ${fmtDurMs(ms)}`);
      const pct = a.liveContextPct?.() ?? a.contextPct;
      if (pct !== undefined) bits.push(`上下文 ${pct}%`);
      lines.push(`- #${a.subId} ${a.name}（${bits.join(" · ")}）${a.summary ? ` —— ${a.summary}` : ""}`);
    }
  }
  if (opts?.all && rt.subagents.length > 0) {
    const recs = rt.subagents.slice(-SUBAGENT_STATUS_HISTORY_MAX); // 条数上限 = 阈值键热生效值
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
  return lines.join("\n");
}
