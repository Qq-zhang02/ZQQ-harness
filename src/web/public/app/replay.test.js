/** replay.js 测试（docs/26 F1）：事件路由判定 / ml 锚点缓冲过滤 / sessions 乒乓防护决策。 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideRoute, filterByMl, decideFollow } from "./replay.js";

// ---------- decideRoute：视图判定与后台分流 ----------

test("decideRoute：无会话归属的全局事件（d 为 null / 缺 sessionId）直接渲染", () => {
  assert.equal(decideRoute("anything", null, { viewId: "a", loading: false }), "render");
  assert.equal(decideRoute("state", { foo: 1 }, { viewId: "a", loading: false }), "render");
});

test("decideRoute：视图会话（且不在装载中）实时渲染；装载中视为后台分流", () => {
  assert.equal(decideRoute("delta", { sessionId: "a" }, { viewId: "a", loading: false }), "render");
  assert.equal(decideRoute("delta", { sessionId: "a" }, { viewId: "a", loading: true }), "buffer");
});

test("decideRoute：后台会话的 state/usage/turnEnd 只更新缓存（不渲染不缓冲）", () => {
  const v = { viewId: "a", loading: false };
  assert.equal(decideRoute("state", { sessionId: "b" }, v), "state");
  assert.equal(decideRoute("usage", { sessionId: "b" }, v), "usage");
  assert.equal(decideRoute("turnEnd", { sessionId: "b" }, v), "turnEnd");
});

test("decideRoute：后台会话的其余事件（delta/tool/toolResult/approval/info/error/subagent）进缓冲", () => {
  const v = { viewId: "a", loading: false };
  for (const ev of ["delta", "tool", "toolResult", "approval", "info", "error", "compaction", "subagent"]) {
    assert.equal(decideRoute(ev, { sessionId: "b" }, v), "buffer", ev);
  }
});

// ---------- filterByMl：切回会话的缓冲重放过滤（快照锚点） ----------

test("filterByMl：ml 缺失的缓冲项（无锚点事件）一律保留", () => {
  const out = filterByMl([{ ev: "info", d: { sessionId: "b" } }, { ev: "error", d: {} }], 5);
  assert.equal(out.length, 2);
});

test("filterByMl：ml < 快照长度（内容已在快照里）丢弃；≥ 快照长度（在途流）保留", () => {
  const buf = [
    { ev: "delta", d: { ml: 2 } },  // 已落入快照 → 丢
    { ev: "delta", d: { ml: 4 } },  // 已落入快照 → 丢
    { ev: "delta", d: { ml: 5 } },  // 边界：ml === 快照长度 → 在途，保留
    { ev: "delta", d: { ml: 7 } },  // 在途 → 保留
  ];
  const out = filterByMl(buf, 5);
  assert.deepEqual(out.map((x) => x.d.ml), [5, 7]);
});

test("filterByMl：空缓冲与零快照（会话尚无历史时 ml≥0 全保留）", () => {
  assert.deepEqual(filterByMl([], 0), []);
  assert.equal(filterByMl([{ ev: "delta", d: { ml: 0 } }], 0).length, 1);
});

// ---------- decideFollow：sessions 事件跟随的乒乓防护 ----------

test("decideFollow：过期视图事件（viewSeq ≤ 已见）忽略——快速连点的排队广播不回切", () => {
  assert.deepEqual(decideFollow({ current: "x", viewSeq: 3 }, { viewId: "a", viewSeqSeen: 3, switchingTo: null }), { type: "ignore" });
  assert.deepEqual(decideFollow({ current: "x", viewSeq: 2 }, { viewId: "a", viewSeqSeen: 3, switchingTo: null }), { type: "ignore" });
});

test("decideFollow：更新的视图序号 + 目标 ≠ 当前 + 无进行中切换 → 立即跟随", () => {
  assert.deepEqual(decideFollow({ current: "b", viewSeq: 4 }, { viewId: "a", viewSeqSeen: 3, switchingTo: null }), { type: "follow", id: "b" });
});

test("decideFollow：客户端主动切换进行中 → 推迟（defer 携带序号，切换完成后补跟随）", () => {
  assert.deepEqual(decideFollow({ current: "b", viewSeq: 4 }, { viewId: "a", viewSeqSeen: 3, switchingTo: "a" }), { type: "defer", id: "b", seq: 4 });
});

test("decideFollow：视图未变（current 缺失 / 等于当前视图）→ 忽略（照常刷新列表）", () => {
  assert.deepEqual(decideFollow({ viewSeq: 4 }, { viewId: "a", viewSeqSeen: 3, switchingTo: null }), { type: "ignore" });
  assert.deepEqual(decideFollow({ current: "a", viewSeq: 4 }, { viewId: "a", viewSeqSeen: 3, switchingTo: null }), { type: "ignore" });
});
