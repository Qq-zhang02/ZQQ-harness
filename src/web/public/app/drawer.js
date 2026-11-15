// drawer.js（docs/26 F4/§6）：子代理抽屉家族（~520 行整体搬迁）——drawerStore 就地建仓 +
// 行状态机/列表与详情两视图/上下文占比轮询/运行计时滴答 + 子代理过程时间线渲染器 makeTimeline。
// 依赖方向：dom/state/autoreport/store 四底层；不 import chat/sidebar/modals/main（区域自治，
// 对外只暴露 render*/sync/reset/onSubagent/tickClock/refreshSubSum 与 drawer 稳定别名）。
import { $, el, esc, mdLite, nearBottom, autoscroll, scrollStateOf, rebuildKeepScroll, keepOpenOf, sysLine, post } from "./dom.js";
import { fmtTok, fmtDur, firstLine, prettyArgs } from "./autoreport.js";
import { createStore } from "./store.js";
import { CFG, TRACE, C, V } from "./state.js";

/** 子代理行的用时片段：run 本地滴算「本次」；其余态显示累计 elapsedMs。 */
function elapsedPart(row) {
  if (row.status === "run") {
    return row.taskStartedAt ? " · ⏱ " + fmtDur(Date.now() - row.taskStartedAt) : "";
  }
  return row.elapsedMs != null && row.elapsedMs > 0 ? " · ⏱ " + fmtDur(row.elapsedMs) : "";
}

// ---------- 子代理抽屉（需求三 docs/8 §3.2 方案 A）：主列只留摘要，实时过程与回看都进右栏 ----------
// 数据层：per-worker 行缓存（Map<subId,row>），三路合流——C.state.subagents 完成审计 +
// C.state.activeSubagents 运行中瞬态（resetDrawer/syncDrawer 从快照同步）+ subagent SSE 事件
// 增量（onSubagent 改道进缓存）。不依赖 C.curTool 挂载：事件在 renderHistory/finishSegments
// 清掉工具块后仍落到抽屉（需求二症状 3 的结构性消除），切走再切回的缓冲重放同路径幂等重建。
// drawer 区状态仓（docs/26 F2）：drawer 对象**整体并入**（内部字段不变）+ ctx 轮询句柄两游标。
// drawer.* 的 89 处引用经稳定别名零改动（set 就地合并身份不变，D.drawer 永远是同一个对象）；
// 渲染保持显式调用（renderDrawer 家族），无订阅者——并入收的是分组与 trace 边界，不是响应式。
const drawerStore = createStore({
  drawer: {
    open: false,       // 抽屉开合（纯前端态；切换会话按快照重建）
    userClosed: false, // 用户手动收起过：本会话内不再自动弹开
    detail: 0,         // 详情页 subId（0=列表页）
    // 行状态机（docs/9；docs/18 起暂停/恢复退役）：run（任务执行中，⏹ 可打断）→ idle（可复用待命，
    // 💤——归档按钮）→ archived（📦 只读）；一次性 run → done/error（=已归档）。stale=服务重启后的
    // 休眠待命（docs/17：followup 自动唤醒）。
    workers: new Map(),// subId → { subId,name,summary,status,rounds,usage,error,transcript,steps,reusable,archived,tasks,stale }
    renderSeq: 0,      // 详情页渲染序号：异步拉取/轮询返回时校验未被新一轮渲染取代
    poll: null,        // 运行中详情页的轮询句柄 { subId, timer, last }；换页/收起即停
    expand: null,      // 折叠状态持久化 { subId, explicit: Map<key,boolean> }——轮询重渲染间保留用户展开态
    renderedDetail: 0, // 详情页当前已渲染的 subId（docs/11 W2：同 id 重渲染不预清空——防异步拉取期的空白跳变）
    max: false,        // 抽屉放大态（docs/12 A：详情/列表占满整页；纯前端态，切会话/收起抽屉时重置）
  },
  ctxTimer: null, // 运行中子代理 context 轮询句柄（非 null=轮询中）
  ctxBusy: false, // 上一轮 context 拉取在途标记（防重入）
}, { trace: TRACE });
const D = drawerStore.get();
const drawer = D.drawer;

function ensureDrawerRow(subId, name) {
  let row = drawer.workers.get(subId);
  if (!row) {
    row = { subId, name: name || "#" + subId, summary: "", status: "run", rounds: undefined, usage: undefined, error: "", transcript: "", steps: [], reusable: false, archived: false, tasks: 0, stale: false, contextPct: undefined, taskStartedAt: undefined, elapsedMs: undefined };
    drawer.workers.set(subId, row);
  } else if (name && row.name !== name) row.name = name;
  return row;
}
/** docs/10 R1（docs/21 §2.2-⑤ 三档全量下发）：治理档位全部从服务端 meta 取（warn/cut/arch），
 *  不写 25/35 兜底数字——meta 未到（首帧前）返回 null，显示层只出百分比、不出档位标记。 */
function ctxTiers() {
  const m = C.state.meta || {};
  return m.subagentWarnPct != null && m.subagentFollowupPct != null && m.subagentArchivePct != null
    ? { warn: m.subagentWarnPct, cut: m.subagentFollowupPct, arch: m.subagentArchivePct }
    : null;
}
/** docs/10 R1（修订三档）：上下文占比片段——>预警线（默认 25%）附「较长」（仍可派）、
 *  ≥拒收线（默认 35%）附「不宜再派」（服务端拒收）、>归档线（默认 50%）附「超归档线」
 *  （任务完成即强制归档）。纯文本，消费点统一走 esc。 */
function ctxPctPart(row) {
  if (row.contextPct == null) return "";
  const t = ctxTiers();
  if (!t) return " · 上下文 " + row.contextPct + "%";
  if (row.contextPct > t.arch) return " · 上下文 " + row.contextPct + "% ⚠超归档线";
  if (row.contextPct >= t.cut) return " · 上下文 " + row.contextPct + "% ⚠不宜再派";
  if (row.contextPct > t.warn) return " · 上下文 " + row.contextPct + "% ⚠较长";
  return " · 上下文 " + row.contextPct + "%";
}
/** 详情页头部（docs/10 R1 修订：独立成函数——列表轮询/详情轮询更新 contextPct 后可
 *  单独刷新头部，不重建过程时间线与展开态）。 */
