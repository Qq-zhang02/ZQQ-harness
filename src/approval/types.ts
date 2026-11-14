/**
 * 审批决策词汇表（封闭集合）与审计事件类型。
 * 设计原则：
 * - fail-closed：应答野值/缺失/异常一律归一化为 unavailable（按拒绝处理）；
 * - 只有 allowed-once 放行，且仅限当次（下次同命令重新走审批，不做会话级放行）；
 * - 审计事件只进会话存档的独立字段（SessionData.events），绝不混进 messages
 *   （messages 是发给模型的 surface）。
 */

/** 封闭决策集合：allowed-once（仅当次放行）/ rejected / cancelled（等待中被取消）/ unavailable（不可用，等价拒绝）。 */
export type ApprovalDecision = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** 一次审批请求：展示用原文 + 模型自带摘要 + 守卫/沙箱给出的拦截原因。 */
export interface ApprovalRequest {
  toolName: string;
  /** 展示用命令原文 */
  command: string;
  /** 模型自带的命令摘要（run_pwsh 的必填 description 参数） */
  description?: string;
  /** 守卫/沙箱给出的拦截原因（人类可读） */
  reasons: string[];
  /** 沙箱升级重试时模型附带的一句话理由（说明为什么需要更宽权限） */
  justification?: string;
  /** 请求来源的子代理短名（docs/5 §5.2 C3）：worker 的审批由 subagents.ts 标注，
   *  前端卡片展示来源（command 前缀同步带 [子代理 name] 供纯文本场景识别）；普通会话缺省 */
  subagent?: string;
}

/** fail-closed 归一化：合法值原样返回，其余（野值/缺失/异常）一律 unavailable。 */
export function normalizeDecision(raw: unknown): ApprovalDecision {
  return raw === "allowed-once" || raw === "rejected" || raw === "cancelled"
    ? raw
    : "unavailable";
}

/** 会话审批策略：ask=正常弹卡；never=无人值守/CI（连审批卡都不弹，直接 unavailable）。 */
export type AskMode = "ask" | "never";

/** 归一化会话审批策略：只有显式 "never" 生效，其余（缺省/野值）回默认 ask。 */
export function normalizeAskMode(raw: unknown): AskMode {
  return raw === "never" ? "never" : "ask";
}

/** 会话策略闸门：never（无人值守）不弹卡直接 unavailable；ask 时透传给真正的审批服务。 */
export async function askWithMode(
  askMode: AskMode,
  req: ApprovalRequest,
  ask: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): Promise<ApprovalDecision> {
  if (askMode === "never") return "unavailable";
  return await ask(req);
}

// ---- 审计事件（log-only，不进模型上下文） ----

export type AuditEventType = "approval/asked" | "approval/decided";

export interface AuditEvent {
  /** 会话内单调递增（从 1 开始） */
  seq: number;
  /** ISO 时间 */
  at: string;
  type: AuditEventType;
  command: string;
  description?: string;
  reasons: string[];
  /** 来源子代理短名（docs/5 §5.2）：worker 触发的审批自然带标；普通会话缺省 */
  subagent?: string;
  /** 仅 decided 事件有 */
  decision?: ApprovalDecision;
}

/** 下一个审计序号（空会话从 1 开始）。 */
export function nextAuditSeq(events: AuditEvent[] | undefined): number {
  const last = events?.[events.length - 1];
  return (last?.seq ?? 0) + 1;
}

/** 构造 approval/asked 事件（弹卡时写）。 */
export function auditAsked(events: AuditEvent[], req: ApprovalRequest, at = new Date().toISOString()): AuditEvent {
  return {
    seq: nextAuditSeq(events),
    at,
    type: "approval/asked",
    command: req.command,
    ...(req.description ? { description: req.description } : {}),
    reasons: req.reasons,
    ...(req.subagent ? { subagent: req.subagent } : {}),
  };
}

/** 构造 approval/decided 事件（决议时写）。 */
export function auditDecided(
  events: AuditEvent[],
  req: ApprovalRequest,
  decision: ApprovalDecision,
  at = new Date().toISOString(),
): AuditEvent {
  return {
    seq: nextAuditSeq(events),
    at,
    type: "approval/decided",
    command: req.command,
    ...(req.description ? { description: req.description } : {}),
    reasons: req.reasons,
    ...(req.subagent ? { subagent: req.subagent } : {}),
    decision,
  };
}

/** /status 用：本会话审批次数（asked）与批准次数（decided=allowed-once）。 */
export function auditStats(events: AuditEvent[] | undefined): { asked: number; allowed: number } {
  let asked = 0;
  let allowed = 0;
  for (const e of events ?? []) {
    if (e.type === "approval/asked") asked++;
    else if (e.decision === "allowed-once") allowed++;
  }
  return { asked, allowed };
}
