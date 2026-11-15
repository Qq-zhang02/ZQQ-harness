// modals.js（docs/26 F4/§6）：三个模态对话框——提供方管理（含视觉模型下拉/表单/连接测试）、
// 运行阈值设置（docs/24 schema 驱动，前端零硬编码）、工作区目录浏览。纯自洽区域：本模块
// **不导出任何符号**——全部事件接线与渲染在模块内完成，main.js 仅按副作用 import 装载。
// （prov/set/recycleOpen 的数据面 psStore 在 state.js——sidebar 的回收站展开也读它，共享故下沉。）
// 依赖方向：dom/state/chat（applyState 刷新徽标、refreshSnapshot 保存阈值后重渲）；不 import main。
import { $, el, esc, reconcileKeyed, sysLine, post } from "./dom.js";
import { PS, C, metaOf, CFG } from "./state.js";
import { applyState, refreshSnapshot } from "./chat.js";

// ---------- 提供方管理 ----------
const provModal = $("#provModal"), provList = $("#provList"), provForm = $("#provForm"),
      provFooter = $("#provFooter"), provErr = $("#provErr");
// （psStore/PS 定义在 state.js——本节注释与建仓语句已随 F4 上移共享状态层）


$("#modelBadge").addEventListener("click", async () => {
  const r = await fetch("/api/providers");
  if (!r.ok) { sysLine("读取提供方失败", "err"); return; }
  PS.provData = await r.json();
  renderVisionSel();
  provShowList();
  provModal.classList.remove("hidden");
});
/** docs/10 R3：视觉模型下拉（view_image 工具用的提供方）——选项 = 勾了视觉能力的提供方；
 *  设置/清空即时 POST（无需保存按钮）。 */
function renderVisionSel() {
  const sel = $("#pVisionSel");
  const cur = PS.provData.visionProvider || "";
  const visions = PS.provData.providers.filter((p) => p.vision === true);
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = visions.length > 0 ? "（未设置——view_image 不可用）" : "（先在表单勾选「视觉能力」）";
  sel.appendChild(none);
  for (const p of visions) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + "（" + p.model + "）";
    sel.appendChild(o);
  }
  sel.value = visions.some((p) => p.id === cur) ? cur : "";
}
$("#pVisionSel").addEventListener("change", async (e) => {
  const r = await post("/api/providers/vision-provider", { id: e.target.value || null });
  if (!r.ok) { sysLine(r.data.error ?? "设置失败", "err"); renderVisionSel(); return; }
  PS.provData.visionProvider = r.data.visionProvider ?? undefined;
});
$("#pClose").addEventListener("click", () => { provModal.classList.add("hidden"); applyState(); });
$("#pAdd").addEventListener("click", () => provShowForm(null));
$("#pCancel").addEventListener("click", provShowList);

function provShowList() {
  PS.provEditing = null;
  provForm.classList.add("hidden");
  provFooter.classList.remove("hidden");
  provErr.textContent = "";
  renderProvList();
}
function renderProvList() {
  if (PS.provData.providers.length === 0) {
    reconcileKeyed(provList, [{ key: "empty", make: () => el("div", "sempty", "暂无提供方，点击下方新增") }]);
    return;
  }
  // F3 keyed 化（docs/26 §5）：模态内操作（激活/设默认/删除）触发的重灌不再拆节点——
  // 删除两步确认的 armed 态不被打断，「用于当前对话/设为默认」按可见性翻转而非增删按钮。
  reconcileKeyed(provList, PS.provData.providers.map((p) => ({
    key: p.id,
    make: provRowNode,
    update: (n) => updateProvRow(n, p),
  })));
}
/** 提供方行骨架与事件建时一次（F3）：事件经节点 _pid 取最新值（编辑在点击时从
 *  PS.provData 现查——不闭包快照，激活后表单数据才是最新）。 */
