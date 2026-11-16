// dom.js（docs/26 F4/§6 大分区拆文件）：跨分区共享的视图层底层工具——DOM 建造/转义/滚动/
// keyed 重排原语 + 少量无 DOM 的通用助手（post/normWs/fillOptions）与系统行。
// 依赖方向：本模块只向下 import 纯逻辑模块（toolinfo → autoreport，docs/28 P2-3），不 import
// 任何视图/状态模块（chat/drawer 经 renderToolBody 共用工具块渲染，无环）；被其余六模块消费。
// 纯逻辑模块（replay/turns/autoreport/store/toolinfo）禁 DOM 的哨兵不覆盖本文件——视图层天然碰 DOM。
import { toolBodyBlocks } from "./toolinfo.js";
export const $ = (s) => document.querySelector(s);
// ---------- 基础工具 ----------
function el(tag, cls, trustedHtml) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  // 第三参是**已信任的 HTML**（docs/21 §3.2-②）：动态内容必须先 esc()（或走 mdLite——内部先 esc），
  // 仅静态文案/受控标记可直接写；新代码优先不传第三参、用 textContent。
  if (trustedHtml != null) e.innerHTML = trustedHtml;
  return e;
}
/** HTML 转义（docs/21 §3.2-②）：含引号（属性注入面）；所有 innerHTML 拼接的动态内容必经此函数。 */
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function mdLite(s) {
  const blocks = [];
  let h = esc(s).replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (m, c) => {
    blocks.push(c);
    return "\x00" + (blocks.length - 1) + "\x00";
  });
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\n/g, "<br>");
  h = h.replace(/\x00(\d+)\x00/g, (m, i) => "<pre><code>" + blocks[+i] + "</code></pre>");
  return h;
}
function nearBottom(elm) { return elm.scrollHeight - elm.scrollTop - elm.clientHeight < 48; }
function autoscroll(elm) { return (elm.scrollTop = elm.scrollHeight); }
/** 捕获滚动状态（重建前调用）：pin=贴底跟随最新（尚无可滚内容视为贴底——新开详情落在底部）。 */
function scrollStateOf(c) { return { pin: c.scrollHeight <= c.clientHeight + 8 || nearBottom(c), top: c.scrollTop }; }
/** 按捕获状态重建内容：贴底 → 继续贴底；否则恢复原 scrollTop（轮询/重渲染新增内容不打扰
 *  正在回看历史的位置——innerHTML 重建后 scrollTop 归零，必须显式还原才不"跳回顶部"）。 */
function rebuildKeepScroll(c, build, st) {
  const s = st ?? scrollStateOf(c);
  build();
  if (s.pin) autoscroll(c);
  else c.scrollTop = s.top;
}
/** docs/11 W2：采集时间线当前展开块的 key 集（[data-tl-key] 且未折叠）——重建前调用。
 *  回看历史（未贴底）时传给 makeTimeline 冻结展开态：新一轮到达不再折叠「上一个最后组」，
 *  内容高度不骤变，scrollTop 恢复才有意义（否则位置被浏览器钳到新高度内=跳变）。 */
function harvestOpenKeys(c) {
  const keys = new Set();
  c.querySelectorAll("[data-tl-key]").forEach((b) => {
    if (!b.classList.contains("collapsed")) keys.add(b.dataset.tlKey);
  });
  return keys;
}
/** docs/11 W2：回看（未贴底）→ 冻结展开块集；贴底跟随 → null（维持尾部推进默认态）。 */
function keepOpenOf(c, st) {
  return (st ?? scrollStateOf(c)).pin ? null : harvestOpenKeys(c);
}

/** 聊天列系统行（信息/错误提示）。F4 拆分前直接引用入口的 chat 常量；现现场查询——
 *  #chat 是 index.html 骨架里的静态元素，查询结果恒同节点（非热路径，无谓缓存）。 */
