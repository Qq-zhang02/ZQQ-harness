// main.js（docs/26 F4/§6 入口）：会话事件路由 route + SSE 监听表（SSE_HANDLERS）+ 客户端主动
// 切换 switchSession（乒乓防护/缓冲重放决策在 replay.js）+ 斜杠命令表 + 发送/停止/图片上传管线 +
// 审批卡应答 + 顶栏三下拉。index.html 只外链本文件（骨架+CSS 留存）；本文件按副作用 import
// modals.js 完成三个模态的装载。加载顺序 = import 依赖图后序：底层工具/状态先就绪，最后才建
// EventSource 连接与定时器——与拆分前单作用域自上而下的执行序等价。
// 前端 ES 模块（docs/26 F1 起）：纯决策逻辑在 replay/turns/autoreport/store（node:test 可单测），
// 视图分层在 dom/state/drawer/sidebar/chat/modals（F4）；模块间 import 一律相对路径（哨兵锁定）。
import { $, el, esc, sysLine, post, autoscroll, normWs } from "./dom.js";
import { decideRoute, filterByMl, decideFollow } from "./replay.js";
import { fmtTok, fmtDur } from "./autoreport.js";
import { CFG, C, V, chatStore, cacheOf, viewIs, ctxLimitOf, sandboxLabel, imgRules } from "./state.js";
import { onReasoningDelta, onContentDelta, addTool, addToolRes, finishSegments, userBubble, foldTurns, renderHistory, refreshSnapshot, renderImgBar, cacheRatePct, fmtPct, maybeRenderAutoTurn } from "./chat.js";
import { drawer, syncDrawer, resetDrawer, onSubagent, tickClock, setDrawerMax } from "./drawer.js";
import { renderTree, renderRecycle, saveExpanded, T, bindSessionSwitch } from "./sidebar.js";
import "./modals.js";

const chat = $("#chat"), input = $("#input"), sendBtn = $("#sendBtn");

/** 会话事件路由：分支判定在 /app/replay.js decideRoute（可单测），此处只执行动作——
 *  render=视图会话（或无归属）直接渲染；state/usage/turnEnd=后台会话只更新缓存；buffer=进缓冲。 */
function route(evName, d, render) {
  const act = decideRoute(evName, d, { viewId: V.viewId, loading: d && d.sessionId ? cacheOf(d.sessionId).loading : false });
  if (act === "render") { render(d); return; }
  const c = cacheOf(d.sessionId);
  if (act === "state") { c.state = d; c.turn = d.turn ?? null; return; }
  if (act === "usage") { if (c.state) { c.state.totals = d.totals; if (d.context) c.state.context = d.context; } return; }
  if (act === "turnEnd") { c.approval = false; c.turn = null; c.buf.length = 0; return; } // 后台轮结束：服务端历史已完整，清缓冲与锚点
  if (evName === "approval") c.approval = true;
  c.buf.push({ ev: evName, d });
}

// ---------- SSE ----------
function renderCompactionLine(d) {
  void d; // 细节（条数/token 变化）看顶栏上下文数字即可，对话里只留一句确认
  sysLine("上下文已压缩");
}
function showApprovalCard(d) {
  // docs/12 A：审批卡在聊天列里——抽屉放大态盖着它会让会话卡在待批准，自动缩回侧边抽屉
  if (drawer.max) setDrawerMax(false);
  // 子代理来源标注（docs/5 §5.2 C3）：并行 worker 的审批卡标明出自谁（command 前缀同款信息，纯展示更醒目）
  $("#aSub").textContent = d.subagent ? "🤖 来自子代理 " + d.subagent : "";
  $("#aSub").classList.toggle("hidden", !d.subagent);
  $("#aDesc").textContent = d.description ? "📌 " + d.description : "";
  const just = $("#aJust");
  just.textContent = d.justification ? "🧬 模型申请提权：" + d.justification : "";
  just.classList.toggle("hidden", !d.justification);
  $("#aCmd").textContent = d.command;
  $("#aReasons").innerHTML = (d.reasons || []).map((r) => "<li>" + esc(r) + "</li>").join("");
  $("#approval").classList.remove("hidden");
  autoscroll(chat);
  notifyApproval(d);
}
/** DT3-① 审批通知（docs/25 §6，默认开）：审批卡到达且**窗口失焦**时弹系统通知，点击聚焦。
 *  渲染进程 Notification API（Chromium；http://127.0.0.1 是 secure context，零壳代码）；
 *  首张卡触发权限请求（Chromium 弹询问、Electron 默认授予），拒绝/不支持则静默跳过——
 *  通知失败绝不影响审批卡本体。tag 去重：连续多张卡只留最新一条。 */
