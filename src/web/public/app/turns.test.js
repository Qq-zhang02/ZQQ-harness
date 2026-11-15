/** turns.js 测试（docs/26 F1）：user 切轮分组 / 轮折叠决策（keep 最后一条 answer）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { groupTurns, decideFold } from "./turns.js";

/** @param {{ role: string }} m */
const isUser = (m) => m.role === "user";

// ---------- groupTurns：user 气泡切轮 ----------

test("groupTurns：空列表 → 无轮", () => {
  assert.deepEqual(groupTurns([], isUser), []);
});

test("groupTurns：首个 user 之前的项不属任何轮（防御：历史档不应出现）", () => {
  const turns = groupTurns([{ role: "assistant", content: "孤儿" }], isUser);
  assert.equal(turns.length, 0);
});

test("groupTurns：按 user 切轮，user 项自身不入轮体", () => {
  const msgs = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "tool", content: "r1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ];
  const turns = groupTurns(msgs, isUser);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].map((m) => m.content), ["a1", "r1"]);
  assert.deepEqual(turns[1].map((m) => m.content), ["a2"]);
});

test("groupTurns：连续 user（空轮体）与结尾 user（无轮体的开轮）都合法", () => {
  const turns = groupTurns([{ role: "user" }, { role: "user" }, { role: "assistant" }, { role: "user" }], isUser);
  assert.deepEqual(turns.map((t) => t.length), [0, 1, 0]);
});

// ---------- decideFold：执行过程折叠决策 ----------

/** @param {string[]} names */
const cls = (...names) => ({ classes: new Set(names) });
/** @param {{ classes: Set<string> }} b */
const isAns = (b) => b.classes.has("answer");
/** @param {{ classes: Set<string> }} b */
const isFold = (b) => ["think", "tblock", "answer", "toolres"].some((c) => b.classes.has(c));

test("decideFold：keep=轮内最后一条 answer（最终回答保持在外），其余可折叠块全收", () => {
  const blocks = [cls("think"), cls("tblock"), cls("answer"), cls("toolres"), cls("answer")];
  const { keep, fold } = decideFold(blocks, { isAnswer: isAns, isFoldable: isFold });
  assert.equal(keep, blocks[4], "最后一条 answer");
  assert.deepEqual(fold, [blocks[0], blocks[1], blocks[2], blocks[3]]);
});

test("decideFold：不可折叠类（用户气泡 bubble/图片栏 msgimgs）不收", () => {
  const blocks = [cls("bubble"), cls("think"), cls("msgimgs")];
  const { fold } = decideFold(blocks, { isAnswer: isAns, isFoldable: isFold });
  assert.deepEqual(fold, [blocks[1]]);
});

test("decideFold：无 answer（纯工具轮/被打断的轮）→ keep=null，可折叠块全收", () => {
  const blocks = [cls("think"), cls("tblock"), cls("toolres")];
  const { keep, fold } = decideFold(blocks, { isAnswer: isAns, isFoldable: isFold });
  assert.equal(keep, null);
  assert.equal(fold.length, 3);
});

test("decideFold：空轮体 → keep=null、fold=[]（不建空折叠组）", () => {
  assert.deepEqual(decideFold([], { isAnswer: isAns, isFoldable: isFold }), { keep: null, fold: [] });
});

test("decideFold + groupTurns 组合：一轮消息（思考+工具+中间回答+最终回答）的完整折叠计划", () => {
  // 消息 → 块的扁平化由视图层做；这里模拟 renderHistory 产物形态做端到端决策
  const msgs = [
    { role: "user", content: "查一下" },
    { role: "assistant", thinking: "想想", toolCalls: [{ id: "c1" }] },
    { role: "tool", content: "结果" },
    { role: "assistant", content: "中间说明" },
    { role: "assistant", content: "最终回答" },
  ];
  const turns = groupTurns(msgs, isUser);
  assert.equal(turns.length, 1);
  const blocks = [
    cls("think"), cls("tblock"), cls("toolres"), cls("answer"), cls("answer"),
  ];
  const { keep, fold } = decideFold(blocks, { isAnswer: isAns, isFoldable: isFold });
  assert.equal(keep, blocks[4]);
  assert.equal(fold.length, 4);
});
