/**
 * 轮分组与折叠决策（docs/26 F1，foldTurns 的数据版）：每轮 = user 项开轮、其后各项为轮体；
 * 折叠决策 = 轮体扁平块中「最后一条 answer 类块保持在外（每轮最终回答），其余可折叠类块
 * 收进执行过程」。DOM 搬运留在视图层（index.html 的 foldTurns 变薄后调用这里）。
 * 谓词作参数传入（消息数组与 DOM 子元素同一套决策）；全部纯函数，禁 DOM 全局引用。
 */

/**
 * 按 user 项切轮（foldTurns 轮结构构建的数据版）。
 * @template T
 * @param {T[]} items 有序列表（消息数组 / chat 子元素等任意项）
 * @param {(item: T) => boolean} isUserStart 项是否开启新轮（消息版 role==="user"；DOM 版 classList 含 msg+user）
 * @returns {T[][]} 每轮的轮体（user 项自身不入轮体；首个 user 之前的项不属任何轮，忽略）
 */
export function groupTurns(items, isUserStart) {
  const turns = [];
  /** @type {T[] | null} */
  let cur = null;
  for (const k of items) {
    if (isUserStart(k)) {
      cur = [];
      turns.push(cur);
    } else if (cur) cur.push(k);
  }
  return turns;
}

/**
 * 折叠决策：keep = 轮内最后一条 answer 类块（保持在外）；fold = 其余命中可折叠谓词的块
 * （think/tblock/answer/toolres 类——思考、工具与 MCP 调用块、中间文字、工具结果）。
 * @template T
 * @param {T[]} blocks 轮体扁平块列表（既有折叠容器 ans-fold 的内容不在其列——调用方排除）
 * @param {{ isAnswer: (b: T) => boolean, isFoldable: (b: T) => boolean }} p 分类谓词
 * @returns {{ keep: T | null, fold: T[] }}
 */
export function decideFold(blocks, p) {
  let keep = null;
  for (const b of blocks) if (p.isAnswer(b)) keep = b;
  return { keep, fold: blocks.filter((b) => b !== keep && p.isFoldable(b)) };
}
