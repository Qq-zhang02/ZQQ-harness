// state.js（docs/26 F4/§6）：跨分区共享的状态层——chat/view/prov-set 三区状态仓（drawer/tree
// 两区随各自区域模块 drawer.js/sidebar.js 就地建仓）+ 前端运行常量 CFG + meta 读取助手。
// 为什么单独成层：chatStore 的快照 C 被 drawer/sidebar/modals 广泛读取（kind/meta/providerId），
// viewStore 的 V 被 sidebar 依赖（lastSessions/sessCache）——若这些仓留在消费链上游模块
// （chat/main）里，区域模块反向 import 会成环（§6 无环约束）；状态仓是天然的无环下沉点。
// 依赖方向：仅 import ./store.js（createStore 工厂）；本模块不 import 其他视图模块。
import { createStore } from "./store.js";

const TRACE = new URLSearchParams(location.search).has("zqqtrace"); // 开发期：?zqqtrace=1 可见状态变更轨迹

// ---------- 前端运行常量（docs/21 §2.4 / §3.2-①：单一出处，改动只看这里） ----------
const CFG = {
  CLOCK_TICK_MS: 1000,     // ⏱ 计时器滴答间隔
  POLL_CTX_MS: 2000,       // 运行中子代理 context 轮询
  POLL_DETAIL_MS: 1500,    // 抽屉运行中详情页轮询
  TRUNC_TOOL_FULL: 20000,  // 工具结果全文显示截断（完整内容已给模型，仅显示层截断）
  TRUNC_PREVIEW: 300,      // 工具结果行内预览截断
  CONFIRM_SESS_MS: 3000,   // 会话删除两步确认自动复位
  CONFIRM_WS_MS: 3000,     // 工作区删除两步确认自动复位
  CONFIRM_PURGE_MS: 2500,  // 回收站彻底删除两步确认自动复位
  CONFIRM_PROV_MS: 2500,   // 提供方删除两步确认自动复位
  CONFIRM_SET_MS: 3000,    // 运行阈值「有未保存修改关闭」两步确认自动复位
  INPUT_MAX_H: 160,        // 输入框自动伸展最大高度（px；CSS #input max-height 同值——无构建拿不到 CSS 变量，两处互指）
};

// chat 区状态仓（docs/26 F2）：state 快照 + 流式游标 + 待发图片。
// 读走稳定快照 C.<field>；游标写直接赋值；**state 的整替必须走 chatStore.set**——applyState 已是
// 订阅者（见 applyState 定义处），set 后微任务统一刷新，「改 state 忘调 applyState」从纪律变机制。
const chatStore = createStore({
  state: {
    busy: false, effort: "high", contextLimit: 0, workspace: "", model: "",
    providerId: "", providerName: "", kind: "normal",
    alwaysConfirm: false, askMode: "ask", sandboxMode: "workspace-write",
    runMs: 0, turnStartedAt: 0, // 运行计时：累计（已结束轮）+ 本次轮开始时刻（本地滴答）
    audit: { asked: 0, allowed: 0 },
    totals: {
      prompt: 0, completion: 0, cacheHit: 0, reasoning: 0,
      breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 },
    },
    context: {
      total: 0,
      breakdown: { systemPrompt: 0, skills: 0, systemTools: 0, mcp: 0, messages: 0, other: 0 },
    },
    skills: [],
    subagents: [],
  },
  curGroup: null, // 当前轮分组游标（流式渲染，无订阅者）
  curThink: null, curAnswer: null, curTool: null,
  toolBlocks: new Map(), // callId → 块元素（结果到达即移除）
  pendingImages: [], // 待发图片（mime+base64，前端已完成大小/数量校验；docs/10 R3）
}, { trace: TRACE });
const C = chatStore.get();

// ---------- 多会话并行：事件按 sessionId 路由 ----------
// view 区状态仓（docs/26 F2）：读走稳定快照 V.<field>（set 就地合并、身份不变——V 永远最新），
// 写直接赋值 V.<field>（本区纯数据游标，无订阅者；trace：?zqqtrace=1 可见走 set 的写点）。
// V.viewId=正在查看的会话；后台会话的事件先进入各自缓冲，切换查看时取快照渲染再从当前位置继续实时显示。
const viewStore = createStore({
  viewId: "",
  sessCache: new Map(), // id -> { buf: [], loading: false, approval: false, needsRefresh: false, turn: null }
  switchingTo: null,    // 正在进行的客户端主动切换（抑制 sessions 跟随，防止乒乓循环）
  pendingFollow: null,  // 切换进行中错过的服务端视图变更：切换完成后补跟随
  viewSeqSeen: 0,       // 已见过的最大服务端视图序号（小于它的 sessions 事件是排队中的过期事件，忽略跟随）
  lastSessions: { current: "", groups: [], recycled: [] },
}, { trace: TRACE });
const V = viewStore.get();
function cacheOf(id) {
  let c = V.sessCache.get(id);
  if (!c) { c = { buf: [], loading: false, approval: false, needsRefresh: false, turn: null }; V.sessCache.set(id, c); }
  return c;
}
function viewIs(id) { return id === V.viewId && !cacheOf(id).loading; }

// ---------- 设置项（§4.11：唯一出处=服务端 config.ts，随 C.state.meta 下发） ----------
const metaOf = () => C.state.meta || {};
/** 上下文上限：会话记录优先，缺省读 meta（服务端 config 的 DEFAULT_CONTEXT_LENGTH） */
const ctxLimitOf = () => C.state.contextLimit || metaOf().defaultContextLength || 0;
function sandboxLabel(m) {
  const hit = (metaOf().sandbox || []).find((s) => s.value === m);
  return hit ? hit.text : (m || "");
}

/** 消息图片规则（docs/22 §4.1 单一出处）：服务端 config.IMAGE_RULES 随 meta 下发
 *  （maxCount/maxBytes/mimes）；meta 未到（首帧前）返回 null——校验入口拒绝、上传按钮禁用。 */
const imgRules = () => metaOf().imageRules || null;


// prov/set 区状态仓（docs/26 §4）：提供方管理 + 运行阈值设置 + 回收站展开三个 UI 域的数据面。
// 读走稳定快照 PS.<field>，写直接赋值；渲染保持显式调用（renderProvList/setRender/updateRecycleVis），无订阅者。
const psStore = createStore({
  provData: { active: "", providers: [] },
  provEditing: null, // null=列表视图；"new"=新增；其他=正在编辑的 id
  setSchema: null,   // 运行阈值 GET 返回的 { groups, entries }（docs/24）
  setDirty: false,   // 设置模态有未保存修改（关闭前两步确认用）
  recycleOpen: false, // 回收站展开态（侧边栏）
}, { trace: TRACE });
const PS = psStore.get();

export { TRACE, CFG, chatStore, C, viewStore, V, cacheOf, viewIs, psStore, PS, metaOf, ctxLimitOf, sandboxLabel, imgRules };
