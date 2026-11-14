import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSandboxMode, SandboxUnavailableError, type SandboxMode } from "./types.ts";
import { noBackend, getSandboxRunner, setSandboxRunner, type SandboxRunner } from "./runner.ts";
import { SessionStore } from "../web/sessions.ts";

test("normalizeSandboxMode：三档合法值原样返回，缺省/野值回默认 workspace-write", () => {
  const modes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
  for (const m of modes) assert.equal(normalizeSandboxMode(m), m);
  assert.equal(normalizeSandboxMode(undefined), "workspace-write");
  assert.equal(normalizeSandboxMode("full"), "workspace-write");
  assert.equal(normalizeSandboxMode(""), "workspace-write");
  assert.equal(normalizeSandboxMode(null), "workspace-write");
});

test("SandboxUnavailableError：fail-closed 专用错误，消息含模式与 SANDBOX_UNAVAILABLE", () => {
  const e = new SandboxUnavailableError("read-only");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "SandboxUnavailableError");
  assert.ok(e.message.includes("SANDBOX_UNAVAILABLE"));
  assert.ok(e.message.includes("read-only"));
});

test("沙箱接缝：默认无后端，可整体替换/降级", () => {
  assert.equal(getSandboxRunner(), noBackend);
  assert.equal(noBackend.available(), false);
  const fake: SandboxRunner = {
    name: "fake",
    available: () => true,
    run: async () => ({ code: 0, timedOut: false, interrupted: false, overLimit: false, stdout: "", stderr: "" }),
  };
  setSandboxRunner(fake);
  assert.equal(getSandboxRunner().available(), true);
  setSandboxRunner(noBackend);
  assert.equal(getSandboxRunner(), noBackend);
});

test("SessionData 往返：sandboxMode/askMode/events/compactions 随会话存档保存与恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sbx-"));
  try {
    const s = new SessionStore(dir);
    const id = "11111111-2222-3333-4444-5555555555a1";
    s.save({
      id,
      title: "沙箱模式往返",
      updatedAt: "2026-09-22T12:00:00.000Z",
      workspace: "F:\\proj",
      messageCount: 1,
      messages: [{ role: "user", content: "hi" }],
      providerId: "deepseek",
      effort: "high",
      askMode: "never",
      sandboxMode: "read-only",
      events: [
        { seq: 1, at: "2026-09-22T12:00:01.000Z", type: "approval/asked", command: "x", reasons: [] },
        { seq: 2, at: "2026-09-22T12:00:02.000Z", type: "approval/decided", command: "x", reasons: [], decision: "unavailable" },
      ],
      compactions: [{ at: "2026-09-22T12:00:03.000Z", cutIndex: 5, summary: "s", tokensBefore: 100, tokensAfter: 40, removedMessages: 4 }],
      totals: { prompt: 1, completion: 1 },
    });
    const d = s.load(id);
    assert.ok(d);
    assert.equal(d.askMode, "never");
    assert.equal(d.sandboxMode, "read-only");
    assert.equal(d.events?.length, 2);
    assert.equal(d.events?.[1]?.decision, "unavailable");
    assert.equal(d.compactions?.length, 1);
    assert.equal(d.compactions?.[0]?.tokensAfter, 40);
    // list() 的 meta 不含这些扩展字段也能正常列出
    assert.equal(s.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