function notifyApproval(d) {
  try {
    if (typeof Notification === "undefined" || document.hasFocus()) return;
    if (Notification.permission === "default") void Notification.requestPermission();
    if (Notification.permission !== "granted") return;
    const body = (d.subagent ? "🤖 子代理 " + d.subagent + " · " : "") + (d.description || String(d.command ?? "").slice(0, 120) || "一个操作等待批准");
    const n = new Notification("ZQQ-harness 需要审批", { body, tag: "zqq-approval" });
    n.onclick = () => { window.focus(); n.close(); }; // 聚焦回窗口（spec：window.focus() 级即可）
  } catch { /* 权限 API 异常等：静默（卡片本体已显示） */ }
}

const es = new EventSource("/api/events");
// ---------- SSE 处理表（§4.11）：监听注册与缓冲重放共用同一张表；13 个事件名与 core/events.ts 由契约测试锁定 ----------
const SSE_HANDLERS = {
  init(d) {
    if (!V.viewId) V.viewId = d.sessionId; // 首个 init：采纳服务端当前视图
    const c = cacheOf(d.sessionId);
    c.messages = d.messages;
    c.state = d.state;
    c.turn = (d.state && d.state.turn) || null;
    if (d.state && d.state.workspace) { T.wsExpanded.add(normWs(d.state.workspace)); saveExpanded(); }
    if (viewIs(d.sessionId)) { chatStore.set({ state: d.state }); renderHistory(d.messages); syncDrawer(d.state); }
  },
  state(d) { route("state", d, (s) => { chatStore.set({ state: s }); cacheOf(V.viewId).turn = s.turn ?? null; syncDrawer(s); maybeRenderAutoTurn(s.turn); }); },
  delta(d) { route("delta", d, () => { if (d.kind === "reasoning") onReasoningDelta(d.text); else onContentDelta(d.text); }); },
  tool(d) { route("tool", d, () => addTool(d.name, d.args ?? d.preview, d.id)); }, // docs/28 P2-2：args=完整参数（缺省退 preview）
  toolResult(d) { route("toolResult", d, () => addToolRes(d.output, d.meta, d.id)); },
  usage(d) { route("usage", d, () => { C.state.totals = d.totals; if (d.context) C.state.context = d.context; chatStore.set({ state: C.state }); }); },
  info(d) { route("info", d, () => sysLine(d.message, typeof d.message === "string" && d.message.startsWith("📩") ? "queued" : undefined)); },
  compaction(d) { route("compaction", d, () => renderCompactionLine(d)); },
  error(d) { route("error", d, () => sysLine("[出错] " + d.message, "err")); },
  approval(d) { route("approval", d, () => showApprovalCard(d)); },
  turnEnd(d) {
    route("turnEnd", d, () => {
      finishSegments();
      // 收尾清扫：轮已结束，任何仍显示"运行中"的调用块都是等不到结果的（被中断/事件丢失），就地定格
      document.querySelectorAll("#chat .tblock.live").forEach((b) => {
        b.classList.remove("live");
        b.classList.add("collapsed");
        b.classList.add("err"); // 中断的调用=失败形态：与结果错误同款红色标记
        const body = b.querySelector(".tblock-b");
        if (body && !body.querySelector(".tres")) body.appendChild(el("div", "tres-cap", "无返回结果（本轮被中断或调用未完成）"));
      });
      // 轮结束：本轮的思考/工具/MCP 调用/中间文字统统收进"执行过程"折叠条目，只留最终回答展开
      foldTurns();
      $("#approval").classList.add("hidden");
      // 运行中途切进来过的会话：轮结束后拉一次完整快照，补齐切换前丢失的实时片段
      if (cacheOf(V.viewId).needsRefresh) { cacheOf(V.viewId).needsRefresh = false; void refreshSnapshot(); }
    });
  },
  sessions(d) {
    V.lastSessions = d;
    // 服务端切换了视图（新建对话/切工作区/清空）时客户端跟随；乒乓防护决策在 /app/replay.js
    // decideFollow（可单测）：follow=立即切换；defer=客户端主动切换进行中、切换完成后补跟随
    // （带序号防过期）；ignore=过期事件或无视图变更——照常刷新列表。只认"更新的"视图序号：
    // 快速连点时服务端排队广播会携带过期 current 晚到，据此回切会与服务端互相触发（乒乓闪烁）。
    const f = decideFollow(d, { viewId: V.viewId, viewSeqSeen: V.viewSeqSeen, switchingTo: V.switchingTo });
    if (d.viewSeq > V.viewSeqSeen) V.viewSeqSeen = d.viewSeq;
    if (f.type === "follow") { void switchSession(f.id); return; }
    if (f.type === "defer") { V.pendingFollow = { id: f.id, seq: f.seq }; return; }
    renderTree();
    renderRecycle(d.recycled);
  },
  subagent(d) { route("subagent", d, () => onSubagent(d)); },
};
for (const [name, handler] of Object.entries(SSE_HANDLERS)) {
  es.addEventListener(name, (e) => { if (e.data == null) return; handler(JSON.parse(e.data)); });
}
es.onopen = () => {};
es.onerror = () => { /* EventSource 自动重连 */ };