function renderDetailHead(row) {
  const head = $("#drwDetailHead");
  const color = row.status === "done" ? "var(--green)" : row.status === "error" ? "var(--red)" : row.status === "archived" ? "var(--dim)" : row.status === "idle" ? "var(--accent)" : "var(--yellow)";
  const icon = row.status === "run" ? "▶" : row.status === "idle" ? "💤" : row.status === "archived" ? "📦" : row.status === "done" ? "✓" : "✗";
  head.innerHTML =
    '<span style="color:' + color + '">' + icon + "</span> <b>" + esc(row.name) + '</b> <span style="color:var(--dim);font-size:12px">#' + Number(row.subId) + "</span>" +
    (row.summary ? '<div class="dh-meta">' + esc(row.summary) + "</div>" : "") +
    '<div class="dh-meta">' + esc(subMetaText(row)) + "</div>";
}
function subMetaText(row) {
  if (row.status === "run") return "运行中" + elapsedPart(row) + ctxPctPart(row);
  if (row.status === "idle") {
    const parts = [];
    if (row.tasks) parts.push("已完成 " + row.tasks + " 次任务");
    if (row.rounds != null) parts.push("累计 " + row.rounds + " 轮");
    if (row.usage) parts.push("输入 " + fmtTok(row.usage.prompt) + " / 输出 " + fmtTok(row.usage.completion) + " tokens");
    if (row.elapsedMs != null && row.elapsedMs > 0) parts.push("累计用时 " + fmtDur(row.elapsedMs));
    // docs/17：待命记录在但活句柄不在（服务重启过）= 休眠待命——agent_followup 派任务时自动从存档唤醒
    const head = row.stale ? "空闲待命 · 服务重启过 · agent_followup 派任务时自动唤醒" : "空闲待命 · 可继续派任务";
    return head + (parts.length ? " · " + parts.join(" · ") : "") + ctxPctPart(row);
  }
  if (row.status === "archived") {
    const parts = [];
    if (row.reusable) {
      if (row.tasks) parts.push("共 " + row.tasks + " 次任务");
      if (row.rounds != null) parts.push(row.rounds + " 轮");
      if (row.usage) parts.push("输入 " + fmtTok(row.usage.prompt) + " / 输出 " + fmtTok(row.usage.completion) + " tokens");
      if (row.elapsedMs != null && row.elapsedMs > 0) parts.push("累计用时 " + fmtDur(row.elapsedMs));
    }
    return "已归档（只读）" + (parts.length ? " · " + parts.join(" · ") : "") + ctxPctPart(row);
  }
  const stats = [];
  if (row.rounds != null) stats.push(row.rounds + " 轮");
  if (row.elapsedMs != null && row.elapsedMs > 0) stats.push("用时 " + fmtDur(row.elapsedMs));
  if (row.usage) stats.push("输入 " + fmtTok(row.usage.prompt) + " / 输出 " + fmtTok(row.usage.completion) + " tokens");
  const pct = ctxPctPart(row);
  if (row.status === "done") return "📦 已归档 · " + (stats.length > 0 ? "✓ " + stats.join(" · ") : "完成") + pct;
  return "📦 已归档 · ✗ " + (row.error || "失败") + (stats.length > 0 ? "（" + stats.join(" · ") + "）" : "") + pct;
}
function hasLiveSub() {
  for (const r of drawer.workers.values()) if (r.status === "run") return true;
  return false;
}

/** 硬重置（切换会话）：从快照全量重建（完成审计 + 运行中瞬态）；运行中详情页数据在服务端
 *  （liveMessages 实时历史），切换/刷新后照常轮询拉取——进度记录零丢失（docs/8 第三棒）。
 *  自动展开规则统一在 syncDrawer（用户手动收起过则不弹）。 */
function resetDrawer(st) {
  drawer.workers.clear();
  drawer.detail = 0;
  drawer.renderedDetail = 0; // docs/11 W2：换会话后旧详情内容不算数，重开详情按新开处理（清空+贴底）
  stopLivePoll();
  stopCtxPoll(); // docs/10 R1 修订：切会话停掉占比轮询（V.viewId 已换）
  drawer.userClosed = false;
  drawer.max = false; // docs/12 A：换会话退出放大态（新会话从侧边抽屉开始）
  syncDrawer(st);
  renderDrawer();
}

/** 软同步（init/C.state 快照到达）：完成记录与运行中清单以快照为准回填，运行中行保留已积累
 *  的实时步骤（不因 interim 合并/压缩的 init 重渲染清空——抽屉是 renderHistory 外的常驻态）。
 *  docs/9：可复用的待命记录（status:"idle"）不强覆盖——活性状态以 activeSubagents 为准；
 *  待命记录在但活动句柄不在 = 服务重启后的休眠待命 → 保持 💤 idle 展示（stale 标记，
 *  docs/17：agent_followup 派任务时服务端自动从过程存档唤醒，不再失效转只读）。
 *  会话空闲（!busy）时丢弃不在快照里的运行中行——那是服务重启/事件丢失留下的幽灵。
 *  有运行中 worker 且用户未手动收起 → 抽屉自动展开（刷新/切回/init 三路统一）。 */
