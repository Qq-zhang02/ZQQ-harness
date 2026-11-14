import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, sweepStaleSpill } from "./sessions.ts";

function sampleData(id: string) {
  return {
    id,
    title: "测试对话",
    updatedAt: "2026-09-22T10:00:00.000Z",
    workspace: "F:\\proj",
    messageCount: 2,
    messages: [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "你好", toolCalls: [] },
    ],
    totals: { prompt: 10, completion: 5 },
  };
}

test("SessionStore：保存/列表/读取/删除", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    s.save(sampleData("11111111-2222-3333-4444-555555555555"));
    const list = s.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "测试对话");
    const data = s.load("11111111-2222-3333-4444-555555555555");
    assert.ok(data);
    assert.equal(data.messages.length, 2);
    assert.equal(data.totals.prompt, 10);
    s.delete("11111111-2222-3333-4444-555555555555");
    assert.equal(s.list().length, 0);
    assert.equal(s.load("11111111-2222-3333-4444-555555555555"), null);
    assert.equal(readdirSync(join(dir, "sessions")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：assistant.thinking 随存档往返保留（旧存档无此字段天然兼容）", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const d = sampleData("22222222-3333-4444-5555-666666666666");
    d.messageCount = 3;
    (d.messages as unknown[]).push({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "c1", name: "run_pwsh", arguments: "{}" }],
      thinking: { text: "工具前的思考", signature: "sig-abc", model: "claude-x" },
    });
    s.save(d);
    const loaded = s.load("22222222-3333-4444-5555-666666666666");
    assert.ok(loaded);
    const third = loaded.messages[2];
    assert.ok(third && third.role === "assistant");
    if (third.role === "assistant") {
      assert.deepEqual(third.thinking, { text: "工具前的思考", signature: "sig-abc", model: "claude-x" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：非法 id（路径穿越）被拒", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    assert.equal(s.load("../../evil"), null);
    assert.equal(s.load("abc"), null);
    // save 不抛错也不落盘
    s.save({ ...sampleData("../evil"), id: "../evil" });
    assert.equal(s.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：newCurrent 产生新 UUID", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = s.currentId;
    const b = s.newCurrent();
    assert.notEqual(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：手动排序（prepend/setOrder），未排序的按时间排后", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555551";
    const b = "11111111-2222-3333-4444-555555555552";
    const c = "11111111-2222-3333-4444-555555555553";
    for (const [i, id] of [a, b, c].entries()) {
      const d = sampleData(id);
      d.updatedAt = `2026-09-22T10:0${i}:00.000Z`;
      s.save(d);
    }
    // 未拖动：按时间倒序 c, b, a
    assert.deepEqual(s.listWorkspace("F:\\proj").map((x) => x.id), [c, b, a]);
    // 新会话置顶
    const n = "11111111-2222-3333-4444-555555555554";
    s.save({ ...sampleData(n), updatedAt: "2026-09-22T09:00:00.000Z" }); // 时间最早
    s.prependOrder("F:\\proj", n);
    assert.equal(s.listWorkspace("F:\\proj")[0].id, n);
    // 拖动 b 到最前
    s.setOrder("F:\\proj", [b, n]);
    const ordered = s.listWorkspace("F:\\proj").map((x) => x.id);
    assert.equal(ordered[0], b);
    assert.equal(ordered[1], n);
    assert.deepEqual(ordered.slice(2).sort(), [a, c].sort()); // 未排序的按时间在后面
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：回收站（recycle/restore/purge）与列表过滤", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555561";
    const b = "11111111-2222-3333-4444-555555555562";
    s.save(sampleData(a));
    s.save({ ...sampleData(b), workspace: "F:\\other" });
    assert.equal(s.recycleWorkspace("F:\\proj"), 1); // 只回收匹配工作区的
    assert.equal(s.listWorkspace("F:\\proj").length, 0); // 主列表不再显示
    assert.equal(s.listRecycled().length, 1);
    assert.equal(s.listRecycled()[0].id, a);
    // 恢复
    const d = s.restore(a);
    assert.ok(d && !d.recycled);
    assert.equal(s.listRecycled().length, 0);
    assert.equal(s.listWorkspace("F:\\proj").length, 1);
    // 彻底删除
    assert.equal(s.purge(a), true);
    assert.equal(s.list().length, 1);
    assert.equal(s.purge(a), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：删除工作区时手动排序一并清除", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555571";
    const b = "11111111-2222-3333-4444-555555555572";
    s.save(sampleData(a));
    s.save({ ...sampleData(b), workspace: "F:\\other" });
    s.setOrder("F:\\proj", [a]);
    s.setOrder("f:/proj/", [a]); // sameDir 视为同一目录（确认清理按 sameDir 匹配）
    s.setOrder("F:\\other", [b]);
    s.recycleWorkspace("F:\\proj");
    // F:\proj 的排序已清，恢复后 a 按时间排后；F:\other 的排序不受影响
    s.restore(a);
    assert.deepEqual(s.listWorkspace("F:\\proj").map((x) => x.id), [a]);
    assert.deepEqual(s.listWorkspace("F:\\other").map((x) => x.id), [b]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：彻底删除/删除会话连带清理 spill 目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555591";
    const b = "11111111-2222-3333-4444-555555555592";
    s.save(sampleData(a));
    s.save(sampleData(b));
    // 模拟两个会话各有一份超长输出落盘
    const spillA = s.spillDir(a)!;
    mkdirSync(spillA, { recursive: true });
    writeFileSync(join(spillA, "1.txt"), "full output", "utf8");
    mkdirSync(s.spillDir(b)!, { recursive: true });
    writeFileSync(join(s.spillDir(b)!, "1.txt"), "other", "utf8");
    assert.ok(existsSync(join(s.spillRoot, a, "1.txt")));
    // delete：会话文件与 spill 一起消失
    s.delete(a);
    assert.ok(!existsSync(s.spillDir(a)!));
    assert.ok(existsSync(s.spillDir(b)!)); // 其他会话不受影响
    // purge：同样连带清理
    s.purge(b);
    assert.ok(!existsSync(s.spillDir(b)!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：非法 id 不产生 spill 路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    assert.equal(s.spillDir("../../evil"), null);
    assert.equal(s.spillDir("abc"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：removeFromOrder 从所有工作区排序中移除死 id", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555595";
    const b = "11111111-2222-3333-4444-555555555596";
    const c = "11111111-2222-3333-4444-555555555597";
    s.save(sampleData(a));
    s.save({ ...sampleData(b), workspace: "F:\\other" });
    s.save({ ...sampleData(c), workspace: "F:\\other" });
    s.setOrder("F:\\proj", [a, b]); // b 是跨工作区的死条目
    s.setOrder("F:\\other", [b, c]);
    s.removeFromOrder([b]);
    s.delete(b); // 与 server 清扫流程一致：删档 + 清排序
    assert.deepEqual(s.listWorkspace("F:\\proj").map((x) => x.id), [a]);
    assert.deepEqual(s.listWorkspace("F:\\other").map((x) => x.id), [c]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：删除工作区时空占位档直接删除、不进回收站", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const stub = "11111111-2222-3333-4444-555555555598";
    const real = "11111111-2222-3333-4444-555555555599";
    // 空占位：创建即存档的形态（messageCount=0、messages=[]）
    s.save({
      id: stub,
      title: "",
      updatedAt: "2026-09-23T10:00:00.000Z",
      workspace: "F:\\proj",
      messageCount: 0,
      messages: [],
      totals: { prompt: 0, completion: 0 },
    });
    s.save(sampleData(real));
    const moved = s.recycleWorkspace("F:\\proj");
    assert.equal(moved, 1); // 只有真实会话进回收站
    assert.equal(s.load(stub), null); // 空占位被直接删除
    assert.equal(s.load(real)?.recycled, true);
    assert.equal(s.listRecycled().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore：listAllGrouped 按入参顺序分组，孤儿工作区补后", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555581";
    const b = "11111111-2222-3333-4444-555555555582";
    const c = "11111111-2222-3333-4444-555555555583";
    s.save(sampleData(a)); // F:\proj
    s.save({ ...sampleData(b), workspace: "F:\\other" });
    s.save({ ...sampleData(c), workspace: "F:\\ghost", updatedAt: "2026-09-22T09:00:00.000Z" });
    const groups = s.listAllGrouped(["F:\\other", "F:\\proj"]);
    assert.deepEqual(groups.map((g) => g.workspace), ["F:\\other", "F:\\proj", "F:\\ghost"]);
    assert.deepEqual(groups[0].items.map((x) => x.id), [b]);
    assert.deepEqual(groups[1].items.map((x) => x.id), [a]);
    assert.deepEqual(groups[2].items.map((x) => x.id), [c]); // 不在注册表的工作区补在后
    // 回收站的不出现在分组里（F:\ghost 消失；F:\other 仍在入参中不变成孤儿）
    s.recycleWorkspace("F:\\ghost");
    const after = s.listAllGrouped(["F:\\proj", "F:\\other"]);
    assert.deepEqual(after.map((g) => g.workspace), ["F:\\proj", "F:\\other"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- docs/22 §4.2：precompact 环形覆写 + spill 年龄清扫 ----

test("backupBeforeCompact：环形覆写（docs/22 §4.2）——写第 n+1 份前删最老，恒保留最近 PRECOMPACT_KEEP 份", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-precompact-"));
  try {
    const s = new SessionStore(dir);
    const a = "11111111-2222-3333-4444-555555555593";
    s.save(sampleData(a));
    const hist = sampleData(a).messages as never[];
    const names = () =>
      readdirSync(join(dir, "sessions")).filter((f) => f.startsWith(`${a}.precompact-`)).sort();
    for (let i = 0; i < 5; i++) s.backupBeforeCompact(a, hist);
    // 缺省 keep=3：写 #4 时删 #1、写 #5 时删 #2 → 剩 3/4/5
    assert.deepEqual(names(), [`${a}.precompact-3.json`, `${a}.precompact-4.json`, `${a}.precompact-5.json`]);
    // purge（彻底删除）仍连带清理全部备份（既有语义不回归；delete 只清 spill 不清备份）
    s.purge(a);
    assert.deepEqual(names(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleSpill（docs/22 §4.2）：超龄会话 spill 目录整删、新鲜目录保留、根目录不存在静默", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-sess-sweep-"));
  try {
    const s = new SessionStore(dir);
    const old1 = "11111111-2222-3333-4444-555555555594";
    const old2 = "11111111-2222-3333-4444-555555555595";
    const fresh = "11111111-2222-3333-4444-555555555596";
    for (const id of [old1, old2, fresh]) {
      const d = s.spillDir(id)!;
      mkdirSync(join(d, "20260101-120000"), { recursive: true });
      writeFileSync(join(d, "20260101-120000", "transcript.json"), "{}", "utf8");
    }
    // 回拨两个目录的 mtime 到 10 天前（超过缺省 168h）；fresh 保持当前时间
    const stale = new Date(Date.now() - 10 * 24 * 3600_000);
    utimesSync(s.spillDir(old1)!, stale, stale);
    utimesSync(s.spillDir(old2)!, stale, stale);
    sweepStaleSpill(s.spillRoot);
    assert.ok(!existsSync(s.spillDir(old1)!), "超龄目录被整删");
    assert.ok(!existsSync(s.spillDir(old2)!));
    assert.ok(existsSync(join(s.spillDir(fresh)!, "20260101-120000", "transcript.json")), "新鲜目录保留");
    // 根目录不存在 → 静默返回不抛错
    sweepStaleSpill(join(dir, "no-such-spill"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