function provRowNode() {
  const row = el("div", "provrow");
  row.appendChild(el("div", "pinfo"));
  const btns = el("div", "pbtns");
  const use = el("button", "pbtn use", "用于当前对话");
  use.addEventListener("click", async () => {
    const r = await post("/api/providers/activate", { id: row._pid });
    if (!r.ok) { sysLine(r.data.error ?? "切换失败", "err"); return; }
    PS.provData = { active: r.data.active, providers: r.data.providers };
    applyState();
    renderProvList();
  });
  btns.appendChild(use);
  const def = el("button", "pbtn def", "设为默认");
  def.addEventListener("click", async () => {
    const r = await post("/api/providers/set-default", { id: row._pid });
    if (!r.ok) { sysLine(r.data.error ?? "设置失败", "err"); return; }
    PS.provData = { active: r.data.active, providers: r.data.providers };
    renderProvList();
  });
  btns.appendChild(def);
  const edit = el("button", "pbtn", "编辑");
  edit.addEventListener("click", () => {
    const p = PS.provData.providers.find((x) => x.id === row._pid);
    if (p) provShowForm(p);
  });
  btns.appendChild(edit);
  const del = el("button", "pbtn del", "删除");
  del.addEventListener("click", async () => {
    if (del.textContent !== "确认删除") {
      del.textContent = "确认删除";
      setTimeout(() => (del.textContent = "删除"), CFG.CONFIRM_PROV_MS);
      return;
    }
    const r = await post("/api/providers/delete", { id: row._pid });
    if (!r.ok) { sysLine(r.data.error ?? "删除失败", "err"); return; }
    PS.provData = { active: r.data.active, providers: r.data.providers };
    applyState();
    renderProvList();
  });
  btns.appendChild(del);
  row.appendChild(btns);
  return row;
}
/** 提供方行动态刷新（keyed 复用时每轮调用）：当前/默认标签与 cur 类、思考/格式 meta、按钮可见性。 */
function updateProvRow(n, p) {
  n._pid = p.id;
  const isCurrent = p.id === C.state.providerId; // 当前对话正在使用
  const isDefault = p.id === PS.provData.active;  // 新对话的默认提供方
  n.classList.toggle("cur", isCurrent);
  const tags =
    (isCurrent ? '<span class="puse">当前对话</span>' : "") +
    (isDefault ? '<span class="puse">默认</span>' : "") +
    (p.vision === true ? '<span class="puse">👁 视觉</span>' : "") +
    (PS.provData.visionProvider === p.id ? '<span class="puse">👁 视觉模型</span>' : "") +
    (p.effort && p.effort !== "default" ? '<span class="pmeta">思考:' + esc(p.effort) + "</span> " : '<span class="pmeta">思考:默认</span> ');
  n.querySelector(".pinfo").innerHTML =
    '<span class="pname">' + esc(p.name) + '</span> ' + tags +
    '<span class="pmeta">' + esc(p.format) + " · " + esc(p.model) + " · " + esc(p.baseUrl) + "</span>";
  n.querySelector(".pbtn.use").hidden = isCurrent;
  n.querySelector(".pbtn.def").hidden = isDefault;
}
function provShowForm(p) {
  PS.provEditing = p ? p.id : "new";
  provFooter.classList.add("hidden");
  provForm.classList.remove("hidden");
  $("#pName").value = p?.name ?? "";
  // 接口格式清单由服务端 meta 下发（P4 注册制）；缺省取第一个已注册格式
  const fmtSel = $("#pFormat");
  $("#pFormat").value = p?.format || (fmtSel.options[0] ? fmtSel.options[0].value : "");
  $("#pUrl").value = p?.baseUrl ?? "";
  $("#pModel").value = p?.model ?? "";
  $("#pEffort").value = p?.effort ?? "default";
  $("#pKey").value = p?.apiKey ?? "";
  $("#pCtx").value = p?.contextLength ?? metaOf().defaultContextLength ?? "";
  $("#pMax").value = p?.maxTokens ?? "";
  $("#pVision").checked = p?.vision === true;
  provErr.textContent = "";
  provErr.style.color = "";
}
function provCollect() {
  const maxRaw = $("#pMax").value.trim();
  return {
    id: PS.provEditing === "new" ? "" : PS.provEditing,
    name: $("#pName").value.trim(),
    format: $("#pFormat").value,
    baseUrl: $("#pUrl").value.trim(),
    apiKey: $("#pKey").value.trim(),
    model: $("#pModel").value.trim(),
    effort: $("#pEffort").value,
    contextLength: Number($("#pCtx").value) || metaOf().defaultContextLength,
    maxTokens: maxRaw ? Number(maxRaw) : null,
    vision: $("#pVision").checked,
  };
}
$("#pSave").addEventListener("click", async () => {
  const r = await post("/api/providers/save", { provider: provCollect() });
  if (!r.ok) { provErr.textContent = r.data.error ?? "保存失败"; return; }
  PS.provData = { active: r.data.active, providers: r.data.providers };
  provShowList();
});
$("#pTest").addEventListener("click", async () => {
  const btn = $("#pTest");
  btn.disabled = true;
  btn.textContent = "测试中…";
  provErr.textContent = "";
  provErr.style.color = "";
  const r = await post("/api/providers/test", { provider: provCollect() });
  btn.disabled = false;
  btn.textContent = "测试连接";
  if (!r.ok) { provErr.textContent = r.data.error ?? "请求失败"; return; }
  if (r.data.ok) {
    provErr.style.color = "var(--green)";
    provErr.textContent = "✓ 连接成功" + (r.data.sample ? "：" + r.data.sample : "");
  } else {
    provErr.textContent = "✗ " + (r.data.error ?? "连接失败");
  }
});