function syncDrawer(st) {
  if (st && st.kind === "coordinator") {
    const seen = new Set();
    const idleRec = new Set(); // 待命记录（活性取决于是否有活动句柄）
    for (const rec of st.subagents || []) {
      seen.add(rec.subId);
      const row = ensureDrawerRow(rec.subId, rec.name);
      row.summary = rec.description || row.summary;
      if (rec.reusable) { row.reusable = true; row.tasks = rec.tasks || 0; }
      if (rec.contextPct != null) row.contextPct = rec.contextPct; // docs/10 R1：存档记录快照
      if (rec.elapsedMs != null) row.elapsedMs = rec.elapsedMs; // 累计用时快照
      if (rec.reusable && rec.state === "idle") {
        // 活实例在 → 状态由下方 activeSubagents 回填（idle）；不在（重启休眠）→ 末尾统一标 stale（docs/17：followup 自动唤醒）
        idleRec.add(rec.subId);
        row.transcript = rec.transcript || "";
        row.rounds = rec.rounds;
        row.usage = rec.usage;
        continue;
      }
      row.status = rec.reusable ? "archived" : (rec.ok ? "done" : "error");
      row.rounds = rec.rounds;
      row.usage = rec.usage;
      row.error = rec.ok ? "" : (rec.error || "未知原因");
      row.transcript = rec.transcript || "";
      row.archived = true;
      row.taskStartedAt = undefined;
    }
    for (const a of st.activeSubagents || []) {
      seen.add(a.subId);
      idleRec.delete(a.subId); // 句柄在：待命记录是活实例
      const row = ensureDrawerRow(a.subId, a.name);
      if (a.reusable) {
        row.reusable = true;
        if (a.summary) row.summary = a.summary;
        if (a.tasks != null) row.tasks = a.tasks;
      }
      if (a.contextPct != null) row.contextPct = a.contextPct; // docs/10 R1：活动句柄快照（热于存档记录）
      if (a.elapsedMs != null) row.elapsedMs = a.elapsedMs; // 累计用时（含进行中已耗时）
      if (a.taskStartedAt != null) row.taskStartedAt = a.taskStartedAt; // run 态「本次用时」
      if (row.status === "run" || row.status === "idle" || row.reusable) {
        row.status = a.status === "idle" ? "idle" : "run";
        row.stale = false;
      }
    }
    for (const id of idleRec) {
      const row = drawer.workers.get(id);
      // docs/17：待命记录在但活句柄不在（服务重启过）= 休眠待命——保持 💤 idle 展示，
      // agent_followup 派任务时服务端自动从过程存档唤醒；不再失效转只读
      if (row && (row.status === "run" || row.status === "idle")) row.stale = true;
    }
    if (!st.busy) {
      for (const [id, row] of drawer.workers) {
        if (!seen.has(id) && row.status === "run") drawer.workers.delete(id);
      }
    }
  }
  if (!drawer.open && !drawer.userClosed && hasLiveSub()) drawer.open = true; // 刷新/切回/init 统一自动展开
  if (drawer.detail && !drawer.workers.has(drawer.detail)) { drawer.detail = 0; stopLivePoll(); }
  renderDrawer();
}

/** subagent SSE 事件 → 抽屉缓存增量（需求三 docs/8 §3.4：不依赖 C.curTool，处理器只改道到抽屉）。
 *  工具事件只积累进 steps（无存档时的保底视图数据）；运行中详情页的实时呈现走服务端
 *  transcript 轮询（docs/8 第三棒——与事件流互不重叠，思考/正文/工具全量）。
 *  docs/9 新相位：task（followup 起跑——行 idle→run + 摘要更新）、idle（可复用任务结束转
 *  待命：ok/error 为本任务结果，rounds/usage 本任务口径，tasks 为累计次数）、archived（归档
 *  定格——只读）。done/error 仅一次性子代理（=用完即归档）。 */
function onSubagent(d) {
  const row = ensureDrawerRow(d.subId, d.name);
  if (d.phase === "tool" || d.phase === "toolResult") {
    row.steps.push(d);
    refreshLiveSubSums();
    return;
  }
  if (d.phase === "done" || d.phase === "error") {
    row.status = d.phase === "done" ? "done" : "error";
    row.archived = true; // 一次性：用完即归档（docs/9）
    row.rounds = d.rounds;
    row.usage = d.usage;
    row.error = d.phase === "error" ? (d.error || "未知原因") : "";
    row.transcript = d.transcript || "";
    if (d.contextPct != null) row.contextPct = d.contextPct; // docs/10 R1
    row.taskStartedAt = undefined;
    if (d.elapsedMs != null) row.elapsedMs = d.elapsedMs; // 本次任务用时（定格）
    renderDrawer(); // 详情页开着：renderDrawerDetail 检测到 transcript 会升级为全程存档视图
    refreshLiveSubSums();
    return;
  }
  if (d.phase === "task") {
    // followup 起跑（docs/9）：行 idle→run，摘要换成本次任务
    row.reusable = true;
    if (d.summary) row.summary = d.summary;
    row.status = "run";
    if (d.taskStartedAt != null) row.taskStartedAt = d.taskStartedAt;
    if (!drawer.open && !drawer.userClosed) drawer.open = true;
    renderDrawer();
    refreshLiveSubSums();
    return;
  }
  if (d.phase === "idle") {
    // 可复用任务结束：转待命（失败也待命——worker 存活，docs/9）
    row.reusable = true;
    row.status = "idle";
    row.rounds = d.rounds;
    row.usage = d.usage;
    row.error = d.ok ? "" : (d.error || "未知原因");
    row.transcript = d.transcript || "";
    if (d.tasks != null) row.tasks = d.tasks;
    if (d.contextPct != null) row.contextPct = d.contextPct; // docs/10 R1
    row.taskStartedAt = undefined;
    if (d.elapsedMs != null) row.elapsedMs = d.elapsedMs; // 跨任务累计用时
    renderDrawer();
    refreshLiveSubSums();
    return;
  }
  if (d.phase === "archived") {
    row.reusable = true;
    row.status = "archived";
    row.archived = true;
    if (d.tasks != null) row.tasks = d.tasks;
    if (d.rounds != null) row.rounds = d.rounds;
    if (d.usage) row.usage = d.usage;
    if (d.transcript) row.transcript = d.transcript;
    if (d.contextPct != null) row.contextPct = d.contextPct; // docs/10 R1
    row.taskStartedAt = undefined;
    if (d.elapsedMs != null) row.elapsedMs = d.elapsedMs;
    renderDrawer();
    refreshLiveSubSums();
    return;
  }
  // spawned（配额拒绝不发事件——不启动的 worker 不进列表，由工具结果文本呈现）
  if (row.status !== "run") {
    // 终态/待命行再收到 spawned：服务重启后 seq 复用同一 subId 的覆盖语义
    //（步骤/统计/归档位清零重积累，docs/9）
    row.steps = [];
    row.rounds = undefined;
    row.usage = undefined;
    row.error = "";
    row.transcript = "";
    row.tasks = 0;
    row.archived = false;
    row.stale = false;
    row.elapsedMs = undefined;
  }
  if (d.taskStartedAt != null) row.taskStartedAt = d.taskStartedAt; // 「本次用时」种子（轮询校正）
  row.reusable = d.reusable === true;
  row.summary = d.summary || "";
  row.status = "run";
  if (!drawer.open && !drawer.userClosed) drawer.open = true; // 首个 worker 启动：自动展开
  renderDrawer();
  refreshLiveSubSums();
}

