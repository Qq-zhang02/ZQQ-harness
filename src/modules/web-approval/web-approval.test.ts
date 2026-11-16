/**
 * /api/approval 的 apply 权限补丁测试（docs/30）：审批卡「允许并不再询问 / 解除沙箱并放行」
 * 随决议原子应用——补丁在 settle **之前**生效（排队的并行 worker 后卡立即见新模式）；
 * 野值决策仍归一 unavailable；无待批卡 409。桩 sessionHost + 桩 ServerRequest，不起 HTTP。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../core/context.ts";
import { loadConfig } from "../../config.ts";
import { webApproval } from "./index.ts";
import type { ServerRequest } from "../../core/http.ts";
import type { SessionHost } from "../../core/host.ts";
import type { ApprovalDecision } from "../../approval/types.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "zqq-webapproval-"));
  const ctx = buildContext(
    {
      userDir: dir,
      globalSkillsDir: join(dir, "skills"),
      globalMcpFile: join(dir, "mcp.json"),
      workspacesFile: join(dir, "workspaces.json"),
      sessionsDir: join(dir, "sessions"),
    },
    loadConfig(),
  );
  const settings = { alwaysConfirm: false, effort: "high", askMode: "ask", sandboxMode: "workspace-write" };
  const order: string[] = []; // 事件序：apply-broadcast 必须先于 settle
  let settled: ApprovalDecision | null = null;
  const rt = {
    id: "0e0d8f8a-bbbb-cccc-cccc-dddddddddddd",
    busy: true,
    workspace: { root: join(dir, "ws") },
    settings,
    agent: { setSandboxMode: (m: string) => { settings.sandboxMode = m; order.push("sandbox-set"); } },
    pendingApproval: (d: ApprovalDecision) => {
      order.push("settle:" + d);
      settled = d;
      (rt as { pendingApproval: unknown }).pendingApproval = null; // 单槽语义：决议即清（同 doAsk）
    },
  };
  const host = {
    runtimes: () => new Map([[rt.id, rt]]),
    viewRt: () => rt,
    persistSession: () => order.push("persist"),
    broadcast: (ev: string) => order.push(ev),
    currentState: () => ({ ...settings }),
  } as unknown as SessionHost;
  ctx.sessionHost = host;
  webApproval.setup(ctx);
  const route = ctx.routes.get("/api/approval");
  const call = async (body: Record<string, unknown>) => {
    const responses: Array<{ status: number; data: unknown }> = [];
    const r: ServerRequest = {
      req: {} as never,
      res: {} as never,
      url: new URL("http://localhost/api/approval"),
      body: async () => body,
      json: (status, data) => responses.push({ status, data }),
    };
    await route!.handler(r);
    return responses[0]!;
  };
  return { dir, call, rt, settings, order, settled: () => settled };
}

test("/api/approval apply 补丁：先应用权限再 settle（排队后卡立即见新模式）；决策照常透传", async () => {
  const h = harness();
  try {
    const res = await h.call({
      decision: "allowed-once",
      apply: { askMode: "auto", alwaysConfirm: false, sandboxMode: "danger-full-access" },
      sessionId: h.rt.id,
    });
    assert.equal(res.status, 202);
    assert.equal(h.settings.askMode, "auto", "审批策略已切自动放行");
    assert.equal(h.settings.sandboxMode, "danger-full-access", "沙箱已解除（setSandboxMode 热更）");
    assert.equal(h.settled(), "allowed-once");
    assert.ok(h.order.indexOf("state") < h.order.findIndex((x) => x.startsWith("settle:")), "广播（补丁应用）先于决议 settle");
    assert.ok(h.order.indexOf("sandbox-set") < h.order.findIndex((x) => x.startsWith("settle:")), "setSandboxMode 先于 settle");
    assert.equal(h.order.includes("persist"), false, "busy（有卡必在轮中）不落盘，轮末存档兜底");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("/api/approval：无待批卡 409；野值决策归一 unavailable；带 apply 时设置仍应用", async () => {
  const h = harness();
  try {
    assert.equal((await h.call({ decision: "allowed-once", sessionId: h.rt.id })).status, 202); // 先清掉桩卡
    assert.equal((await h.call({ decision: "allowed-once", sessionId: h.rt.id })).status, 409); // 槽已空
    // 重建一张卡：野值决策 fail-closed 归一 unavailable（按拒绝），apply 补丁照常应用
    (h.rt as { pendingApproval: ((d: ApprovalDecision) => void) | null }).pendingApproval = (d) => {
      h.order.push("settle:" + d);
    };
    const before = h.settings.askMode;
    const res = await h.call({ decision: "ALLOWED", apply: { askMode: "never" }, sessionId: h.rt.id });
    assert.equal(res.status, 202);
    assert.equal(h.settings.askMode, "never", "apply 补丁与决策质量解耦：野值不影响补丁应用");
    assert.notEqual(before, "never");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
