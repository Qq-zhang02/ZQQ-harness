// sidebar.js（docs/26 F4/§6）：侧边栏家族——工作区树/会话条目/回收站（keyed 渲染 + 拖拽排序）
// + treeStore 就地建仓（wsExpanded 的 localStorage 键 "zqq.wsExpanded" 不得改——迁移历史教训）。
// 依赖方向：dom/state/store；不 import main——会话切换经 bindSessionSwitch 回调槽注入（无环）：
// main.js 已 import 本模块的 renderTree/renderRecycle，反向 import switchSession 会成环（§6）。
import { $, el, esc, sysLine, post, normWs, reconcileKeyed } from "./dom.js";
import { createStore } from "./store.js";
import { CFG, TRACE, C, V, PS, cacheOf } from "./state.js";

// 会话切换回调槽（F4 无环接线）：入口 main.js 装载时 bindSessionSwitch(switchSession) 注入；
// 未注入前点击会话条目静默不动作（正常加载顺序下注入先于任何用户点击）。
let switchSession = null;
export function bindSessionSwitch(fn) { switchSession = fn; }

// ---------- 侧边栏：工作区树（点击选中并展开；工作区与对话均可拖动排序） ----------
// tree 区状态仓（docs/26 §2 F2）：拖拽两游标 + 展开集合。wsExpanded 的 localStorage 持久化键照旧
// （"zqq.wsExpanded"——迁移不得改键名，否则丢用户展开态）；Set 就地增删，读走 T.<field>、写直接操作。
const treeStore = createStore({
  dragSessionId: null, // 正在拖动的会话 id
  dragWsId: null,      // 正在拖动的工作区 id（路径）
  wsExpanded: new Set(JSON.parse(localStorage.getItem("zqq.wsExpanded") || "[]")),
}, { trace: TRACE });
const T = treeStore.get();
function saveExpanded() {
  try { localStorage.setItem("zqq.wsExpanded", JSON.stringify([...T.wsExpanded])); } catch { /* 隐私模式等场景忽略 */ }
}
function toggleWs(ws) {
  const k = normWs(ws);
  if (T.wsExpanded.has(k)) T.wsExpanded.delete(k); else T.wsExpanded.add(k);
  saveExpanded();
  renderTree();
}

/** 通用拖拽排序：把 dragId 移到 targetId 的上面/下面，返回新数组；无效返回 null */
function reordered(ids, dragId, targetId, below) {
  const from = ids.indexOf(dragId);
  if (from < 0 || ids.indexOf(targetId) < 0) return null;
  const out = ids.slice();
  out.splice(from, 1);
  // 位置基于移除被拖项后的数组：目标项原位置=放到其上，+1=放到其下
  const to = out.indexOf(targetId) + (below ? 1 : 0);
  out.splice(to, 0, dragId);
  return out;
}


/** 工作区内的一条对话（组内拖动排序；运行中/待审批有标记，点击切换查看不中断后台任务）。
 *  D3 keyed 化：骨架与事件**建时一次**（sessionItemNode），随快照变化的选中/徽标/标题/时间
 *  由 updateSessionItem 刷新；事件不闭包快照——经节点上的 _sid/_wsPath/_wsItems 取最新值。 */
