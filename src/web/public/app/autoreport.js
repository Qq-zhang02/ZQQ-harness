/**
 * 自动送达消息解析与通用格式化（docs/26 F1，自 index.html 抽出）：送达前缀作参数传入
 * （调用方从 state.meta 下发取——协议契约单一出处 core/events.ts 不变，前端不写死文案）。
 * 全部纯函数，禁 DOM 全局引用（可测性边界，契约测试哨兵锁定）。
 */

/** 自动送达前缀对（调用方从 meta 下发取：autoReportPrefix / autoStatusPrefix；meta 未到为 null/缺省）。 @typedef {{ reportPrefix?: string | null, statusPrefix?: string | null }} AutoPrefixes */

/**
 * 自动送达消息判别/拆解（docs/21 §2.4 协议解耦的数据版）：报告前缀/状态前缀任一命中返回
 * 拆解体（status 标记是状态通知还是任务报告），否则 null（按普通文本渲染，不写死兜底文案）。
 * 前缀缺失（meta 未到）一律 null——与首帧前的降级行为一致。
 * @param {unknown} t 消息文本
 * @param {AutoPrefixes} p 前缀对
 * @returns {{ status: boolean, body: string } | null}
 */
export function splitAutoText(t, p) {
  if (typeof t !== "string" || p.reportPrefix == null || p.statusPrefix == null) return null;
  if (t.startsWith(p.reportPrefix)) return { status: false, body: t.slice(p.reportPrefix.length).replace(/^\n?/, "") };
  if (t.startsWith(p.statusPrefix)) return { status: true, body: t.slice(p.statusPrefix.length).replace(/^\n?/, "") };
  return null;
}

/** 正则元字符转义（送达前缀含 `[` `]` 等，行首匹配构造用）。 @param {string} s @returns {string} */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 服务端轮末合并的多份送达消息拆段（docs/16：协调者忙碌期间积压的报告在轮末把连续的
 * 自动送达消息合并为一条 user 消息开一轮——界面渲染层把合并文本拆回每份一张独立卡片，
 * 真机待办：合并消息此前挤在一个气泡里，一行摘要只见第一份）。
 * 切段锚点 = 「行首的送达前缀」（报告/状态任一；段正文不含行首前缀，行中出现的字样不拆）；
 * 段尾的合并分隔线（U+2015 横线行）与空白一并清理。单条（无后续行首前缀）、非送达文本、
 * 前缀缺失（meta 未到）返回 null——调用方按单卡/普通文本渲染，行为不变。
 * @param {unknown} text 消息全文（畸形输入防御：非字符串经 splitAutoText 一律 null）
 * @param {AutoPrefixes} p 前缀对
 * @returns {string[] | null} ≥2 段的送达消息数组（每段仍以送达前缀开头）
 */
export function splitAutoTextSegments(text, p) {
  if (typeof text !== "string") return null;
  const rp = p && typeof p.reportPrefix === "string" ? p.reportPrefix : null;
  const sp = p && typeof p.statusPrefix === "string" ? p.statusPrefix : null;
  if (rp == null || sp == null || splitAutoText(text, p) == null) return null;
  const re = new RegExp("\\n(?:" + escapeRegExp(rp) + "|" + escapeRegExp(sp) + ")", "g");
  const cuts = [];
  let m;
  while ((m = re.exec(text)) !== null) cuts.push(m.index + 1); // 越过 \n → 段起点
  if (cuts.length === 0) return null;
  const bounds = [0, ...cuts, text.length];
  const segs = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const seg = text.slice(bounds[i], bounds[i + 1]).replace(/\u2015{2,}\s*$/, "").replace(/\s+$/, "");
    if (seg) segs.push(seg);
  }
  return segs.length >= 2 ? segs : null;
}

/**
 * 自动送达消息的一行摘要（docs/18 W2）：任务报告取正文首行（[子代理 X 完成/失败] 行本身
 * 就是自带统计的一行摘要）；状态通知（单长行）截到首个句读为止，超 60 字加省略号。
 * 前缀拆解走 splitAutoText；兜底分支仅在 meta 缺失时按报告处理。
 * @param {string} text 消息全文
 * @param {AutoPrefixes} p 前缀对
 * @returns {string}
 */
export function autoReportSummary(text, p) {
  const sp = splitAutoText(text, p) ?? { status: false, body: String(text ?? "") };
  const line = sp.body.split("\n", 1)[0].trim();
  if (sp.status) {
    const m = line.match(/^(.+?[：:。])/);
    return m ? m[1] : line.slice(0, 60) + (line.length > 60 ? "…" : "");
  }
  return line;
}

/** 压缩空白后的首行片段（工具调用命令摘要预览）。 @param {string} s @returns {string} */
export function firstLine(s) {
  return s.replace(/\s+/g, " ").slice(0, 100);
}

/** 工具参数 JSON 美化（非法 JSON 原样返回）。 @param {string} raw @returns {string} */
export function prettyArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** token 数人类可读（≥1 万显示 x.xk）。 @param {number} n @returns {string} */
export function fmtTok(n) {
  return n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

/** 毫秒 → 人类可读时长（<1m 秒；<1h 分秒；≥1h 时分）。 @param {number} ms @returns {string} */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
}