/** 主列 agent_task(s) 运行中块的摘要行（完成后由 addToolRes 从结果文本定格本批统计）。
 *  实时文本用全会话统计（数据源=抽屉缓存；不依赖工具块存活，重放/重渲染后同样成立）。 */
function refreshSubSum(sum) {
  const rows = [...drawer.workers.values()];
  if (rows.length === 0) { sum.textContent = "🤖 子代理 · 详情在抽屉中查看"; return; }
  const parts = [];
  const run = rows.filter((r) => r.status === "run").length;
  const idle = rows.filter((r) => r.status === "idle").length;
  const ok = rows.filter((r) => r.status === "done").length;
  const err = rows.filter((r) => r.status === "error").length;
  if (run) parts.push("▶" + run);
  if (idle) parts.push("💤" + idle);
  if (ok) parts.push("✓" + ok);
  if (err) parts.push("✗" + err);
  sum.textContent = "🤖 子代理动态：" + parts.join(" ") + " · 点击在抽屉中查看";
}
function refreshLiveSubSums() {
  document.querySelectorAll("#chat .tblock.live .subsum").forEach((s) => refreshSubSum(s));
}

/** 抽屉整体渲染：开合、列表/详情两视图、顶栏开关按钮。普通会话（无 worker）不显示抽屉元素。 */
function renderDrawer() {
  const visible = drawer.open && C.state.kind === "coordinator" && drawer.workers.size > 0;
  $("#subDrawer").classList.toggle("hidden", !visible);
  syncDrawerMax(); // docs/12 A：放大态 class/按钮文案随渲染幂等同步
  const isDetail = visible && drawer.detail !== 0 && drawer.workers.has(drawer.detail);
  $("#drwList").classList.toggle("hidden", isDetail); // 列表页与详情页互斥（hidden=隐藏）
  $("#drwDetail").classList.toggle("hidden", !isDetail);
  $("#drwBack").classList.toggle("hidden", !isDetail);
  if (!isDetail) stopLivePoll(); // 离开详情页（返回列表/收起抽屉/切换）即停轮询；重进时按需重启
  if (isDetail) void renderDrawerDetail();
  else if (visible) renderDrawerList();
  updateDrwBtn();
  ensureCtxPoll(); // docs/10 R1 修订：运行中 worker 的上下文占比持续轮询（一直显示）
}

// ---------- docs/10 R1 修订：运行中子代理的上下文占比轮询（一直显示） ----------
// 抽屉可见且有运行中 worker → 每 2s 逐个查 /api/subagent/context（轻量，不拉历史）。
// docs/11 W2：结果**就地更新**（列表行 meta 与详情头部单独刷新）——绝不整抽屉重渲染：
// elapsedMs 每轮必变，原先的 renderDrawer() 会每 2s 拆掉重建详情页（时间线闪空、阅读
// 位置跳变）。全量重渲染只留给低频状态迁移事件（done/idle/archived 等）。
// 详情页自身另有 1.5s 的 transcript 轮询顺带更新（pollLiveDetail），两条通道互不冲突。
// （ctxTimer/ctxBusy 在 drawer 区状态仓，见本文件 drawerStore 建仓处）
function ensureCtxPoll() {
  const need = drawer.open && C.state.kind === "coordinator" && hasLiveSub();
  if (!need) { stopCtxPoll(); return; }
  if (D.ctxTimer !== null) return;
  D.ctxTimer = setInterval(async () => {
    if (D.ctxBusy) return;
    if (!drawer.open || !hasLiveSub()) { stopCtxPoll(); return; }
    D.ctxBusy = true;
    try {
      const touched = [];
      for (const w of drawer.workers.values()) {
        if (w.status !== "run") continue;
        try {
          const r = await fetch("/api/subagent/context?sessionId=" + encodeURIComponent(V.viewId) + "&subId=" + encodeURIComponent(String(w.subId)));
          if (!r.ok) continue;
          const d = await r.json().catch(() => ({}));
          let changed = false;
          if (d.contextPct != null && d.contextPct !== w.contextPct) { w.contextPct = d.contextPct; changed = true; }
          if (d.taskStartedAt != null && d.taskStartedAt !== w.taskStartedAt) { w.taskStartedAt = d.taskStartedAt; changed = true; }
          if (d.elapsedMs != null && d.elapsedMs !== w.elapsedMs) { w.elapsedMs = d.elapsedMs; changed = true; } // 累计口径（终态行/详情头部消费）；run 行用时由本地滴算
          if (changed) touched.push(w);
        } catch { /* 单个失败不打断其余 */ }
      }
      for (const w of touched) refreshRowMetaInPlace(w);
    } finally {
      D.ctxBusy = false;
    }
  }, CFG.POLL_CTX_MS);
}
function stopCtxPoll() {
  if (D.ctxTimer !== null) { clearInterval(D.ctxTimer); D.ctxTimer = null; }
  D.ctxBusy = false;
}

