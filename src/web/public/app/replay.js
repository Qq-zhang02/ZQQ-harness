/**
 * 会话事件路由与切换竞态的纯决策（docs/26 F1，自 index.html 的 route()/switchSession()/
 * SSE_HANDLERS.sessions 内嵌逻辑抽出）：本模块只做「该做什么」的判定，不做 DOM 渲染与
 * 缓存写入——调用方按返回的动作执行。全部纯函数，禁 DOM 全局引用（可测性边界，契约测试哨兵锁定）。
 */

/**
 * 事件路由判定（route() 的分支数据化）。
 * @param {string} evName SSE 事件名
 * @param {{ sessionId?: string } & Record<string, unknown> | null | undefined} d 事件数据（无会话归属的全局事件视为直接渲染）
 * @param {{ viewId: string, loading: boolean }} view 视图态：正在查看的会话 id + 该会话装载中标记
 * @returns {"render" | "state" | "usage" | "turnEnd" | "buffer"}
 *   render=视图会话（或无归属）直接渲染；state/usage/turnEnd=后台会话只更新缓存；
 *   buffer=进缓冲（切回时重放；approval 先置标记再入缓冲由调用方处理）。
 */
export function decideRoute(evName, d, view) {
  if (!d || !d.sessionId) return "render";
  if (d.sessionId === view.viewId && !view.loading) return "render";
  if (evName === "state") return "state";
  if (evName === "usage") return "usage";
  if (evName === "turnEnd") return "turnEnd";
  return "buffer";
}

/** @typedef {{ ev: string, d: { ml?: number } & Record<string, unknown> }} BufItem 缓冲项（SSE 事件暂存） */

/**
 * 缓冲重放过滤（switchSession 的 ml 锚点过滤）：只重放「尚未落入快照」的在途流——
 * 事件带 ml（发出时服务端历史长度）且小于快照长度的，内容已在快照里，丢弃防重复。
 * @param {BufItem[]} buf 缓冲项列表（调用方已 splice 清空原缓冲）
 * @param {number} snapshotLen 快照（/api/sessions/load 的 messages）长度
 * @returns {BufItem[]}
 */
export function filterByMl(buf, snapshotLen) {
  return buf.filter((x) => x.d.ml === undefined || x.d.ml >= snapshotLen);
}

/**
 * sessions 事件的视图跟随判定（乒乓防护）：服务端切换了视图（新建/切工作区/清空）时，
 * 客户端是否立即跟随、推迟到切换完成后补跟随、还是忽略（过期/无视图变更）。
 * 只跟随「更新的」视图序号：快速连点时服务端排队广播会携带过期 current 晚到，
 * 若据此回切会与服务端互相触发（乒乓循环=闪烁）。
 * @param {{ current?: string, viewSeq: number } & Record<string, unknown>} d sessions 载荷
 * @param {{ viewId: string, viewSeqSeen: number, switchingTo: string | null }} s 客户端竞态游标
 * @returns {{ type: "follow", id: string } | { type: "defer", id: string, seq: number } | { type: "ignore" }}
 *   follow=立即切换（调用方 switchSession(id) 且本轮不刷树）；defer=客户端主动切换进行中，
 *   记下待补跟随（带序号防过期）；ignore=照常刷新列表、不切换。
 */
export function decideFollow(d, s) {
  if (d.viewSeq > s.viewSeqSeen && d.current && d.current !== s.viewId) {
    return s.switchingTo ? { type: "defer", id: d.current, seq: d.viewSeq } : { type: "follow", id: d.current };
  }
  return { type: "ignore" };
}