function sysLine(text, cls) {
  const chat = $("#chat");
  chat.appendChild(el("div", "sys" + (cls ? " " + cls : ""), esc(text)));
  autoscroll(chat);
}

/** 重填 option 并保留当前选中值；meta 未到达（list 空）时不动 DOM */
function fillOptions(sel, list, getLabel) {
  if (!list || list.length === 0) return;
  const cur = sel.value;
  sel.innerHTML = list.map((o) => '<option value="' + esc(o.value) + '">' + esc(getLabel(o)) + "</option>").join("");
  if (list.some((o) => o.value === cur)) sel.value = cur;
}

function normWs(p) { return String(p || "").toLowerCase().replace(/[\\/]+$/, ""); }

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

/** keyed 重排（docs/21 §3.2-④ D3）：按新 key 序列复用旧子节点——已存在的按新顺序移动并交
 *  update 刷新动态部分，新增的调 make 建骨架（make 只负责静态结构+事件，数据由 update 回填），
 *  消失的移除。key 同批唯一；节点经 _key 认领。事件监听器建时绑定一次（keyed 复用不再重灌），
 *  随快照变化的数据由 update 写到节点字段（_sid 等），事件里读节点字段、不闭包旧快照。 */
function reconcileKeyed(parent, entries) {
  const old = new Map();
  for (const n of [...parent.childNodes]) if (n._key !== undefined) old.set(n._key, n);
  let cursor = null; // 已就位的最末节点：后续项都应排在它后面
  const used = new Set();
  for (const e of entries) {
    let n = old.get(e.key);
    if (n) used.add(e.key);
    else { n = e.make(); n._key = e.key; }
    if (e.update) e.update(n);
    const ref = cursor ? cursor.nextSibling : parent.firstChild;
    if (n !== ref) parent.insertBefore(n, ref); // DOM 位置与数据序同步（移动即重排，不重建）
    cursor = n;
  }
  for (const [k, n] of old) if (!used.has(k)) n.remove();
}

/** 工具块展开体渲染（docs/28 P2-3/P2-4）：write_file=只显示写入内容、edit_file=红绿 diff
 *  （old_string 行红-、new_string 行绿+，附 occurrence/replace_all 注记）；其他工具/参数不可
 *  解析 → 返回 false（调用方按现状渲染 prettyArgs 参数块）。chat.js addTool 与 drawer.js
 *  makeTimeline 共用；trunc=单块文本显示截断上限（调用方传 CFG.TRUNC_TOOL_FULL）。 */
function renderToolBody(container, name, argsRaw, trunc) {
  const blocks = toolBodyBlocks(name, argsRaw);
  if (!blocks) return false;
  for (const b of blocks) {
    if (b.type === "note") {
      container.appendChild(el("div", "tres-cap", "📌 " + b.text));
    } else if (b.type === "content") {
      const cap = el("div", "tres-cap", b.cap || "写入内容"); // cap：write=写入内容 / pwsh=命令（toolinfo 定制）
      const pre = el("pre", "tres wbody");
      pre.textContent = b.text.length > trunc ? b.text.slice(0, trunc) + "\n…（显示已截断）" : b.text;
      container.appendChild(cap);
      container.appendChild(pre);
    } else if (b.type === "diff") {
      if (b.note) container.appendChild(el("div", "tres-cap", "📌 " + b.note));
      const box = el("div", "tdiff");
      const clip = (t) => (t.length > trunc ? t.slice(0, trunc) + "\n…（显示已截断）" : t);
      for (const line of clip(b.oldText).split("\n")) box.appendChild(el("div", "dl", "-" + line));
      for (const line of clip(b.newText).split("\n")) box.appendChild(el("div", "al", "+" + line));
      container.appendChild(box);
    }
  }
  return true;
}

export { el, esc, mdLite, nearBottom, autoscroll, scrollStateOf, rebuildKeepScroll, harvestOpenKeys, keepOpenOf, sysLine, fillOptions, normWs, post, reconcileKeyed, renderToolBody };