// ---------- 运行计时（1s 本地滴答）：主对话顶栏「本次/累计」+ 子代理行/详情页用时 ----------
/** 运行行的 meta 文案（与 updateDrawerRow 同源——计时滴答就地更新，不整列重渲染）。
 *  docs/11 W2：带上下文占比片段（docs/10 修订记录口径——run 行也显示「上下文 X%」）。 */
function runMetaText(row) {
  return (row.summary ? "… " + row.summary : "运行中") + elapsedPart(row) + ctxPctPart(row);
}
/** docs/11 W2：运行中行数据（上下文/用时）的就地刷新——列表行 meta 文本与详情头部单独
 *  更新，不重建时间线（阅读位置/展开态/滚动全部保持；ctx 轮询消费）。 */
function refreshRowMetaInPlace(row) {
  const metaEl = document.querySelector('#drwList .drwrow[data-sub-id="' + row.subId + '"] .st-meta');
  if (metaEl) metaEl.textContent = runMetaText(row);
  if (drawer.detail === row.subId) renderDetailHead(row);
}
function tickClock() {
  // 主对话：本次 = 当前轮（busy 时 turnStartedAt 起算）；累计 = 存档 runMs + 在飞部分（无双算）
  const cur = C.state.turnStartedAt ? Date.now() - C.state.turnStartedAt : 0;
  const clockEl = $("#clock");
  if (clockEl) {
    clockEl.textContent = C.state.turnStartedAt
      ? "⏱ 本次 " + fmtDur(cur) + " · 累计 " + fmtDur((C.state.runMs || 0) + cur)
      : "⏱ 累计 " + fmtDur(C.state.runMs || 0);
    clockEl.classList.toggle("on", !!C.state.turnStartedAt);
  }
  // 子代理运行中行：按行就地更新 meta 的用时段（保留悬停与滚动状态）
  document.querySelectorAll("#drwList .drwrow.run .st-meta").forEach((metaEl) => {
    const it = metaEl.closest(".drwrow");
    const row = it && drawer.workers.get(Number(it.dataset.subId));
    if (row) metaEl.textContent = runMetaText(row);
  });
  // 详情页头部（运行中才随时间变）
  const drow = drawer.workers.get(drawer.detail);
  if (drow && drow.status === "run") renderDetailHead(drow);
}

function updateDrwBtn() {
  const n = drawer.workers.size;
  const show = C.state.kind === "coordinator" && n > 0;
  const btn = $("#subDrwBtn");
  btn.classList.toggle("hidden", !show);
  if (!show) return;
  const run = [...drawer.workers.values()].filter((r) => r.status === "run").length;
  btn.textContent = "🤖 子代理" + (run > 0 ? " ▶" + run : "") + " · " + n;
  btn.title = "子代理抽屉（" + (run > 0 ? run + " 个运行中" : "无运行中") + "）——点击" + (drawer.open ? "收起" : "展开");
}

/** 列表页：运行中置顶 → 待命（💤）→ 终态按 subId 倒序（docs/9 增 idle 档）；docs/18 起
 *  运行行是 ⏹ 打断按钮（打断即终结，无恢复）；可复用行另有「归档」按钮（idle/run 态显示）。 */
function renderDrawerList() {
  const list = $("#drwList");
  const tier = (r) => (r.status === "run" ? 0 : r.status === "idle" ? 1 : 2);
  const rows = [...drawer.workers.values()].sort((a, b) => tier(a) - tier(b) || b.subId - a.subId);
  if (rows.length === 0) {
    reconcileKeyed(list, [{ key: "empty", make: () => el("div", "sempty", "本会话还没有子代理") }]);
    $("#drwCount").textContent = "";
    return;
  }
  // F3 keyed 化（docs/26 §5，样板=sessionItemNode/updateSessionItem）：subagent 事件高频重灌
  // 不再拆节点重建——排序变化由 reconcileKeyed 移动就位，行内按钮 armed/悬停态自然保留。
  reconcileKeyed(list, rows.map((row) => ({
    key: row.subId,
    make: () => drawerRowNode(row.subId),
    update: (n) => updateDrawerRow(n, row),
  })));
  const run = rows.filter((r) => r.status === "run").length;
  const idle = rows.filter((r) => r.status === "idle").length;
  const ok = rows.filter((r) => r.status === "done").length;
  const err = rows.filter((r) => r.status === "error").length;
  const arch = rows.filter((r) => r.status === "archived").length;
  $("#drwCount").textContent =
    (run ? "▶" + run + " " : "") + (idle ? "💤" + idle + " " : "") + (ok ? "✓" + ok + " " : "") + (err ? "✗" + err + " " : "") + (arch ? "📦" + arch : "");
}
/** 行骨架与事件建时一次（F3）：事件闭包只捕 subId（键= subId 恒定）；⏹/📦 按钮常驻骨架，
 *  可见性由 update 按状态机翻转（hidden 属性——CSS 未覆写 display，有效）。 */
function drawerRowNode(subId) {
  const it = el("div", "drwrow");
  it.dataset.subId = String(subId); // 1s 计时滴答按行就地更新 meta（不整列重渲染）
  it.appendChild(el("span", "st-icon"));
  const main = el("div", "st-main");
  main.appendChild(el("div", "st-name"));
  main.appendChild(el("div", "st-meta"));
  it.appendChild(main);
  it.appendChild(drwCtlBtn(subId));
  it.appendChild(drwArchBtn(subId));
  it.title = "点击查看该子代理过程详情";
  it.addEventListener("click", () => { drawer.detail = subId; renderDrawer(); });
  return it;
}
/** 行状态机视觉刷新（keyed 复用时每轮调用）：类名/图标/名称/meta/⏹📦 可见性。 */
function updateDrawerRow(n, row) {
  const cls = row.status === "run" ? "run" : row.status === "idle" ? "idle" : row.status === "archived" ? "arch" : row.status === "done" ? "ok" : "err";
  n.className = "drwrow " + cls;
  n.querySelector(".st-icon").textContent = row.status === "run" ? "▶" : row.status === "idle" ? "💤" : row.status === "archived" ? "📦" : row.status === "done" ? "✓" : "✗";
  n.querySelector(".st-name").innerHTML = "<b>" + esc(row.name) + '</b> <span class="st-id">#' + Number(row.subId) + "</span>";
  let meta;
  if (row.status === "run") meta = runMetaText(row);
  else if (row.status === "idle") meta = subMetaText(row);
  else if (row.status === "archived" || row.status === "done") meta = subMetaText(row) + (row.transcript ? " · 📄" : "");
  else meta = subMetaText(row);
  const metaEl = n.querySelector(".st-meta");
  metaEl.textContent = meta;
  metaEl.className = "st-meta" + (row.status === "error" ? " err" : "");
  n.querySelector(".drwctl.stop").hidden = row.status !== "run";
  n.querySelector(".drwctl.arch").hidden = !(row.reusable && (row.status === "idle" || row.status === "run"));
}

