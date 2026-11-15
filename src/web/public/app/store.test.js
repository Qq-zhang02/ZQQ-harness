/** store.js 测试（docs/26 F2）：浅合并 / 微任务合并 flush / 订阅退订 / 稳定身份 / trace 开关。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.js";

/** 等一个微任务（flush 用 queueMicrotask，订阅在当前同步代码全部结束后触发） */
const tick = () => /** @type {Promise<void>} */ (new Promise((r) => queueMicrotask(r)));

// ---------- get / set：浅合并 ----------

test("get 返回初始状态；set 浅合并只动传入键、其余键保留", () => {
  const s = createStore({ a: 1, b: { n: 2 } });
  assert.deepEqual(s.get(), { a: 1, b: { n: 2 } });
  s.set({ a: 9 });
  assert.equal(s.get().a, 9);
  assert.deepEqual(s.get().b, { n: 2 }); // 未传入的键不动（浅合并）
});

test("set 是浅合并不是深合并：嵌套对象整替", () => {
  const s = createStore({ b: { n: 2 } });
  s.set({ b: { m: 3 } });
  assert.deepEqual(s.get().b, { m: 3 });
});

test("get() 引用身份稳定（就地合并）：持有旧快照常量可一直读到最新值", () => {
  const s = createStore({ x: 1 });
  const snap = s.get();
  s.set({ x: 2 });
  assert.equal(snap, s.get()); // 同一对象
  assert.equal(snap.x, 2); // 旧引用看到新值——F2 快照常量（V/C/D…）的根基
});

// ---------- 订阅与微任务合并 ----------

test("subscribe 在微任务后收到（状态, 本轮键集）；同 tick 多次 set 只触发一轮、键取并集", async () => {
  const s = createStore({ a: 1, b: 1, c: 1 });
  /** @type {[number, number, number, string[]][]} */
  const calls = [];
  s.subscribe((cur, ks) => calls.push([/** @type {number} */ (cur.a), /** @type {number} */ (cur.b), /** @type {number} */ (cur.c), [...ks].sort()]));
  s.set({ a: 2 });
  s.set({ b: 3 });
  s.set({ a: 4, c: 5 });
  assert.equal(calls.length, 0); // 同步阶段不触发
  await tick();
  assert.deepEqual(calls, [[4, 3, 5, ["a", "b", "c"]]]); // 一轮、最新值、键并集
});

test("订阅者可按键过滤（applyState 模式：只关心 state 键的 set）", async () => {
  const s = createStore({ state: null, curTool: null });
  let hits = 0;
  s.subscribe((_cur, ks) => { if (ks.has("state")) hits++; });
  s.set({ curTool: {} });
  await tick();
  assert.equal(hits, 0); // 无关键的 set 不触发该订阅者的动作
  s.set({ state: { busy: true } });
  s.set({ curTool: null });
  await tick();
  assert.equal(hits, 1);
});

test("订阅者收到的状态是合并后的最新值（后 set 覆盖前 set 同键）", async () => {
  const s = createStore({ v: 0 });
  let seen = -1;
  s.subscribe((cur) => (seen = /** @type {number} */ (cur.v)));
  s.set({ v: 1 });
  s.set({ v: 2 });
  await tick();
  assert.equal(seen, 2);
});

test("set 同引用也通知（嵌套字段就地改后用 set 通知的用法前提）", async () => {
  const s = createStore({ state: { totals: 0 } });
  let hits = 0;
  s.subscribe((_cur, ks) => { if (ks.has("state")) hits++; });
  const st = /** @type {{ totals: number }} */ (s.get().state);
  st.totals = 5;
  s.set({ state: st }); // 同引用
  await tick();
  assert.equal(hits, 1);
  assert.equal(st.totals, 5);
});

test("多个订阅者都收到（注册序）；退订后不再收", async () => {
  const s = createStore({ x: 0 });
  /** @type {number[]} */
  const order = [];
  const off1 = s.subscribe(() => order.push(1));
  s.subscribe(() => order.push(2));
  s.set({ x: 1 });
  await tick();
  assert.deepEqual(order, [1, 2]);
  off1();
  s.set({ x: 2 });
  await tick();
  assert.deepEqual(order, [1, 2, 2]); // 只有 2 号订阅者继续收
});

test("退订函数重复调用无害", async () => {
  const s = createStore({ x: 0 });
  let hits = 0;
  const off = s.subscribe(() => hits++);
  off();
  off();
  s.set({ x: 1 });
  await tick();
  assert.equal(hits, 0);
});

// ---------- trace 开关 ----------

test("opts.trace=true 时每次 set 打 console.trace（键名）；默认静默", async () => {
  /** @type {string[]} */
  const lines = [];
  const orig = console.trace;
  console.trace = (...a) => lines.push(String(a[0]));
  try {
    const s = createStore({ a: 1 }, { trace: true });
    s.set({ a: 2 });
    s.set({ b: 3, c: 4 });
    const quiet = createStore({ a: 1 });
    quiet.set({ a: 2 });
    await tick();
  } finally {
    console.trace = orig;
  }
  assert.deepEqual(lines, ["[store:set] a", "[store:set] b,c"]);
});
