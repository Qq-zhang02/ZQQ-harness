// chat.js（docs/26 F4/§6）：主聊天列视图——流式消息渲染（思考/正文/工具块/图片气泡/自动送达
// 折叠气泡）+ 轮折叠 foldTurns + 历史快照渲染 renderHistory + applyState 全量刷新（chatStore
// 订阅者）+ token 明细面板 + refreshSnapshot + 图片预览条 renderImgBar（applyState 的清理路径，
// 故随本模块而非发送管线）。竞态/切换决策在 replay.js、轮折叠决策在 turns.js（F1 纯逻辑层）。
// 依赖方向：dom/state/autoreport/turns/drawer/sidebar；不 import modals/main（被两者消费）。
import { $, el, esc, mdLite, nearBottom, autoscroll, fillOptions, post, renderToolBody } from "./dom.js";
import { splitAutoText as splitAutoTextM, autoReportSummary as autoReportSummaryM, fmtTok, firstLine, prettyArgs } from "./autoreport.js";
import { toolHeadline } from "./toolinfo.js";
import { groupTurns, decideFold } from "./turns.js";
import { CFG, C, V, cacheOf, chatStore, metaOf, ctxLimitOf, imgRules } from "./state.js";
import { drawer, renderDrawer, openDrawer, refreshSubSum, updateDrwBtn, tickClock } from "./drawer.js";
import { renderTree } from "./sidebar.js";

const chat = $("#chat"), input = $("#input"), sendBtn = $("#sendBtn");

// ---------- 消息渲染 ----------
function ensureGroup() {
  if (!C.curGroup) { C.curGroup = el("div", "msg assistant"); chat.appendChild(C.curGroup); }
  return C.curGroup;
}
/** docs/21 §2.4 协议解耦 + docs/26 F1：判别/拆解逻辑在 /app/autoreport.js（前缀作参数），
 *  此处注入 meta 下发的前缀（autoReportPrefix/autoStatusPrefix，单一出处 core/events.ts），
 *  不再正则反推文案；meta 未到返回 null（按普通文本渲染，不写死兜底文案）。 */
const autoPrefixes = () => ({ reportPrefix: metaOf().autoReportPrefix, statusPrefix: metaOf().autoStatusPrefix });
const splitAutoText = (t) => splitAutoTextM(t, autoPrefixes());
function userBubble(text, imgs) {
  finishSegments();
  const m = el("div", "msg user");
  const bubble = el("div", "bubble");
  // docs/16：自动送达的子代理报告/状态通知（作为用户消息开轮）加 🤖 徽标，与真实用户消息区分。
  // docs/18 W2：默认只显示一行摘要（哪个子代理·完成/失败/状态），全文收起、点击展开；
  // 展开后 [[过程档案#N]] 标记与工具结果同款替换为可点的「📄 过程」入口（docs/11 W1）。
  const isReport = splitAutoText(text) != null;
  if (isReport) { renderAutoReportBubble(bubble, text); }
  else if (typeof text === "string" && text.includes("[[过程档案#")) linkifyTranscriptTags(bubble, text);
  else bubble.appendChild(document.createTextNode(String(text)));
  m.appendChild(bubble);
  if (imgs && imgs.length > 0) {
    // docs/10 R3：图片独立 <img> 渲染（data URI，不进 mdLite）；docs/21 §3.2-②——历史档
    // 回放的 mime 先经白名单复验（meta.imageRules.mimes，与上传同一规则），白名单外拒绝渲染。
    const mimes = imgRules()?.mimes;
    const bar = el("div", "msgimgs");
    for (const im of imgs) {
      if (!mimes || !mimes.includes(im.mime)) continue;
      const img = document.createElement("img");
      img.src = "data:" + im.mime + ";base64," + im.data;
      img.alt = "用户图片";
      bar.appendChild(img);
    }
    m.appendChild(bar);
  }
  chat.appendChild(m);
  autoscroll(chat);
}
/** docs/18 W2 + docs/26 F1：摘要提取逻辑在 /app/autoreport.js（任务报告取正文首行、状态通知
 *  截到首个句读），此处注入 meta 前缀；兜底分支仅在 meta 缺失时按报告处理。 */