/** 切换正在查看的会话：取服务端快照渲染；后台会话不受影响，仍在运行的任务继续跑
 *  （switchingTo/pendingFollow/viewSeqSeen 三游标在 view 区状态仓 viewStore——F4 起定义在 state.js） */
async function switchSession(id) {
  if (!id || id === V.viewId) return;
  V.switchingTo = id;
  V.viewId = id;
  const c = cacheOf(id);
  c.loading = true;
  finishSegments();
  try {
    const r = await post("/api/sessions/load", { id });
    if (!r.ok) {
      if (V.viewId === id) sysLine(r.data.error ?? "切换失败", "err");
      return;
    }
    c.messages = r.data.messages;
    c.state = r.data.state;
    if (V.viewId !== id) return; // 等待期间用户又点了别的会话：丢弃过期快照
    if (r.data.state && r.data.state.workspace) { T.wsExpanded.add(normWs(r.data.state.workspace)); saveExpanded(); }
    chatStore.set({ state: r.data.state });
    // 需求三（docs/8 §3.4）：抽屉按新会话快照硬重置（完成审计 + 运行中瞬态），
    // 在 renderHistory 之前——工具块的摘要行随建随取新会话统计；切走期间的
    // subagent 缓冲事件随后重放，经 onSubagent 幂等增量进抽屉（不依赖 C.curTool）。
    resetDrawer(C.state);
    // 快照=服务端完整历史（含本轮已完成部分），保证永不空白；
    // 缓冲事件按 ml（发出时历史长度）过滤，只重放"尚未落入快照"的在途流（决策在 /app/replay.js）
    const msgs = r.data.messages || [];
    renderHistory(msgs);
    const buf = filterByMl(c.buf.splice(0), msgs.length);
    for (const item of buf) dispatchBuffered(item);
    c.turn = null;
    c.needsRefresh = !!C.state.busy;
    // applyState 不再显式调：chatStore.set 的订阅在本 handler 结束的微任务里统一刷新（F2）
  } finally {
    c.loading = false;
    if (V.switchingTo === id) V.switchingTo = null;
    const pf = V.pendingFollow;
    if (pf) {
      if (pf.seq !== V.viewSeqSeen) V.pendingFollow = null; // 已被更新的视图事件取代：过期，不再补切
      else if (!V.switchingTo && pf.id !== V.viewId) {
        V.pendingFollow = null;
        void switchSession(pf.id); // 补上切换进行中错过的服务端视图变更
      }
    }
  }
}
/** 按顺序重放缓冲的实时事件（切回运行中的会话时，补回切换期间的全部过程）。
 *  与实时路径共用 SSE_HANDLERS：缓冲项重放时该会话已是当前视图，route 直接落到渲染分支。 */