/** docs/18：⏹ 打断按钮——POST /api/subagent/control（action:"stop"）。打断即终结：一次性
 *  子代理随之归档、可复用转空闲待命（无恢复机制）；行状态由结算事件（error/idle）翻转。 */
function drwCtlBtn(subId) {
  const b = el("button", "drwctl stop", "⏹");
  b.title = "打断该子代理的当前任务（立即中止进行中的请求/工具；一次性随之归档，可复用转空闲待命——没有恢复，继续工作需发新任务）";
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void post("/api/subagent/control", { sessionId: V.viewId, subId, action: "stop" })
      .then((r) => { if (!r.ok || r.data.ok === false) sysLine(r.data.error ?? r.data.message ?? "操作失败", "err"); });
  });
  return b;
}

/** docs/9 归档按钮（可复用行）：空闲立即归档；执行中=中止当前任务后归档（服务端语义）。
 *  与 ⏹ 同一 /api/subagent/control 路由（action:"archive"）；按钮消失由 archived 事件驱动。 */
function drwArchBtn(subId) {
  const b = el("button", "drwctl arch", "📦 归档");
  b.title = "归档该可复用子代理（空闲立即归档；执行中会先中止当前任务）。归档后仅可查看存档，不可再派任务";
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void post("/api/subagent/control", { sessionId: V.viewId, subId, action: "archive" })
      .then((r) => { if (!r.ok || r.data.ok === false) sysLine(r.data.error ?? r.data.message ?? "操作失败", "err"); });
  });
  return b;
}

/** 详情页三态管线（docs/8 第三棒 + docs/9）：完成后有存档 → /api/subagent-transcript 一次性
 *  全程渲染（可复用行存档=跨任务累积全程）；运行中 → 同一 API 轮询实时历史（服务端持有
 *  worker 全量消息，思考/正文/工具与结果全量呈现，刷新/切回零丢失）；完成但落盘失败 →
 *  会话期间积累的工具事件步骤保底。docs/9：idle 行也走存档拉取（服务端优先返回活实例的
 *  全量历史——与磁盘一致或更新）；followup 起跑（task 事件）行翻 run 自动转入轮询。 */
async function renderDrawerDetail() {
  const row = drawer.workers.get(drawer.detail);
  if (!row) { drawer.detail = 0; renderDrawer(); return; }
  drawer.renderSeq++;
  const seq = drawer.renderSeq;
  stopLivePoll();
  if (!drawer.expand || drawer.expand.subId !== row.subId) drawer.expand = { subId: row.subId, explicit: new Map() };
  renderDetailHead(row);
  const note = $("#drwNote"), body = $("#drwBody");
  // 清空前捕获滚动状态：事件（done/idle 等）触发的重渲染据此保持阅读位置；新开详情（空内容）自然贴底
  const keepScroll = scrollStateOf(body);
  // docs/11 W2：同一子代理的重渲染**不预清空**——原先先 innerHTML="" 再异步拉取，空白
  // 窗口里滚动归零、内容闪没（=「跳一下」）；现在旧内容保持到新数据就绪由 rebuildKeepScroll
  // 一次性同步替换。只有换看别的子代理（或换会话）才清空重开（贴底）。
  if (drawer.renderedDetail !== row.subId) {
    body.innerHTML = "";
    keepScroll.pin = true; // 新开详情：无既有阅读位置，贴底跟随
  }
  drawer.renderedDetail = row.subId;
  const running = row.status === "run";
  if (!running && row.transcript) {
    note.textContent = "正在读取全程存档…";
    note.classList.remove("hidden");
    let d;
    try {
      const r = await fetch("/api/subagent-transcript?sessionId=" + encodeURIComponent(V.viewId) + "&subId=" + encodeURIComponent(String(row.subId)));
      d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
    } catch (e) {
      if (seq !== drawer.renderSeq) return;
      note.textContent = "存档读取失败（" + (e instanceof Error ? e.message : "网络错误") + "）——以下为会话期间实时积累的工具事件";
      buildLiveTimeline(row, body, keepScroll);
      return;
    }
    if (seq !== drawer.renderSeq) return;
    if (row.status === "idle") note.textContent = "💤 空闲待命 · 全程历史（含全部已执行任务；新任务由协调者经 agent_followup 派发" + (row.stale ? "；服务重启过，派任务时自动从过程存档唤醒" : "") + "）";
    else if (row.status === "archived") note.textContent = "📦 已归档 · 全程存档（只读——不可再派任务；接续它的工作用 agent_task 重派并让新子代理 read_archive）";
    else note.textContent = "已完成 · 全程存档（任务书 / 思考 / 工具调用与结果 / 报告）";
    rebuildKeepScroll(body, () => {
      const tl = makeTimeline(body, drawer.expand, keepOpenOf(body, keepScroll));
      tl.renderMessages(d.messages || []);
    }, keepScroll);
    return;
  }
  if (running) {
    note.textContent = "实时 · 随服务端进度同步（思考/正文/工具与结果全量；刷新不丢，完成后自动转为全程存档）";
    note.classList.remove("hidden");
    drawer.poll = { subId: row.subId, timer: 0, last: "" };
    await pollLiveDetail(row, seq);
    scheduleLivePoll(row, seq);
    return;
  }
  note.textContent = "无过程存档（落盘失败或未生成）——以下为会话期间实时积累的工具事件";
  note.classList.remove("hidden");
  buildLiveTimeline(row, body, keepScroll);
}