// ---------- 运行阈值设置（docs/24：schema 驱动，前端零硬编码——范围/说明/默认值/分组全部来自 /api/settings/harness） ----------
const setModal = $("#setModal"), setBody = $("#setBody"), setErr = $("#setErr"), setNote = $("#setNote");
// （setSchema/setDirty 在 prov/set 区状态仓 psStore——F4 起定义在 state.js）

/** 单键行（make 只建骨架+绑事件；初值随构造写入——沿 D3 make-update 纪律） */
function setMakeRow(e, val) {
  const row = el("div", "setrow");
  const left = el("div");
  const name = el("div", "sename");
  name.textContent = e.desc;
  left.appendChild(name);
  const meta = el("div", "sekey");
  meta.textContent = e.key + " · 默认 " + e.def;
  if (e.restart) {
    const flag = el("span", "seflag");
    flag.textContent = "重启后生效";
    meta.appendChild(flag);
  }
  left.appendChild(meta);
  const hint = el("div", "sehint");
  hint.textContent = e.hint;
  left.appendChild(hint);
  row.appendChild(left);
  const input = el("input");
  input.id = "set-" + e.key;
  input.type = "number";
  input.step = e.integer ? "1" : "any";
  if (e.min != null) input.min = e.min;         // 仅含边界映射到输入约束；开边界交给服务端严格校验
  if (e.max != null) input.max = e.max;
  input.addEventListener("input", () => { input.classList.remove("bad"); PS.setDirty = true; });
  input.value = val;
  row.appendChild(input);
  const rst = el("button", "setbtn");
  rst.textContent = "↺";
  rst.title = "恢复默认值（" + e.def + "）";
  rst.addEventListener("click", () => { input.value = e.def; input.classList.remove("bad"); PS.setDirty = true; input.focus(); });
  row.appendChild(rst);
  return row;
}

function setRender(d) {
  const bits = [];
  if (!d.fileExists) bits.push("harness.json 尚不存在，保存时将创建");
  const dis = (d.config && d.config.disabledModules) || [];
  bits.push(dis.length > 0
    ? "已禁用模块（只读）：" + dis.join("、") + "——编辑请直接改 harness.json（重启生效）"
    : "已禁用模块：无");
  bits.push("保存写回纯 JSON，文件里的注释会被移除（值与行为不变）");
  bits.push("保存即热生效（各读取点下一次读取即用新值；正在执行的当轮不受影响）；标注「重启后生效」的键下次启动生效");
  setNote.textContent = bits.join("；") + "。";
  setBody.innerHTML = ""; // 仅清空（无动态内容注入）
  const byGroup = {};
  for (const e of PS.setSchema.entries) {
    (byGroup[e.group] ??= []).push(e);
  }
  for (const g of PS.setSchema.groups) {
    const list = byGroup[g.key] || [];
    if (!list.length) continue;
    const grp = el("div", "setgrp");
    const gh = el("div", "setgh");
    const gname = el("span");
    gname.textContent = g.label;
    gh.appendChild(gname);
    const gbtn = el("button", "setbtn");
    gbtn.textContent = "组内恢复默认";
    gbtn.style.marginLeft = "auto";
    gbtn.addEventListener("click", () => {
      for (const e of list) {
        const inp = document.getElementById("set-" + e.key);
        if (inp) { inp.value = e.def; inp.classList.remove("bad"); }
      }
      PS.setDirty = true;
    });
    gh.appendChild(gbtn);
    grp.appendChild(gh);
    for (const e of list) grp.appendChild(setMakeRow(e, d.effective[e.key]));
    setBody.appendChild(grp);
  }
}

