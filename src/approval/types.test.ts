import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDecision,
  normalizeAskMode,
  askWithMode,
  auditAsked,
  auditDecided,
  auditStats,
  nextAuditSeq,
  type ApprovalRequest,
  type AuditEvent,
} from "./types.ts";

const req: ApprovalRequest = {
  toolName: "run_pwsh",
  command: "Remove-Item C:\\temp\\x",
  description: "删除临时文件",
  reasons: ["引用了工作区外的路径：C:\\temp\\x"],
};

test("normalizeDecision：合法决策原样返回", () => {
  assert.equal(normalizeDecision("allowed-once"), "allowed-once");
  assert.equal(normalizeDecision("rejected"), "rejected");
  assert.equal(normalizeDecision("cancelled"), "cancelled");
});

test("normalizeDecision：野值/缺失/异常一律 unavailable（fail-closed）", () => {
  assert.equal(normalizeDecision("allowed"), "unavailable");
  assert.equal(normalizeDecision("ALLOWED-ONCE"), "unavailable");
  assert.equal(normalizeDecision(true), "unavailable");
  assert.equal(normalizeDecision(1), "unavailable");
  assert.equal(normalizeDecision(null), "unavailable");
  assert.equal(normalizeDecision(undefined), "unavailable");
  assert.equal(normalizeDecision({ decision: "allowed-once" }), "unavailable");
  assert.equal(normalizeDecision(""), "unavailable");
});

test("normalizeAskMode：只有显式 never 生效，缺省回 ask", () => {
  assert.equal(normalizeAskMode("never"), "never");
  assert.equal(normalizeAskMode("ask"), "ask");
  assert.equal(normalizeAskMode(undefined), "ask");
  assert.equal(normalizeAskMode("NEVER"), "ask");
});

test("askWithMode：never 模式不弹卡直接 unavailable；ask 模式透传审批服务", async () => {
  let asked = 0;
  const ask = async (r: ApprovalRequest) => {
    asked++;
    return "allowed-once" as const;
  };
  assert.equal(await askWithMode("never", req, ask), "unavailable");
  assert.equal(asked, 0); // 连审批服务都没碰
  assert.equal(await askWithMode("ask", req, ask), "allowed-once");
  assert.equal(asked, 1);
});

test("审计事件：asked/decided 成对、seq 单调、decision 只在 decided 上", () => {
  const events: AuditEvent[] = [];
  events.push(auditAsked(events, req, "2026-09-22T10:00:00.000Z"));
  events.push(auditDecided(events, req, "allowed-once", "2026-09-22T10:00:05.000Z"));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[0].type, "approval/asked");
  assert.equal(events[0].decision, undefined);
  assert.equal(events[1].type, "approval/decided");
  assert.equal(events[1].decision, "allowed-once");
  // 重建会话（从存档 events 恢复）后续号
  assert.equal(nextAuditSeq(events), 3);
  assert.equal(nextAuditSeq(undefined), 1);
});

test("审计事件结构上不携带消息字段（绝不混进 messages 的守护断言）", () => {
  const events: AuditEvent[] = [];
  events.push(auditAsked(events, req));
  events.push(auditDecided(events, req, "rejected"));
  for (const e of events) {
    const keys = Object.keys(e);
    assert.ok(!keys.includes("role") && !keys.includes("content") && !keys.includes("toolCallId"), "审计事件不得携带消息字段");
  }
});

test("auditStats：审批 N 次（批准 M 次）", () => {
  const events: AuditEvent[] = [];
  events.push(auditAsked(events, req));
  events.push(auditDecided(events, req, "rejected"));
  events.push(auditAsked(events, req));
  events.push(auditDecided(events, req, "allowed-once"));
  events.push(auditAsked(events, req));
  events.push(auditDecided(events, req, "unavailable"));
  assert.deepEqual(auditStats(events), { asked: 3, allowed: 1 });
  assert.deepEqual(auditStats(undefined), { asked: 0, allowed: 0 });
});

test("审计事件：subagent 来源字段随 asked/decided 自然携带（docs/5 §5.2）", () => {
  const events: AuditEvent[] = [];
  const fromWorker: ApprovalRequest = { ...req, command: "[子代理 impl-auth] Write-File x", subagent: "impl-auth" };
  const asked = auditAsked(events, fromWorker, "2026-11-12T10:00:00.000Z");
  assert.equal(asked.subagent, "impl-auth");
  events.push(asked);
  const decided = auditDecided(events, fromWorker, "allowed-once", "2026-11-12T10:00:01.000Z");
  assert.equal(decided.subagent, "impl-auth");
  // 普通会话请求不带该字段（可选，不出现而非 undefined 序列化）
  const plainAsked = auditAsked(events, req, "2026-11-12T10:00:02.000Z");
  assert.ok(!("subagent" in plainAsked));
});
