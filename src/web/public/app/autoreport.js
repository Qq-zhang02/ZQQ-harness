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