async function openSettings() {
  const r = await fetch("/api/settings/harness");
  if (!r.ok) { sysLine("读取运行阈值失败", "err"); return; }
  const d = await r.json();
  PS.setSchema = d.schema;
  setRender(d);
  setErr.textContent = "";
  PS.setDirty = false;
  setModal.classList.remove("hidden");
  void renderDesktopPrefs(); // DT3-②：桌面版偏好区（Electron 才渲染；失败静默——不影响阈值表单）
}

/** 收集 + 轻校验（整数/含边界 min/max；开边界与服务端严格校验为准——400 会逐键标红） */
function setCollect() {
  const out = { thresholds: {}, bad: [] };
  for (const e of PS.setSchema.entries) {
    const inp = document.getElementById("set-" + e.key);
    const raw = inp ? String(inp.value).trim() : "";
    const n = Number(raw);
    let msg = "";
    if (raw === "" || !Number.isFinite(n)) msg = '"' + e.key + '" 需要一个有效数值';
    else if (e.integer && !Number.isInteger(n)) msg = '"' + e.key + '" 应为整数（' + e.hint + "）";
    else if (e.min != null && n < e.min) msg = '"' + e.key + '" 不应低于 ' + e.min + "（" + e.hint + "）";
    else if (e.max != null && n > e.max) msg = '"' + e.key + '" 不应超过 ' + e.max + "（" + e.hint + "）";
    if (msg) {
      out.bad.push({ key: e.key, message: msg });
      if (inp) inp.classList.add("bad");
    } else {
      out.thresholds[e.key] = n;
    }
  }
  return out;
}

$("#settingsBadge").addEventListener("click", openSettings);
$("#setClose").addEventListener("click", (e) => {
  // 有未保存修改时两步确认（沿「删除→确认删除」先例；native confirm 会阻塞嵌入 webview，不用）
  const btn = e.target;
  if (PS.setDirty && btn.textContent !== "确认关闭") {
    btn.textContent = "确认关闭";
    setTimeout(() => (btn.textContent = "关闭"), CFG.CONFIRM_SET_MS);
    return;
  }
  btn.textContent = "关闭";
  setModal.classList.add("hidden");
});
$("#setResetAll").addEventListener("click", () => {
  for (const e of PS.setSchema.entries) {
    const inp = document.getElementById("set-" + e.key);
    if (inp) { inp.value = e.def; inp.classList.remove("bad"); }
  }
  PS.setDirty = true;
});
$("#setSave").addEventListener("click", async () => {
  setErr.textContent = "";
  const c = setCollect();
  if (c.bad.length > 0) {
    setErr.textContent = c.bad[0].message + (c.bad.length > 1 ? "（共 " + c.bad.length + " 处，已标红）" : "");
    return;
  }
  const r = await post("/api/settings/harness/save", { thresholds: c.thresholds });
  if (!r.ok) {
    const errs = r.data.errors || [];
    for (const e of errs) {
      const inp = e.key ? document.getElementById("set-" + e.key) : null;
      if (inp) inp.classList.add("bad");
    }
    setErr.textContent = r.data.error ?? "保存失败";
    return;
  }
  PS.setDirty = false;
  setModal.classList.add("hidden");
  // 先刷新快照（renderHistory 会整列重建，先出确认行会被它抹掉），完成后再出确认
  void refreshSnapshot().then(() =>
    sysLine("运行阈值已保存并热生效（标注「重启后生效」的键下次启动生效）"),
  );
});