function sessionItemNode() {
  const it = el("div", "sitem");
  it.draggable = true;
  it.appendChild(el("span", "st"));
  it.appendChild(el("span", "sd"));
  const del = el("button", "sdel", "✕");
  del.title = "删除该记录";
  del.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (del.textContent !== "确认") {
      del.textContent = "确认";
      del.classList.add("armed");
      setTimeout(() => { del.textContent = "✕"; del.classList.remove("armed"); }, CFG.CONFIRM_SESS_MS);
      return;
    }
    void post("/api/sessions/delete", { id: it._sid }).then((r) => { if (!r.ok) sysLine(r.data.error ?? "删除失败", "err"); });
  });
  it.appendChild(del);
  it.addEventListener("click", () => { if (switchSession) void switchSession(it._sid); }); // 回调槽见文件头（F4 无环）
  it.addEventListener("dragstart", (e) => {
    T.dragSessionId = it._sid;
    it.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  it.addEventListener("dragend", () => { it.classList.remove("dragging"); T.dragSessionId = null; });
  it.addEventListener("dragover", (e) => {
    if (!T.dragSessionId || T.dragSessionId === it._sid) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = it.getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    it.classList.toggle("drop-above", !below);
    it.classList.toggle("drop-below", below);
  });
  it.addEventListener("dragleave", () => it.classList.remove("drop-above", "drop-below"));
  it.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const below = it.classList.contains("drop-below");
    it.classList.remove("drop-above", "drop-below");
    const dragId = T.dragSessionId;
    T.dragSessionId = null;
    if (!dragId || dragId === it._sid) return;
    const ids = reordered(it._wsItems.map((x) => x.id), dragId, it._sid, below);
    if (!ids) return;
    const r = await post("/api/sessions/reorder", { workspace: it._wsPath, ids });
    if (!r.ok) { sysLine(r.data.error ?? "排序失败", "err"); return; }
    V.lastSessions = r.data;
    renderTree();
  });
  return it;
}

/** 会话条目的动态部分刷新（keyed 复用时每轮调用）：选中态/title/徽标（🎯❓⏳，无事件可重建，
 *  插在 .st 前保持与历史 DOM 序一致）/标题/时间；两步确认的 armed 态因节点复用自然保留。 */