function dispatchBuffered(item) {
  const handler = SSE_HANDLERS[item.ev];
  if (handler) handler(item.d);
}

// ---------- 斜杠命令表（§4.11）：帮助文案与查表分发同表（COMMANDS）；busy 拦截在 send()。
// 只保留没有 UI 替代入口的命令：思考档位/沙箱/审批策略=顶栏下拉，切工作区/新对话=侧边栏，
// 技能=每轮自动重扫。压缩成功的提示由 SSE compaction 事件统一显示"上下文已压缩"。 ----------
const COMMANDS = new Map([
  ["/help", {
    help: "显示本帮助",
    run() { chat.appendChild(el("div", "helpbox", "<pre>" + esc(helpText()) + "</pre>")); autoscroll(chat); },
  }],
  ["/status", {
    help: "查看模型、工作区、开关状态与 token 累计",
    async run() {
      sysLine(
        "模型 " + C.state.model + " · 工作区 " + (C.state.workspace || "未选择") +
        " · 形态" + (C.state.kind === "coordinator" ? "协调者（仅派子代理）" : "普通") +
        " · 思考" + (C.state.effort === "default" ? "默认" : C.state.effort) +
        " · 审批" + (C.state.askMode === "never" ? "无人值守" : C.state.alwaysConfirm ? "逐条确认" : "正常") +
        " · 沙箱" + sandboxLabel(C.state.sandboxMode) +
        " · MCP " + (C.state.mcpServers && C.state.mcpServers.length ? C.state.mcpServers.join("、") : "未配置") +
        " · 技能 " + (C.state.skills && C.state.skills.length ? C.state.skills.join("、") : "未配置"),
      );
      const audit = C.state.audit;
      if (audit && audit.asked > 0) sysLine("本会话审批 " + audit.asked + " 次（批准 " + audit.allowed + " 次）");
      // 运行计时：busy 时本次（在飞滴答）+ 累计（存档 runMs + 在飞，与顶栏同口径）
      sysLine("⏱ 运行时间 累计 " + fmtDur((C.state.runMs || 0) + (C.state.turnStartedAt ? Date.now() - C.state.turnStartedAt : 0)) +
        (C.state.turnStartedAt ? " · 本次 " + fmtDur(Date.now() - C.state.turnStartedAt) : "（当前空闲）"));
      const subs = C.state.subagents || []; // worker 审计记录（SA4）：次数/成败/用量（已计入顶栏合计）
      if (subs.length > 0) {
        const okN = subs.filter((s) => s.ok).length;
        const uIn = subs.reduce((a, s) => a + ((s.usage && s.usage.prompt) || 0), 0);
        const uOut = subs.reduce((a, s) => a + ((s.usage && s.usage.completion) || 0), 0);
        const uMs = subs.reduce((a, s) => a + (s.elapsedMs || 0), 0);
        sysLine("🎯 子代理 " + subs.length + " 次（成功 " + okN + " / 失败 " + (subs.length - okN) +
          "）· worker 累计输入 " + fmtTok(uIn) + " / 输出 " + fmtTok(uOut) + " tokens" +
          (uMs > 0 ? " · 累计用时 " + fmtDur(uMs) : ""));
      }
      const bd = C.state.context && C.state.context.breakdown; // 下次请求的单次构成（技能/MCP 为固定开销，结果类增长在消息里）
      if (bd) {
        const cache = C.state.totals.cacheHit > 0 ? "（缓存命中率 " + cacheRatePct(C.state.totals.cacheHit, C.state.totals.prompt) + "）" : "";
        const think = C.state.totals.reasoning > 0 ? "（含思考 " + fmtTok(C.state.totals.reasoning) + "）" : "";
        const ctxTotal = (C.state.context && C.state.context.total) || 0;
        sysLine(
          "token 输入 " + fmtTok(C.state.totals.prompt) + cache + " / 输出 " + fmtTok(C.state.totals.completion) + think +
          " · 当前上下文 ≈ " + fmtTok(ctxTotal) + "（" + fmtPct(ctxTotal, ctxLimitOf()) + "）" +
          " ｜ 构成（下次请求估算）：系统提示词 " + fmtTok(bd.systemPrompt) + " · 技能 " + fmtTok(bd.skills) +
          " · 系统工具 " + fmtTok(bd.systemTools) + " · MCP " + fmtTok(bd.mcp) +
          " · 消息 " + fmtTok(bd.messages),
        );
      }
    },
  }],
  ["/compact", {
    help: "压缩会话历史（早期对话折叠为摘要，立即显著降低上下文）",
    async run() {
      const r = await post("/api/compact");
      // 成功不另行提示：服务端 onCompaction 广播（init 重渲染 + compaction 行）已显示"上下文已压缩"
      if (!r.ok) sysLine(r.data.error ?? "压缩失败", "err");
      else if (!r.data.ok) sysLine("压缩未执行：" + (r.data.reason ?? "未知原因") + "（会话未改动）");
    },
  }],
]);
const helpText = () => [...COMMANDS.entries()].map(([cmd, c]) => cmd.padEnd(21) + c.help).join("\n");

