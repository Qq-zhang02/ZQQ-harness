/**
 * 手写微型状态仓（docs/26 F2，不引响应式框架）：get() / set(patch)（浅合并）/ subscribe(fn)（返回退订）。
 * 全部纯逻辑、禁 DOM 全局引用（可测性边界，契约测试哨兵锁定）——开发期排障开关（?zqqtrace=1）
 * 由**入口**读取后经 opts.trace 传入，本模块不碰 location。
 *
 * 两条语义约定（F2 迁移的根基，改动前先读）：
 * 1. **就地合并**：set 用 Object.assign 写入现有状态对象，get() 返回的引用**身份不变**——
 *    调用方可长期持有快照常量（如 `const V = viewStore.get()` 后一直读 V.x 永远最新），
 *    不必每次 get()。代价：外部直接改快照字段可绕过通知，因此纪律是「需要触发订阅的写
 *    一律走 set；纯数据游标（无订阅者关心的字段）可直接写快照」。
 * 2. **微任务合并**：同一 tick 多次 set 只触发一轮订阅（key 取并集），订阅里做全量刷新
 *    （如 applyState）天然幂等合并——消灭「改了状态忘调渲染」的纪律性 bug。
 */

/**
 * @typedef {Record<string, unknown>} StoreState
 * @typedef {(cur: StoreState, keys: Set<string>) => void} StoreSubscriber
 *   收到当前状态与本轮 set 触及的键集（订阅者按需过滤，避免无关刷新）。
 * @typedef {{ trace?: boolean }} StoreOpts trace=true 时对每次 set console.trace 其键（排障）。
 */

/**
 * 建一个状态仓。
 * @param {StoreState} initial 初始状态（对象被仓库持有并就地更新，调用方勿整替引用）
 * @param {StoreOpts} [opts]
 * @returns {{
 *   get: () => StoreState,
 *   set: (patch: StoreState) => void,
 *   subscribe: (fn: StoreSubscriber) => () => void,
 * }}
 */
export function createStore(initial, opts = {}) {
  let cur = initial;
  const subs = new Set();
  /** @type {Set<string> | null} 本轮待 flush 的键集（null=无待决，非 null=已排队微任务） */
  let keys = null;
  function flush() {
    const ks = keys;
    keys = null;
    for (const fn of subs) fn(cur, ks);
  }
  return {
    get: () => cur,
    /** 浅合并写入；同轮多次 set 合并为一轮订阅（键并集）。set 同引用也通知（不做等值短路）。 */
    set(patch) {
      Object.assign(cur, patch);
      if (opts.trace) console.trace("[store:set] " + Object.keys(patch).join(","));
      if (!keys) {
        keys = new Set(Object.keys(patch));
        queueMicrotask(flush);
      } else {
        for (const k in patch) keys.add(k);
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