function updateSessionItem(n, s, currentId, g) {
  n._sid = s.id;
  n._wsPath = g.workspace;
  n._wsItems = g.items;
  const running = ((C.state.runningIds || V.lastSessions.running || [])).includes(s.id);
  n.classList.toggle("cur", s.id === currentId);
  n.title = (s.kind === "coordinator" ? "协调者会话\n" : "") + (s.title || "") + "\n" + (s.workspace || "") + (running ? "\n（运行中，点击切换查看）" : "");
  for (const b of [...n.children]) if (b.classList.contains("srun")) b.remove();
  const st = [...n.children].find((c) => c.classList.contains("st"));
  if (s.kind === "coordinator") n.insertBefore(el("span", "srun co", "🎯"), st); // 会话形态徽标（按存档记录）
  if (cacheOf(s.id).approval) n.insertBefore(el("span", "srun ap", "❓"), st);
  if (running) n.insertBefore(el("span", "srun", "⏳"), st);
  st.textContent = s.title || "(无标题)";
  n.querySelector(".sd").textContent = new Date(s.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 工作区行：chev 折叠/展开；行点击选中并展开；🗑 两步确认删除；拖动排序。
 *  D3 keyed 化：骨架与事件建时一次（wsHeadNode，数据经节点字段 _ws 取最新），动态部分由
 *  updateWsHead 刷新——两步确认的 armed 态因节点复用自然保留（不再被重灌打断）。 */
function wsHeadNode() {
  const head = el("div", "wshead");
  head.draggable = true;
  head.appendChild(el("span", "chev"));
  head.appendChild(el("span", "wname"));
  head.appendChild(el("span", "wcount"));
  head.querySelector(".chev").addEventListener("click", (e) => { e.stopPropagation(); toggleWs(head._ws); });
  const del = el("button", "wsdel", "🗑");
  del.title = "删除该工作区（其中对话移入回收站）";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (del.textContent !== "确认？") {
      del.textContent = "确认？";
      del.classList.add("armed");
      setTimeout(() => { del.textContent = "🗑"; del.classList.remove("armed"); }, CFG.CONFIRM_WS_MS);
      return;
    }
    void post("/api/workspace/delete", { path: head._ws }).then((r) => {
      if (!r.ok) { sysLine(r.data.error ?? "删除失败", "err"); return; }
      T.wsExpanded.delete(normWs(head._ws));
      saveExpanded();
      PS.recycleOpen = true;
      updateRecycleVis();
      sysLine("已删除工作区 " + head._ws + "，" + r.data.moved + " 个对话已移入回收站" + (r.data.cleared ? "（已退出该工作区）" : ""));
    });
  });
  head.appendChild(del);
  head.addEventListener("click", () => {
    T.wsExpanded.add(normWs(head._ws));
    saveExpanded();
    renderTree(); // 立即给展开反馈；切换结果由服务端广播后重渲染（运行中的后台会话不受影响）
    if (normWs(head._ws) !== normWs(C.state.workspace || "")) {
      void post("/api/workspace", { path: head._ws }).then((r) => { if (!r.ok) sysLine(r.data.error ?? "切换失败", "err"); });
    }
  });
  head.addEventListener("dragstart", (e) => {
    T.dragWsId = head._ws;
    head.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  head.addEventListener("dragend", () => { head.classList.remove("dragging"); T.dragWsId = null; });
  head.addEventListener("dragover", (e) => {
    if (!T.dragWsId || normWs(T.dragWsId) === normWs(head._ws)) return;
    e.preventDefault();
    const rect = head.getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    head.classList.toggle("drop-above", !below);
    head.classList.toggle("drop-below", below);
  });
  head.addEventListener("dragleave", () => head.classList.remove("drop-above", "drop-below"));
  head.addEventListener("drop", async (e) => {
    e.preventDefault();
    const below = head.classList.contains("drop-below");
    head.classList.remove("drop-above", "drop-below");
    const dragId = T.dragWsId;
    T.dragWsId = null;
    if (!dragId || normWs(dragId) === normWs(head._ws)) return;
    const ids = reordered(V.lastSessions.groups.map((x) => x.workspace), dragId, head._ws, below);
    if (!ids) return;
    const r = await post("/api/workspaces/reorder", { ids });
    if (!r.ok) { sysLine(r.data.error ?? "排序失败", "err"); return; }
    V.lastSessions = r.data;
    renderTree();
  });
  return head;
}

/** 工作区行动态部分刷新（keyed 复用时每轮调用）：选中态/title/chev 方向/名称/条数。 */
function updateWsHead(n, g) {
  n._ws = g.workspace;
  n.classList.toggle("cur", normWs(g.workspace) === normWs(C.state.workspace || ""));
  n.title = g.workspace + "\n（点击选中并展开，拖动排序）";
  n.querySelector(".chev").textContent = T.wsExpanded.has(normWs(g.workspace)) ? "▾" : "▸";
  n.querySelector(".wname").textContent = g.workspace.split(/[\\/]/).pop() || g.workspace;
  n.querySelector(".wcount").textContent = String(g.items.length);
}

function renderTree() {
  // D3 keyed 更新（docs/21 §3.2-④）：按 key（ws:/box:<规范化工作区>、s:<会话id>、空态占位）
  // 复用既有节点，只增删/移动/刷新差异——选中、折叠、运行/审批标记与两步确认的 armed 态
  // 不再因整树重灌丢失；组内条目递归 reconcile（box 内独立 keyed 列表）。
  const tree = $("#wsTree");
  const groups = V.lastSessions.groups || [];
  if (!groups.length) {
    reconcileKeyed(tree, [{ key: "empty", make: () => el("div", "sempty", "暂无工作区<br>点击「添加工作区」开始") }]);
    return;
  }
  const entries = [];
  for (const g of groups) {
    const k = normWs(g.workspace);
    entries.push({ key: "ws:" + k, make: wsHeadNode, update: (n) => updateWsHead(n, g) });
    entries.push({
      key: "box:" + k,
      make: () => el("div", "wsitems"),
      update: (box) => {
        box.classList.toggle("collapsed", !T.wsExpanded.has(k));
        reconcileKeyed(box, (g.items || []).map((s) => ({
          key: "s:" + s.id,
          make: sessionItemNode,
          update: (n) => updateSessionItem(n, s, V.lastSessions.current, g),
        })));
      },
    });
  }
  reconcileKeyed(tree, entries);
}

function renderRecycle(recycled) {
  const list = $("#recycleList");
  const items = recycled || [];
  $("#recycleCount").textContent = items.length > 0 ? "(" + items.length + ")" : "";
  // F3 keyed 化（docs/26 §5）：sessions 事件重灌不再拆节点——彻底删除的**两步确认 armed 态
  // 不被刷新打断**（此前 2.5s 窗口内任何 sessions 广播都会把「确认」打回「✕」）。
  if (items.length === 0) {
    reconcileKeyed(list, [{ key: "empty", make: () => el("div", "sempty", "回收站为空") }]);
    return;
  }
  reconcileKeyed(list, items.map((s) => ({
    key: s.id,
    make: recycleItemNode,
    update: (n) => updateRecycleItem(n, s),
  })));
}
/** 回收站条目骨架与事件建时一次（F3）：事件经节点 _sid 取最新值，不闭包快照。 */
function recycleItemNode() {
  const it = el("div", "ritem");
  it.appendChild(el("span", "rt"));
  const restore = el("button", "rbtn restore", "恢复");
  restore.addEventListener("click", async () => {
    const r = await post("/api/sessions/restore", { id: it._sid });
    if (!r.ok) { sysLine(r.data.error ?? "恢复失败", "err"); return; }
    sysLine("已恢复对话「" + (r.data.title || "(无标题)") + "」到工作区 " + r.data.workspace);
  });
  it.appendChild(restore);
  const purge = el("button", "rbtn del", "✕");
  purge.title = "彻底删除（不可恢复）";
  purge.addEventListener("click", async () => {
    if (purge.textContent !== "确认") {
      purge.textContent = "确认";
      setTimeout(() => (purge.textContent = "✕"), CFG.CONFIRM_PURGE_MS);
      return;
    }
    const r = await post("/api/sessions/purge", { id: it._sid });
    if (!r.ok) { sysLine(r.data.error ?? "删除失败", "err"); return; }
    sysLine("已彻底删除对话");
  });
  it.appendChild(purge);
  return it;
}
/** 回收站条目动态刷新（keyed 复用时每轮调用）：标题/工作区/时间/恢复按钮 title。 */
function updateRecycleItem(n, s) {
  n._sid = s.id;
  const wsName = (s.workspace || "").split(/[\/]/).pop();
  const time = new Date(s.recycledAt || s.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit" });
  n.querySelector(".rt").innerHTML = '<span class="rtt">' + (s.kind === "coordinator" ? "🎯 " : "") + esc(s.title || "(无标题)") + '</span>' +
    '<span class="rmeta">' + esc(wsName || s.workspace) + " · " + time + "</span>";
  n.querySelector(".rbtn.restore").title = "恢复到工作区 " + (s.workspace || "");
}

// （recycleOpen 在 prov/set 区状态仓 psStore——F4 起定义在 state.js；本行的展开翻转逻辑在本文件）
function updateRecycleVis() {
  $("#recycleList").classList.toggle("hidden", !PS.recycleOpen);
  $("#recycleChev").textContent = PS.recycleOpen ? "▾" : "▸";
}
$("#recycleToggle").addEventListener("click", () => {
  PS.recycleOpen = !PS.recycleOpen;
  updateRecycleVis();
});

$("#newChatBtn").addEventListener("click", async () => {
  const r = await post("/api/sessions/new");
  if (!r.ok) sysLine(r.data.error ?? "新建失败", "err");
});

// 协调者对话：同一工作区开 kind=coordinator 会话（仅 agent_task 工具，docs/5 D9）
$("#newCoordBtn").addEventListener("click", async () => {
  const r = await post("/api/sessions/new", { kind: "coordinator" });
  if (!r.ok) sysLine(r.data.error ?? "新建失败", "err");
});

export { T, saveExpanded, renderTree, renderRecycle };