async function handleCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const def = COMMANDS.get(cmd);
  if (!def) { sysLine("未知命令 " + cmd + "，/help 查看可用命令", "err"); return; }
  await def.run((parts[1] ?? "").toLowerCase(), text.slice(cmd.length).trim());
}

// ---------- 发送 / 停止 ----------
// 图片上传（docs/10 R3）：C.pendingImages 持有待发图片（chat 区状态仓 chatStore，F4 起在 state.js）；
// 显示条件 = 当前提供方声明视觉能力（C.state.vision，随 C.state 下发）。
$("#imgBtn").addEventListener("click", () => $("#imgFile").click());

/** 图片入列公共管线（📎 选文件与 Ctrl+V 粘贴共用）：数量/格式/大小校验 + base64 读取 + 预览。 */
async function addImageFiles(files) {
  for (const f of files) {
    const r = imgRules();
    if (!r) { sysLine("服务端配置未就绪，请稍候重试", "err"); break; }
    if (C.pendingImages.length >= r.maxCount) { sysLine("一次最多携带 " + r.maxCount + " 张图片", "err"); break; }
    if (!r.mimes.includes(f.type)) { sysLine("不支持的图片格式：" + (f.type || "未知") + "（支持 PNG/JPEG/GIF/WEBP）", "err"); continue; }
    if (f.size > r.maxBytes) { sysLine("图片 " + (f.name || "（剪贴板）") + " 超过 " + (r.maxBytes / 1048576) + "MB 上限", "err"); continue; }
    const data = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] || "");
      fr.onerror = () => res("");
      fr.readAsDataURL(f);
    });
    if (data) C.pendingImages.push({ mime: f.type, data });
  }
  renderImgBar();
}
$("#imgFile").addEventListener("change", async () => {
  const files = [...$("#imgFile").files];
  $("#imgFile").value = "";
  await addImageFiles(files);
});
// 粘贴贴图（docs/12 R2）：Ctrl+V 截图直接进预览条——与 📎 同一校验管线；纯文本粘贴不受影响。
// 门控与 📎 按钮一致（当前提供方声明视觉才可带图——无视觉端点收多模态会 400）。
input.addEventListener("paste", (e) => {
  if (C.state.vision !== true) return; // 无视觉：不拦粘贴（文本照常），也不收图
  const files = [...(e.clipboardData?.items ?? [])]
    .filter((it) => it.kind === "file" && (imgRules()?.mimes ?? []).includes(it.type))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return; // 无图片：走默认粘贴行为
  e.preventDefault();
  void addImageFiles(files);
});