const autoReportSummary = (text) => autoReportSummaryM(text, autoPrefixes());
/** docs/18 W2：自动送达消息的气泡渲染——🤖 徽标 + 一行摘要（完成=绿/失败=红），全文默认
 *  收起、点击「展开全文」显示（展开后 [[过程档案#N]] 转可点入口）。刷新/切回重渲染同路径。 */
function renderAutoReportBubble(bubble, text) {
  const sp = splitAutoText(text) ?? { status: false, body: String(text ?? "") };
  bubble.appendChild(el("span", "autotag", "🤖 子代理" + (sp.status ? "状态" : "报告") + " · 自动送达"));
  const sum = autoReportSummary(text);
  const sumEl = el("div", "autosum");
  const m = sum.match(/^\[子代理 (.+?) (完成|失败)\](.*)$/);
  if (m) {
    sumEl.append("子代理 " + m[1] + " ");
    sumEl.appendChild(el("b", m[2] === "完成" ? "ok" : "err", m[2] === "完成" ? "✓ 完成" : "✗ 失败"));
    if (m[3]) sumEl.append(m[3]);
  } else {
    sumEl.textContent = sum;
  }
  bubble.appendChild(sumEl);
  const exp = el("a", "autoexp", "展开全文");
  const full = el("div", "autofull");
  full.style.display = "none";
  linkifyTranscriptTags(full, sp.body);
  exp.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const show = full.style.display === "none";
    full.style.display = show ? "" : "none";
    exp.textContent = show ? "收起全文" : "展开全文";
  });
  bubble.appendChild(exp);
  bubble.appendChild(full);
}
/** 新建（或复用）思考框；点击头部折叠/展开；内容区限高滚动，流式时贴底 */
function onReasoningDelta(text) {
  const g = ensureGroup();
  if (!C.curThink) {
    const box = el("div", "think live");
    box.innerHTML = '<div class="think-h"><span class="tt">💭 思考</span><span class="chev">▾</span></div><div class="think-b"></div>';
    // 闭包必须捕获 box 自身，不能引用可变的 C.curThink（轮次结束后会被置 null）
    box.querySelector(".think-h").addEventListener("click", () => box.classList.toggle("collapsed"));
    box._body = box.querySelector(".think-b");
    box._raw = "";
    C.curThink = box;
    g.appendChild(box);
  }
  const stick = nearBottom(C.curThink._body);
  C.curThink._raw += text;
  C.curThink._body.innerHTML = esc(C.curThink._raw);
  if (stick) autoscroll(C.curThink._body);
  if (nearBottom(chat)) autoscroll(chat);
}
function onContentDelta(text) {
  const g = ensureGroup();
  if (!C.curAnswer) { endThink(); C.curAnswer = el("div", "answer"); C.curAnswer._raw = ""; g.appendChild(C.curAnswer); }
  C.curAnswer._raw += text;
  C.curAnswer.innerHTML = mdLite(C.curAnswer._raw);
  if (nearBottom(chat)) autoscroll(chat);
}
/** 思考段结束：停用流式标记、更新字数、自动折叠 */
function endThink() {
  if (C.curThink) {
    C.curThink.classList.remove("live");
    const tt = C.curThink.querySelector(".tt");
    if (tt) tt.textContent = "💭 思考 · " + fmtTok(C.curThink._raw.length) + " 字";
    C.curThink.classList.add("collapsed");
    C.curThink = null;
  }
}
/** 工具调用：生成可折叠块（头部一行摘要 + 展开体），运行中标记 live。
 *  callId 用于把结果精确配对回本块：并行调用、切换会话重放时不会串块或残留"运行中"。
 *  docs/28 P2-3/P2-4：头部摘要经 toolHeadline（pwsh=description、读/写/编辑=动词+文件名——
 *  展开前只看这一行）；展开体经 renderToolBody（write 只显示写入内容、edit 红绿 diff），
 *  其余工具照旧 prettyArgs 参数块。raw=完整参数 JSON（历史路径 tc.arguments / 实时路径
 *  d.args，缺省退 d.preview——截断 JSON 解析失败自动走降级展示）。
 *  （toolBlocks 在 chat 区状态仓 chatStore——F4 起定义在 state.js） */