/** 运行中详情页轮询（docs/8 第三棒）：服务端持有 worker 全量历史（activeSubagents 句柄的
 *  liveMessages），每 1.5s 拉一次实时 transcript 整体重渲染（内容无变化不重渲——保留滚动
 *  位置与用户展开态）；done 事件触发详情重渲染自动停轮询（renderSeq 变化）。 */
function stopLivePoll() {
  if (drawer.poll?.timer) clearTimeout(drawer.poll.timer);
  drawer.poll = null;
}
async function pollLiveDetail(row, seq) {
  try {
    const r = await fetch("/api/subagent-transcript?sessionId=" + encodeURIComponent(V.viewId) + "&subId=" + encodeURIComponent(String(row.subId)));
    const d = await r.json().catch(() => ({}));
    if (seq !== drawer.renderSeq || !drawer.poll || drawer.poll.subId !== row.subId) return;
    if (!r.ok) {
      $("#drwNote").textContent = "实时读取失败（" + (d.error ?? "HTTP " + r.status) + "）——稍后自动重试";
      return;
    }
    // docs/10 R1 修订：live 响应带实时上下文占用与运行计时——头部随轮询更新（一直显示）
    if (d.contextPct != null && d.contextPct !== row.contextPct) { row.contextPct = d.contextPct; renderDetailHead(row); }
    if (d.taskStartedAt != null && d.taskStartedAt !== row.taskStartedAt) { row.taskStartedAt = d.taskStartedAt; renderDetailHead(row); }
    if (d.elapsedMs != null && d.elapsedMs !== row.elapsedMs) { row.elapsedMs = d.elapsedMs; renderDetailHead(row); }
    const raw = JSON.stringify(d.messages);
    if (raw === drawer.poll.last) return;
    drawer.poll.last = raw;
    const body = $("#drwBody");
    // 重建保持阅读位置：贴底跟随最新；回看历史则停在原地（新增内容不打扰阅读），
    // 且冻结展开块集（新一轮到达不折叠正在读的内容——高度不骤变，位置才保得住）
    const st = scrollStateOf(body);
    const keep = keepOpenOf(body, st);
    rebuildKeepScroll(body, () => {
      const tl = makeTimeline(body, drawer.expand, keep);
      tl.renderMessages(d.messages || []);
      tl.appendNote("…运行中，随服务端进度刷新");
    }, st);
  } catch { /* 网络抖动：下一轮再试 */ }
}
function scheduleLivePoll(row, seq) {
  if (seq !== drawer.renderSeq || !drawer.poll) return;
  drawer.poll.timer = setTimeout(async () => {
    if (seq !== drawer.renderSeq || !drawer.poll) return;
    await pollLiveDetail(row, seq);
    scheduleLivePoll(row, seq);
  }, CFG.POLL_DETAIL_MS);
}

/** 工具事件步骤流 → 扁平时间线（无存档时的保底视图：subagent tool/toolResult 事件缓存）。
 *  st=外部捕获的滚动状态（重渲染保持阅读位置；缺省现场捕获）。 */
function buildLiveTimeline(row, body, st) {
  rebuildKeepScroll(body, () => {
    const tl = makeTimeline(body, drawer.expand, keepOpenOf(body, st));
    // docs/13：与 renderMessages 同款完成即收起——结果事件已到的工具步骤收起，未到的展开
    const answered = new Set(row.steps.filter((s) => s.phase === "toolResult").map((s) => s.id));
    for (const s of row.steps) {
      if (s.phase === "tool") tl.appendToolCall({ id: s.id, name: s.toolName, arguments: s.preview }, !answered.has(s.id));
      else tl.appendToolResult(s.id, s.output);
    }
    if (row.status === "done" || row.status === "error") tl.appendNote(subMetaText(row));
  }, st);
}

function openDrawer() {
  drawer.open = true;
  drawer.userClosed = false;
  renderDrawer();
}
function closeDrawer() {
  drawer.open = false;
  drawer.max = false; // docs/12 A：收起即退出放大态（重新展开从侧边抽屉开始）
  drawer.userClosed = true;
  renderDrawer();
}
/** docs/12 A：放大态 UI 同步（class + 按钮文案）——renderDrawer 每次幂等调用。 */
function syncDrawerMax() {
  $("#subDrawer").classList.toggle("max", drawer.max);
  const b = $("#drwMax");
  b.textContent = drawer.max ? "⤡ 缩小" : "⛶ 放大";
  b.title = drawer.max ? "缩小：回到侧边抽屉（Esc 同效）" : "放大：子代理详情占满整页";
}
/** docs/12 A：放大/缩小切换——只切 class 不重渲染：DOM 不动、内容零重建，阅读位置与
 *  展开态原样保留（宽度变化的高度重排浏览器自理；贴底跟随者显式送回底部）。 */
function setDrawerMax(on) {
  if (drawer.max === on) return;
  const body = $("#drwBody");
  const pin = !!body && scrollStateOf(body).pin;
  drawer.max = on;
  syncDrawerMax();
  if (pin && body) autoscroll(body);
}
$("#subDrwBtn").addEventListener("click", () => (drawer.open ? closeDrawer() : openDrawer()));
$("#drwClose").addEventListener("click", closeDrawer);
$("#drwBack").addEventListener("click", () => { drawer.detail = 0; renderDrawer(); });
$("#drwMax").addEventListener("click", () => setDrawerMax(!drawer.max));
// Esc 退出放大（docs/12 A）：全屏态盖住了顶栏/输入区，键盘出口保底；抽屉本体保持展开
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawer.max) setDrawerMax(false);
});