async function send() {
  if (C.state.busy) {
    if (input.value.trim().startsWith("/")) { sysLine("当前对话任务运行中，斜杠命令暂不可用", "err"); return; }
    if (C.state.kind === "coordinator") {
      if (C.pendingImages.length > 0) { sysLine("运行中插话不支持图片——请等本轮完成后发送", "err"); return; }
      // W2-L2（docs/8 §1.3.4）：协调者运行中消息优先 interim 即时应答（服务端流式回 delta，
      // 轮末合并进历史并广播 init 重渲染）；不适用时服务端落 📩 队列、轮末处理。
      // 气泡统一乐观本地渲染：POST 响应要等 interim chat 完成才返回，而流式 delta 先到，
      // 气泡必须先画才能给回应提供上下文；queued 场景气泡先补位（停留视图期间没有 init
      // 重建它，无重复风险；轮末消费后消息进历史，刷新/切回由快照对齐）。
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      autosize();
      userBubble(text);
      const r = await post("/api/chat", { text });
      if (!r.ok) sysLine(r.data.error ?? "发送失败", "err");
      return;
    }
    await post("/api/stop", { sessionId: V.viewId });
    return;
  }
  const text = input.value.trim();
  if (!text && C.pendingImages.length === 0) return;
  if (!text) { sysLine("请同时输入文字说明（图片需要文字提问）", "err"); return; }
  const images = C.pendingImages.length > 0 ? C.pendingImages.map(({ mime, data }) => ({ mime, data })) : undefined;
  input.value = "";
  autosize();
  if (text.startsWith("/")) { void handleCommand(text); return; }
  C.pendingImages = [];
  renderImgBar();
  userBubble(text, images);
  const r = await post("/api/chat", { text, ...(images ? { images } : {}) });
  if (!r.ok) {
    sysLine(r.data.error ?? "发送失败", "err");
    if (images) { C.pendingImages = images; renderImgBar(); } // 失败退回预览条，不丢图
  }
}
$("#stopBtn").addEventListener("click", () => void post("/api/stop", { sessionId: V.viewId }));
sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, CFG.INPUT_MAX_H) + "px"; }
input.addEventListener("input", autosize);

// ---------- 批准 ----------
function answerApproval(decision) {
  $("#approval").classList.add("hidden");
  const c = cacheOf(V.viewId);
  c.approval = false;
  c.buf = c.buf.filter((x) => x.ev !== "approval"); // 已决议的卡不再随缓冲重放
  void post("/api/approval", { decision, sessionId: V.viewId });
}
$("#aYes").addEventListener("click", () => answerApproval("allowed-once"));
$("#aNo").addEventListener("click", () => answerApproval("rejected"));

// ---------- 设置 ----------
// 审批策略按当前对话记录：正常=敏感操作弹卡；逐条确认=所有命令与写入都弹卡；无人值守=不弹卡直接拒绝
$("#confirmSelect").addEventListener("change", async (e) => {
  const v = e.target.value;
  const body = v === "never" ? { askMode: "never", alwaysConfirm: false }
    : v === "confirm" ? { askMode: "ask", alwaysConfirm: true }
    : { askMode: "ask", alwaysConfirm: false };
  const prev = C.state.askMode === "never" ? "never" : C.state.alwaysConfirm ? "confirm" : "ask";
  const r = await post("/api/settings", body);
  if (!r.ok) {
    sysLine(r.data.error ?? "设置失败", "err");
    e.target.value = prev;
  }
});
// 思考档位按当前对话记录：切换会写进会话存档；提供方表单里的档位只是新对话的初始值
$("#effortSelect").addEventListener("change", async (e) => {
  const prev = C.state.effort;
  const r = await post("/api/settings", { effort: e.target.value });
  if (!r.ok) {
    sysLine(r.data.error ?? "设置失败", "err");
    e.target.value = prev;
  }
});
// 沙箱模式按当前对话记录：受约束模式在无后端时 fail-closed（命令返回 SANDBOX_UNAVAILABLE）
$("#sandboxSelect").addEventListener("change", async (e) => {
  const prev = C.state.sandboxMode;
  const r = await post("/api/settings", { sandboxMode: e.target.value });
  if (!r.ok) {
    sysLine(r.data.error ?? "设置失败", "err");
    e.target.value = prev;
  }
});

// ---------- 装载收尾（原内联 script 中段的顶层接线，F4 归入口统一持有） ----------
setInterval(tickClock, CFG.CLOCK_TICK_MS); // 1s 运行计时滴答（tickClock 在 drawer.js）
bindSessionSwitch(switchSession);          // 会话切换回调注入 sidebar（无环接线，见其文件头）