function addTool(name, raw, callId, pending = true) {
  endThink(); C.curAnswer = null;
  if (callId && C.toolBlocks.has(callId)) return C.toolBlocks.get(callId); // 重复事件（切回重放）：块已存在
  const g = ensureGroup();
  const blk = el("div", "tblock" + (pending ? " live" : ""));
  blk.innerHTML = '<div class="tblock-h"><b>⚙ ' + esc(name) + '</b><code class="tprev">' + esc(toolHeadline(name, raw, raw)) + '</code><span class="tstat"></span><span class="chev">▾</span></div><div class="tblock-b"></div>';
  blk.querySelector(".tblock-h").addEventListener("click", () => blk.classList.toggle("collapsed"));
  const body = blk.querySelector(".tblock-b");
  if (!renderToolBody(body, name, raw, CFG.TRUNC_TOOL_FULL)) {
    const pre = el("pre", "targs");
    pre.textContent = prettyArgs(raw);
    body.appendChild(pre);
  }
  // 需求三（docs/8 §3.2）：agent_task(s) 块不再内嵌时间线/过程盒——块内只留一行摘要 +
  // 块头 🤖 快捷入口，实时过程与回看都进右侧抽屉（数据不依赖本块存活，C.curTool 弱点消除）。
  if (name === "agent_task" || name === "agent_tasks") {
    blk._subtool = true;
    const open = el("span", "subopen", "🤖");
    open.title = "在抽屉中查看子代理实时过程与存档";
    open.addEventListener("click", (ev) => { ev.stopPropagation(); openDrawer(); });
    const h = blk.querySelector(".tblock-h");
    h.insertBefore(open, h.querySelector(".tstat"));
    const sum = el("div", "subsum", "🤖 子代理 · 详情在抽屉中查看");
    sum.title = "点击打开子代理抽屉";
    sum.addEventListener("click", () => openDrawer());
    body.insertBefore(sum, body.firstChild);
    blk._subsum = sum;
    if (pending) refreshSubSum(sum);
  }
  if (callId) C.toolBlocks.set(callId, blk);
  if (!pending) blk.classList.add("collapsed"); // 无结果的调用不显示"运行中"，直接折叠
  g.appendChild(blk);
  C.curTool = pending ? blk : C.curTool;
  autoscroll(chat);
  return blk;
}
/** 工具返回：优先按 callId 找到调用块填入（找不到退回光标 C.curTool），显示 exit 状态与修剪元数据，自动折叠 */
function addToolRes(output, meta, callId) {
  const text = String(output);
  const blk = (callId && C.toolBlocks.get(callId)) || C.curTool;
  if (blk) {
    if (callId) C.toolBlocks.delete(callId);
    else C.curTool = null;
    blk.classList.remove("live");
    const m = /exit code: (-?\d+|unknown)/.exec(text);
    const stat = blk.querySelector(".tstat");
    if (m) {
      stat.textContent = m[1] === "0" ? "✓ exit 0" : "✗ exit " + m[1];
      stat.classList.toggle("bad", m[1] !== "0");
    } else {
      stat.textContent = "✓";
    }
    const body = blk.querySelector(".tblock-b");
    if (meta && (meta.prunedChars > 0 || meta.spilled)) {
      let note = "✂ 入模型已修剪 " + meta.prunedChars.toLocaleString() + " 字符";
      if (meta.spilled) note += " · 完整输出已存盘：" + meta.spilled;
      body.appendChild(el("div", "tres-cap", note));
    }
    body.appendChild(el("div", "tres-cap", "返回结果"));
    const pre = el("pre", "tres");
    linkifyTranscriptTags(pre, text.length > CFG.TRUNC_TOOL_FULL ? text.slice(0, CFG.TRUNC_TOOL_FULL) + "\n…（显示已截断，完整内容已交给模型）" : text);
    body.appendChild(pre);
    // 需求三（docs/8 §3.2）：agent_task(s) 摘要行随结果定格为本批统计——从结果文本自身的
    // 完成/失败行推断（历史/重放渲染走同一 addToolRes 路径，统计不依赖实时事件曾到达）。
    if (blk._subsum) {
      const okN = (text.match(/\[子代理 [^\]]* 完成\]/g) || []).length;
      const errN = (text.match(/\[子代理 [^\]]* 失败\]/g) || []).length;
      if (okN + errN > 0) {
        const parts = [];
        if (okN) parts.push("✓" + okN);
        if (errN) parts.push("✗" + errN);
        blk._subsum.textContent = "🤖 本批 " + (okN + errN) + " 个子代理：" + parts.join(" ") + " · 点击在抽屉中查看";
      } else {
        // docs/16：非阻塞派发——结果即「已派发」回执（完成/失败报告改经自动送达消息进主列），
        // 摘要行定格为本批派发数（历史/重放渲染走同一 addToolRes 路径，统计不依赖实时事件）。
        const dispN = (text.match(/\[子代理 [^\]]* 已派发\]/g) || []).length;
        if (dispN > 0) blk._subsum.textContent = "🤖 已派发 " + dispN + " 个子代理 · 报告完成后自动送达 · 点击在抽屉中查看";
      }
    }
    blk.classList.add("collapsed");
    autoscroll(chat);
  } else {
    ensureGroup().appendChild(el("div", "toolres", "↳ " + esc(text.slice(0, CFG.TRUNC_PREVIEW))));
  }
}
function finishSegments() { endThink(); C.curAnswer = null; C.curTool = null; C.curGroup = null; C.toolBlocks.clear(); }