// ---------- 子代理过程时间线渲染器（docs/6 P3 方案 A → 需求三 docs/8 §3.2：模态退役，抽屉详情页复用） ----------
/** 通用时间线（transcript 存档与运行中实时轮询共用，扁平单层）：user=气泡；assistant=思考
 *  折叠块 + 正文(mdLite) + 工具调用块；tool=结果按 toolCallId 回填（配对不串块）。
 *  折叠默认态=完成即收起（docs/13，与普通对话同款）：工具块结果到达即折叠（addToolRes
 *  语义），思考块随消息产出定型折叠（endThink 语义）——任意时刻默认展开的只有进行中的块。
 *  expand.explicit 记录用户手动开关，轮询重渲染间保留（key：思考=消息序号，工具=callId
 *  ——存档内稳定）。
 *  docs/11 W2：keepOpen（当前展开块 key 集）非空时回看历史（未贴底）——既有块的展开态
 *  冻结（正在读的块不因完成而塌掉），只有新块按完成即收起规则定态；贴底跟随时
 *  keepOpen=null——新完成的块即时收起（跟随者要的是尾部可读）。 */
function makeTimeline(container, expand, keepOpen) {
  container.innerHTML = "";
  const explicit = expand?.explicit ?? null;
  const callBlks = new Map(); // toolCallId → 调用块（结果回填目标）
  const stick = () => { if (nearBottom(container)) autoscroll(container); };
  const isOpen = (key, defOpen) =>
    explicit && explicit.has(key) ? explicit.get(key) === true : keepOpen ? keepOpen.has(key) : defOpen;
  function thinkBox(g, text, key, defOpen) {
    const box = el("div", "think" + (isOpen(key, defOpen) ? "" : " collapsed"));
    box.dataset.tlKey = key;
    box.innerHTML = '<div class="think-h"><span class="tt">💭 思考 · ' + fmtTok(text.length) + ' 字</span><span class="chev">▾</span></div><div class="think-b"></div>';
    box.querySelector(".think-h").addEventListener("click", () => {
      box.classList.toggle("collapsed");
      if (explicit) explicit.set(key, !box.classList.contains("collapsed"));
    });
    box.querySelector(".think-b").innerHTML = esc(text);
    g.appendChild(box);
  }
  function appendToolCall(tc, defOpen) {
    const key = "c" + String(tc.id ?? tc.name ?? "?");
    const blk = el("div", "tblock" + (isOpen(key, defOpen) ? "" : " collapsed"));
    blk.dataset.tlKey = key;
    blk.innerHTML = '<div class="tblock-h"><b>⚙ ' + esc(tc.name ?? "?") + '</b><code class="tprev">' + esc(firstLine(tc.arguments ?? "")) + '</code><span class="chev">▾</span></div><div class="tblock-b"><pre class="targs"></pre></div>';
    blk.querySelector(".tblock-h").addEventListener("click", () => {
      blk.classList.toggle("collapsed");
      if (explicit) explicit.set(key, !blk.classList.contains("collapsed"));
    });
    blk.querySelector(".targs").textContent = prettyArgs(tc.arguments ?? "");
    if (tc.id) callBlks.set(tc.id, blk);
    container.appendChild(blk);
    stick();
    return blk;
  }
  function appendToolResult(toolCallId, output) {
    const text = String(output ?? "");
    const blk = toolCallId ? callBlks.get(toolCallId) : undefined;
    if (blk) {
      if (toolCallId) callBlks.delete(toolCallId);
      const pre = el("pre", "tres");
      pre.textContent = text.length > CFG.TRUNC_TOOL_FULL ? text.slice(0, CFG.TRUNC_TOOL_FULL) + "\n…（已截断）" : text;
      blk.querySelector(".tblock-b").appendChild(pre);
    } else {
      container.appendChild(el("div", "toolres", "↳ " + esc(text.slice(0, CFG.TRUNC_PREVIEW))));
    }
    stick();
  }
  function renderMessages(messages) {
    if (!messages.length) { container.appendChild(el("div", "sempty", "（无内容）")); return; }
    // docs/13：默认展开规则=完成即收起（与普通对话 addToolRes/endThink 同款）——
    // 工具块结果一到达即折叠；思考块在该消息开始产出正文/工具调用时折叠（=最后一条
    // 消息且尚无正文与调用＝纯思考中才展开）。任意时刻默认展开的只有进行中的块；
    // 原先「最后一条 assistant 组全展开、下一组到达才统一收起」即用户反馈的问题。
    // 回看（未贴底）keepOpen 冻结展开集、手动开关走 explicit——优先级不变。
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    let lastAsst = -1; // 最后一条 assistant 消息（思考块展开判定用）
    messages.forEach((m, i) => { if (m.role === "assistant") lastAsst = i; });
    messages.forEach((m, i) => {
      if (m.role === "user") {
        container.appendChild(el("div", "sb-user", esc(typeof m.content === "string" ? m.content : "")));
      } else if (m.role === "assistant") {
        // 思考块展开条件（endThink 语义）：本消息是最后一条（仍在产出）且尚无正文与工具调用
        const thinkingOnly = i === lastAsst && i === messages.length - 1 && !m.content && !(m.toolCalls && m.toolCalls.length > 0);
        const g = el("div");
        if (m.thinking && m.thinking.text) thinkBox(g, m.thinking.text, "t" + i, thinkingOnly);
        if (m.content) g.appendChild(el("div", "answer", mdLite(m.content)));
        if (g.children.length > 0) container.appendChild(g);
        for (const tc of m.toolCalls ?? []) appendToolCall(tc, tc.id ? !answered.has(tc.id) : false);
      } else if (m.role === "tool") {
        appendToolResult(m.toolCallId, m.content);
      }
    });
  }
  function appendNote(text) {
    container.appendChild(el("div", "sys", esc(text)));
    stick();
  }
  return { renderMessages, appendToolCall, appendToolResult, appendNote };
}

export { drawer, renderDrawer, syncDrawer, resetDrawer, onSubagent, updateDrwBtn, tickClock, refreshSubSum, openDrawer, setDrawerMax };