// ---------- 工作区选择弹窗 ----------
const wsModal = $("#wsModal"), wsPath = $("#wsPath"), wsList = $("#wsList"), wsErr = $("#wsErr");
let wsParent = null;
async function browse(p) {
  const r = await fetch("/api/browse?path=" + encodeURIComponent(p));
  const d = await r.json();
  if (!r.ok) { wsErr.textContent = d.error ?? "读取目录失败"; return; }
  wsErr.textContent = "";
  wsParent = d.parent;
  wsPath.value = d.current;
  $("#wsCrumb").textContent = "当前：" + d.current;
  wsList.innerHTML = "";
  if (!d.dirs.length) wsList.appendChild(el("div", null, "<span style='color:var(--dim)'>(无子目录)</span>"));
  for (const name of d.dirs) {
    const item = el("div", null, "📁 " + esc(name));
    item.addEventListener("click", () => browse(d.current + (d.current.endsWith("\\") ? "" : "\\") + name));
    wsList.appendChild(item);
  }
}
$("#wsBrowse").addEventListener("click", () => {
  wsModal.classList.remove("hidden");
  browse(C.state.workspace || "");
});
$("#wsGo").addEventListener("click", () => browse(wsPath.value));
wsPath.addEventListener("keydown", (e) => { if (e.key === "Enter") browse(wsPath.value); });
$("#wsUp").addEventListener("click", () => { if (wsParent) browse(wsParent); });
$("#wsCancel").addEventListener("click", () => wsModal.classList.add("hidden"));
$("#wsOk").addEventListener("click", async () => {
  const r = await post("/api/workspace", { path: wsPath.value });
  if (!r.ok) { wsErr.textContent = r.data.error ?? "切换失败"; return; }
  wsModal.classList.add("hidden");
});

// ---------- DT3-② 桌面版偏好（desktop.json：开机自启；DT3-③ 追加托盘项） ----------
// 仅 Electron 渲染进程展示该区（浏览器模式端点照常可用但无壳消费——纯显示层差异，非行为分叉）；
// 即时生效：checkbox change 直接 POST /api/desktop/save（沿视觉模型下拉先例，不进 setDirty 两步确认），
// 桌面壳侧启动时读 + fs.watch 活应用（desktop/main.mjs）。容器常驻、每次开设置模态时重查重填。
const setDesktopBox = el("div", "setdesk hidden");
$("#setNote").after(setDesktopBox);
async function renderDesktopPrefs() {
  if (!/Electron/.test(navigator.userAgent)) return; // 浏览器模式不显示（壳不在场）
  const r = await fetch("/api/desktop");
  if (!r.ok) return;
  const d = await r.json();
  setDesktopBox.innerHTML = "";
  const head = el("div", "setd-head");
  head.textContent = "🖥 桌面版（desktop.json，改动即时保存）";
  setDesktopBox.appendChild(head);
  setDesktopBox.appendChild(deskRow("开机自启", "随 Windows 登录启动（仅打包版注册；dev 模式只记录不注册）", d.autoStart,
    (v) => post("/api/desktop/save", { autoStart: v })));
  setDesktopBox.appendChild(deskRow("最小化到托盘", "关闭按钮=隐藏到托盘、会话后台继续；双击程序图标或点托盘图标恢复，退出经托盘右键菜单（Win11 图标默认在溢出区 ^ 里；默认关——常驻放大内存占用）", d.tray,
    (v) => post("/api/desktop/save", { tray: v })));
  setDesktopBox.classList.remove("hidden");
}
/** 偏好行：checkbox + 标签 + 说明；change 即存，失败回滚勾选并报错。 */
function deskRow(label, note, checked, save) {
  const row = el("label", "setd-row");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked === true;
  cb.addEventListener("change", async () => {
    const r = await save(cb.checked);
    if (!r.ok) { sysLine(r.data.error ?? "设置失败", "err"); cb.checked = !cb.checked; }
  });
  row.appendChild(cb);
  const txt = el("span");
  txt.textContent = label;
  row.appendChild(txt);
  const nt = el("span", "setd-note");
  nt.textContent = note;
  row.appendChild(nt);
  return row;
}