/** 工具结果文本 → [[过程档案#N]] 标记替换为可点链接（在转义后的安全文本上注入受控 span）。
 *  点击统一进抽屉详情页（需求三：原模态由抽屉取代——随报告入历史，刷新/重放渲染同样可点）。 */
function linkifyTranscriptTags(pre, text) {
  if (!text.includes("[[过程档案#")) { pre.textContent = text; return; }
  pre.innerHTML = esc(text).replace(/\[\[过程档案#(\d+)\]\]/g, (_m, n) =>
    '<span class="sublink" data-subid="' + n + '">📄 过程</span>');
  for (const s of pre.querySelectorAll(".sublink")) {
    s.addEventListener("click", () => {
      drawer.detail = Number(s.dataset.subid);
      if (!drawer.open) openDrawer();
      else renderDrawer();
    });
  }
}

/** 轮次收纳（turnEnd / renderHistory 双路径调用，实时与历史渲染一致）：
 *  把每轮的过程内容——思考、工具与 MCP 调用块、中间文字输出——统统折叠成一个
 *  "🔧 执行过程"可展开条目（复用 .think 折叠样式；展开后工具块仍可各自展开），
 *  每轮的最终回答都保持在外面；foldLatest=false（任务运行中的重渲染）跳过最新轮，
 *  保持实时流可见。已折叠组原样复用（追加新元素、刷新计数），不重复嵌套。
 *  docs/26 F1：轮切分与折叠决策在 /app/turns.js（groupTurns/decideFold，可单测），
 *  此处只做 DOM 搬运。 */
function foldTurns(foldLatest = true) {
  const turns = groupTurns([...chat.children], (k) => k.classList.contains("msg") && k.classList.contains("user"));
  turns.forEach((body, ti) => {
    if (ti === turns.length - 1 && !foldLatest) return;
    const box = body.find((k) => k.classList.contains("ans-fold")) ?? null; // 已有折叠组：复用
    const blocks = []; // 轮体扁平块（既有折叠容器的内容不在其列）
    for (const k of body) {
      if (k === box || !k.classList.contains("msg")) continue;
      blocks.push(...k.children);
    }
    const { fold: toFold } = decideFold(blocks, {
      isAnswer: (c) => c.classList.contains("answer"), // keep=轮内最后一条回答（保持在外）
      isFoldable: (c) => c.classList.contains("think") || c.classList.contains("tblock") || c.classList.contains("answer") || c.classList.contains("toolres"),
    });
    if (toFold.length > 0) {
      const anchor = toFold[0].closest(".msg") ?? toFold[0];
      let box2 = box;
      if (!box2) {
        box2 = el("div", "msg assistant ans-fold"); // 折叠容器自成一组（ans-fold 供后续复用识别）
        const inner = el("div", "think collapsed");
        inner.innerHTML = '<div class="think-h"><span class="tt">🔧 执行过程</span><span class="chev">▾</span></div><div class="think-b"></div>';
        inner.querySelector(".think-h").addEventListener("click", () => inner.classList.toggle("collapsed"));
        box2.appendChild(inner);
        box2._fold = inner;
        anchor.parentNode.insertBefore(box2, anchor);
      }
      for (const c of toFold) box2._fold.lastElementChild.appendChild(c);
      box2.querySelector(".tt").textContent = "🔧 执行过程 · " + box2._fold.lastElementChild.children.length + " 项";
    }
    // 收纳后清空的组移除
    for (const k of body) {
      if (k && k.classList.contains("msg") && k.classList.contains("assistant") && !k.classList.contains("ans-fold") && k.children.length === 0) k.remove();
    }
  });
}

// 历史快照渲染（页面刷新/切换会话后恢复）；助手消息里存档的思考块以折叠态重现（点击头部展开）
function renderHistory(messages) {
  chat.innerHTML = "";
  C.toolBlocks.clear();
  // 预计算：已有结果回填的调用 id 集合 + 最后一条 assistant 的位置。
  // 没有 results 的调用 = 被中断的轮（停止/出错），历史里永远等不到结果，
  // 不能渲染成"运行中"，否则每次打开该会话都永远转圈。
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  let lastAsst = -1;
  messages.forEach((m, i) => { if (m.role === "assistant") lastAsst = i; });
  for (const [i, m] of messages.entries()) {
    if (m.role === "system") continue;
    if (m.role === "user") userBubble(m.content, m.images);
    else if (m.role === "assistant") {
      const g = ensureGroup();
      if (m.thinking && m.thinking.text) addHistoryThink(g, m.thinking.text);
      if (m.content) { const a = el("div", "answer", mdLite(m.content)); g.appendChild(a); }
      for (const tc of m.toolCalls ?? []) {
        // 唯一会显示"运行中"的情形：会话正在运行且该调用位于最后一条 assistant（结果真的还在路上）
        const unanswered = !answered.has(tc.id);
        const pending = C.state.busy === true && i === lastAsst && unanswered;
        const blk = addTool(tc.name, tc.arguments, tc.id, pending);
        if (unanswered && !pending) {
          blk.classList.add("collapsed");
          blk.querySelector(".tblock-b").appendChild(el("div", "tres-cap", "无返回结果（本轮被中断或调用未完成）"));
        }
      }
    } else if (m.role === "tool") {
      addToolRes(m.content, undefined, m.toolCallId);
    }
  }
  finishSegments();
  foldTurns(!C.state.busy); // 任务运行中的重渲染不收纳最新轮（保持实时流可见）；结束后收纳
}
/** 历史思考块：折叠态重现，样式与流式思考框一致（无 live 标记，内容一次性填充） */
function addHistoryThink(g, text) {
  const box = el("div", "think collapsed");
  box.innerHTML = '<div class="think-h"><span class="tt">💭 思考 · ' + fmtTok(text.length) + ' 字</span><span class="chev">▾</span></div><div class="think-b"></div>';
  box.querySelector(".think-h").addEventListener("click", () => box.classList.toggle("collapsed"));
  box._body = box.querySelector(".think-b");
  box._raw = text;
  box._body.innerHTML = esc(text);
  g.appendChild(box);
}

function applyState() {
  $("#modelBadge").textContent = C.state.model;
  $("#kindBadge").classList.toggle("hidden", C.state.kind !== "coordinator"); // 协调者会话徽标（按会话记录）
  updateDrwBtn(); // 需求三：子代理抽屉开关按钮（协调者会话且有 worker 记录才显示）
  renderTree();
  // 先填 option 再设值：首帧 effort/sandbox 才能选中真实档位而非落在「默认」（dev-docs/5 偏差 10）
  renderSettingOptions();
  const csel = $("#confirmSelect");
  csel.value = C.state.askMode === "never" ? "never" : C.state.alwaysConfirm ? "confirm" : "ask";
  csel.disabled = C.state.busy;
  const sel = $("#effortSelect");
  sel.value = C.state.effort;
  sel.disabled = C.state.busy;
  const ssel = $("#sandboxSelect");
  ssel.value = C.state.sandboxMode || "workspace-write";
  ssel.disabled = C.state.busy;
  const noWs = !C.state.workspace;
  input.disabled = noWs;
  sendBtn.disabled = noWs;
  $("#newChatBtn").disabled = noWs; // 后台会话运行不影响开新对话
  $("#newCoordBtn").disabled = noWs;
  $("#wsBrowse").disabled = false;
  const ctxTotal = (C.state.context && C.state.context.total) || 0;
  const limit = ctxLimitOf();
  const pressure = limit > 0 ? ctxTotal / limit : 0;
  const tokEl = $("#tok");
  // 压缩阈值单一出处=服务端 config（随 C.state.meta 下发）；初始 C.state 尚无 meta 时不预警
  const threshold = C.state.meta ? C.state.meta.pressureThreshold : Infinity;
  renderFormatOptions();
  tokEl.innerHTML = "输入 <b>" + fmtTok(C.state.totals.prompt) + "</b> · 输出 <b>" + fmtTok(C.state.totals.completion) +
    "</b> · 上下文 <b" + (pressure >= threshold ? ' style="color:var(--red)" title="上下文占用已达 ' + Math.round(pressure * 100) + '%，建议 /compact 压缩"' : "") + ">" +
    fmtTok(ctxTotal) + "</b>" + (pressure >= threshold ? " ⚠" : "");
  if (!$("#tokPanel").classList.contains("hidden")) renderTokPanel();
  tickClock(); // C.state 快照到达即刻刷新计时（轮起/轮止不必等下一个整秒）
  // W2-L1（docs/7 §2.3）：协调者会话 busy 时发送/停止语义分离——发送仍可用（消息入队，
  // 当前任务结束后处理），停止走独立 ⏹ 按钮；普通会话维持「busy=发送变停止」现状。
  const coordBusy = C.state.busy && C.state.kind === "coordinator";
  sendBtn.textContent = C.state.busy && !coordBusy ? "⏹ 停止" : "发送";
  $("#stopBtn").classList.toggle("hidden", !coordBusy);
  // docs/10 R3：📎 上传按钮只在该会话提供方声明视觉时显示；busy 期隐藏（插话/排队不带图）。
  // 按钮不可见（切会话/切提供方/busy）时清空待发图片——图片只属于发起时的那个会话与那轮。
  // docs/22 §4.1：按钮 title 由 meta.imageRules 插值（HTML 静态 title 仅无 JS 降级）；
  // meta 未到（首帧前，正常不可见）时禁用，规则到达即恢复。
  const imgVisible = C.state.vision === true && !noWs && !C.state.busy;
  const imgR = imgRules();
  $("#imgBtn").classList.toggle("hidden", !imgVisible);
  $("#imgBtn").disabled = imgVisible && !imgR;
  if (imgVisible && imgR) {
    $("#imgBtn").title = "附加图片（当前提供方支持视觉，最多 " + imgR.maxCount + " 张、每张 ≤" + (imgR.maxBytes / 1048576) + "MB；随消息直接发给模型看）";
  }
  if (!imgVisible && C.pendingImages.length > 0) { C.pendingImages = []; renderImgBar(); }
  input.placeholder = noWs
    ? "请先在左侧选择工作区"
    : C.state.busy
      ? coordBusy
        ? "运行中，可直接插话（即时回应，不打断子代理；不适用时排队轮末处理）…（⏹ 可中断）"
        : "任务进行中…（点“停止”可中断）"
      : C.state.kind === "coordinator"
        ? "描述整体目标，协调者将分解任务并派出子代理…（/help 查看命令）"
        : "输入消息，Enter 发送，Shift+Enter 换行（/help 查看命令）";
}
// F2（docs/26 §4）：applyState 从「谁都要记得调」变为 chatStore 订阅者——state 经 set 整替后，
// 微任务统一刷新（同 tick 多次 set 合并为一轮，applyState 幂等全量刷新天然适配）；
// 游标键（curThink 等）不触发。非 state 驱动的刷新点仍显式调用（如 pClose 关模态）。
chatStore.subscribe((c, ks) => { if (ks.has("state")) applyState(); });
/** 提供方表单的"接口格式"选项：由服务端 meta 下发（providers.* 模块注册的 ProviderFormatDef） */
function renderFormatOptions() {
  const list = (C.state.meta && C.state.meta.providerFormats) || [];
  if (list.length === 0) return;
  const sel = $("#pFormat");
  const cur = sel.value;
  sel.innerHTML = list.map((f) => '<option value="' + esc(f.format) + '">' + esc(f.label) + "</option>").join("");
  if (list.some((f) => f.format === cur)) sel.value = cur;
}

// ---------- token 明细面板（点击顶栏用量展开） ----------
function tokRow(label, val) {
  const v = typeof val === "string" ? val : fmtTok(val);
  return '<div class="tokrow"><span>' + label + '</span><b>' + v + '</b></div>';
}
function cacheRatePct(hit, total) {
  return total > 0 && hit > 0 ? Math.min(100, Math.round((hit / total) * 100)) + "%" : "0%";
}
function fmtPct(part, total) {
  if (!(total > 0)) return "0%";
  const p = (part / total) * 100;
  return (p >= 10 ? String(Math.round(p)) : p.toFixed(1)) + "%";
}
function renderTokPanel() {
  const bd = C.state.context && C.state.context.breakdown; // 构成 = 下次请求的单次估算（技能清单/MCP 工具恒定，消息随对话增长）
  const p = $("#tokPanel");
  if (!bd) {
    p.innerHTML = '<div class="tokrow"><span>等待本轮用量数据…</span></div>';
    return;
  }
  const ctxTotal = (C.state.context && C.state.context.total) || 0;
  let h =
    '<h4>Token 构成（下次请求估算；合计为会话累计）</h4>' +
    '<div class="tokrow total"><span>当前上下文（下次请求）</span><b>' +
    fmtTok(ctxTotal) + '（' +
    fmtPct(ctxTotal, ctxLimitOf()) + '）</b></div>' +
    tokRow("系统提示词", bd.systemPrompt) +
    tokRow("技能清单", bd.skills) +
    tokRow("系统工具", bd.systemTools) +
    tokRow("MCP 工具", bd.mcp) +
    tokRow("消息（随对话增长）", bd.messages);
  if (bd.other > 0) h += tokRow("其他", bd.other);
  h += '<div class="tokrow total"><span>输入合计（会话累计）</span><b>' + fmtTok(C.state.totals.prompt) + '</b></div>';
  h += '<div class="tokrow"><span>输出合计（会话累计）</span><b>' + fmtTok(C.state.totals.completion) + '</b></div>';
  if (C.state.totals.cacheHit > 0) h += tokRow("缓存命中率（API 实测）", cacheRatePct(C.state.totals.cacheHit, C.state.totals.prompt));
  if (C.state.totals.reasoning > 0) h += tokRow("其中思考（API 实测，累计）", C.state.totals.reasoning);
  h += '<div class="toknote">「消息」= 对话正文 + 工具调用的参数与结果（技能正文、MCP 查询结果都计入这里）；「技能清单」「MCP 工具」为每次请求固定携带的开销，只随配置增减变化</div>';
  p.innerHTML = h;
}
$("#tok").addEventListener("click", () => {
  renderTokPanel();
  $("#tokPanel").classList.toggle("hidden");
});

/** 拉取当前视图会话的最新快照并整体重渲染 */
async function refreshSnapshot() {
  const r = await post("/api/sessions/load", { id: V.viewId });
  if (!r.ok) return;
  const c = cacheOf(V.viewId);
  chatStore.set({ state: r.data.state });
  renderHistory(r.data.messages);
  c.buf.length = 0;
}

function renderImgBar() {
  const bar = $("#imgBar");
  bar.innerHTML = "";
  bar.classList.toggle("hidden", C.pendingImages.length === 0);
  C.pendingImages.forEach((im, i) => {
    const prev = el("div", "imgprev");
    const img = document.createElement("img");
    img.src = "data:" + im.mime + ";base64," + im.data;
    prev.appendChild(img);
    const del = el("button", "imgdel", "✕");
    del.title = "移除这张图片";
    del.addEventListener("click", () => { C.pendingImages.splice(i, 1); renderImgBar(); });
    prev.appendChild(del);
    bar.appendChild(prev);
  });
}
// ---------- 顶栏选项（applyState 消费；提供方表单的档位/上下文缺省也在此填） ----------

function renderSettingOptions() {
  const m = metaOf();
  fillOptions($("#effortSelect"), m.efforts, (o) => o.label);
  fillOptions($("#sandboxSelect"), m.sandbox, (o) => o.label);
  fillOptions($("#pEffort"), m.efforts, (o) => o.form);
  const pCtx = $("#pCtx");
  if (document.activeElement !== pCtx) pCtx.value = m.defaultContextLength ?? "";
}

export { onReasoningDelta, onContentDelta, addTool, addToolRes, finishSegments, userBubble, foldTurns, renderHistory, applyState, refreshSnapshot, renderImgBar, cacheRatePct, fmtPct };
