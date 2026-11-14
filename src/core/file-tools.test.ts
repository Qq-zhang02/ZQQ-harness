/**
 * core/file-tools.ts 测试：路径解析、已读台账键、EOL 归一、二进制嗅探、原子写、
 * 精确编辑（含 CRLF 还原）与写入裁决矩阵（read-file/write-file/edit-file 三模块的共享机制）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjudicateWrite,
  applyEol,
  applyEdit,
  createFileLedger,
  detectEol,
  ledgerKey,
  readTextFile,
  readerLedger,
  resolveTarget,
  staleWriteCheck,
  stampOfText,
  toLf,
  writeTextAtomic,
} from "./file-tools.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ft-"));
}

// ---------- 路径解析 ----------

test("resolveTarget：相对按工作区解析，绝对原样，inside 判定正确，空串报错", () => {
  const ws = tmp();
  const r1 = resolveTarget(ws, "a/b.txt");
  assert.equal(r1.abs.toLowerCase(), join(ws, "a/b.txt").toLowerCase());
  assert.equal(r1.inside, true);
  const r2 = resolveTarget(ws, join(ws, "x.txt"));
  assert.equal(r2.inside, true);
  const r3 = resolveTarget(ws, "F:/elsewhere/x.txt");
  assert.equal(r3.inside, false);
  assert.throws(() => resolveTarget(ws, "   "));
  rmSync(ws, { recursive: true, force: true });
});

test("ledgerKey：Windows 上大小写归一", () => {
  if (process.platform === "win32") {
    assert.equal(ledgerKey("C:\\A\\B.txt"), ledgerKey("c:\\a\\b.txt"));
  } else {
    assert.equal(ledgerKey("/a/b"), ledgerKey("/a/b"));
  }
});

// ---------- EOL / 读取 / 原子写 ----------

test("detectEol/toLf/applyEol：CRLF 往返还原，LF 原样", () => {
  const crlf = "a\r\nb\r\n";
  assert.equal(detectEol(crlf), "\r\n");
  const lf = toLf(crlf);
  assert.equal(lf, "a\nb\n");
  assert.equal(applyEol(lf, "\r\n"), crlf);
  assert.equal(detectEol("x\ny"), "\n");
  assert.equal(applyEol(lf, "\n"), lf);
});

test("readTextFile：缺失/目录/二进制/正常 各归其位", () => {
  const d = tmp();
  assert.equal(readTextFile(join(d, "nope.txt")).ok, false);
  const dir = readTextFile(d);
  assert.equal(dir.ok, false);
  assert.ok(!dir.ok && dir.message.includes("目录"));
  writeFileSync(join(d, "bin.dat"), Buffer.from([0x70, 0x00, 0x71]));
  const bin = readTextFile(join(d, "bin.dat"));
  assert.equal(bin.ok, false);
  assert.ok(!bin.ok && bin.message.includes("二进制"));
  writeFileSync(join(d, "t.txt"), "你好");
  const ok = readTextFile(join(d, "t.txt"));
  assert.ok(ok.ok && ok.text === "你好");
  rmSync(d, { recursive: true, force: true });
});

test("writeTextAtomic：写后可读，覆写生效，自动建父目录", () => {
  const d = tmp();
  const p = join(d, "sub", "dir", "f.txt");
  writeTextAtomic(p, "one");
  writeTextAtomic(p, "two");
  assert.equal(readFileSync(p, "utf8"), "two");
  rmSync(d, { recursive: true, force: true });
});

// ---------- 精确编辑 ----------

test("applyEdit：唯一命中替换；多次出现无 replace_all 报错，有则全替", () => {
  assert.deepEqual(applyEdit("a-b-c", "b", "X", false), { ok: true, content: "a-X-c", count: 1 });
  const many = applyEdit("a-b-b", "b", "X", false);
  assert.equal(many.ok, false);
  assert.ok(!many.ok && many.message.includes("2 次"));
  assert.ok(!many.ok && many.message.includes("occurrence"), "多命中报错应指引 occurrence 消歧方式");
  const all = applyEdit("a-b-b", "b", "X", true);
  assert.ok(all.ok && all.content === "a-X-X" && all.count === 2);
  assert.equal(applyEdit("abc", "zzz", "X", false).ok, false);
  assert.equal(applyEdit("abc", "abc", "abc", false).ok, false);
  assert.equal(applyEdit("abc", "", "X", false).ok, false);
});

test("applyEdit：occurrence 指定替换第几处（1 起始）；与 replace_all 互斥、越界/非法报错", () => {
  const first = applyEdit("a-b-b-c", "b", "X", false, 1);
  assert.ok(first.ok && first.content === "a-X-b-c" && first.count === 1);
  const second = applyEdit("a-b-b-c", "b", "X", false, 2);
  assert.ok(second.ok && second.content === "a-b-X-c" && second.count === 1);
  // 只动第 4 处：其余三个命中原样保留
  const third = applyEdit("a-b-b-b-c-b", "b", "X", false, 4);
  assert.ok(third.ok && third.content === "a-b-b-b-c-X" && third.count === 1);
  const over = applyEdit("a-b-b-c", "b", "X", false, 3);
  assert.equal(over.ok, false);
  assert.ok(!over.ok && over.message.includes("超出范围") && over.message.includes("1–2"));
  const conflict = applyEdit("a-b-b-c", "b", "X", true, 1);
  assert.equal(conflict.ok, false);
  assert.ok(!conflict.ok && conflict.message.includes("不能同时使用"));
  assert.equal(applyEdit("a-b-b-c", "b", "X", false, 0).ok, false);
  assert.equal(applyEdit("a-b-b-c", "b", "X", false, 1.5).ok, false);
  // CRLF 文件走 occurrence 同样保持换行风格
  const crlf = applyEdit("x\r\ny\r\ny\r\n", "y", "Z", false, 2);
  assert.ok(crlf.ok && crlf.content === "x\r\ny\r\nZ\r\n");
});

test("applyEdit：CRLF 文件用 LF 串匹配，写回保持 CRLF", () => {
  const raw = "function a() {\r\n  return 1;\r\n}\r\n";
  const r = applyEdit(raw, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}", false);
  assert.ok(r.ok);
  assert.ok(r.ok && r.content === "function a() {\r\n  return 2;\r\n}\r\n");
});

// ---------- 写入裁决矩阵 ----------

interface Spy {
  asks: ApprovalRequest[];
  decide: (req: ApprovalRequest) => ApprovalDecision;
}

function gateInput(over: Partial<Parameters<typeof adjudicateWrite>[0]> & { spy: Spy }): Parameters<typeof adjudicateWrite>[0] {
  const { spy, ...rest } = over;
  return {
    toolName: "write_file",
    verb: "写入",
    abs: "F:/ws/a.txt",
    inside: true,
    workspaceRoot: "F:/ws",
    requestApproval: async (req) => {
      spy.asks.push(req);
      return spy.decide(req);
    },
    ...rest,
  };
}

test("裁决矩阵：workspace-write 区内直接放行不问；区外必问", async () => {
  const spy: Spy = { asks: [], decide: () => "allowed-once" };
  assert.deepEqual(await adjudicateWrite(gateInput({ spy })), { proceed: true });
  assert.equal(spy.asks.length, 0);
  const out = await adjudicateWrite(gateInput({ spy, inside: false, abs: "C:/x.txt" }));
  assert.ok(out.proceed);
  assert.equal(spy.asks.length, 1);
  assert.ok(spy.asks[0].reasons.some((r) => r.includes("工作区外")));
});

test("裁决矩阵：read-only 一律问；拒绝则不写并回传文案", async () => {
  const spy: Spy = { asks: [], decide: () => "allowed-once" };
  const ok = await adjudicateWrite(gateInput({ spy, sandboxMode: "read-only" }));
  assert.ok(ok.proceed && spy.asks.length === 1);
  assert.ok(spy.asks[0].reasons.some((r) => r.includes("read-only")));
  const spy2: Spy = { asks: [], decide: () => "rejected" };
  const no = await adjudicateWrite(gateInput({ spy: spy2, sandboxMode: "read-only" }));
  assert.ok(!no.proceed && no.text.includes("拒绝"));
});

test("裁决矩阵：danger-full-access 不问，逐条确认模式才问", async () => {
  const silent: Spy = { asks: [], decide: () => "allowed-once" };
  const out = await adjudicateWrite(
    gateInput({ spy: silent, sandboxMode: "danger-full-access", alwaysConfirm: false, inside: false }),
  );
  assert.ok(out.proceed && silent.asks.length === 0);
  const confirm: Spy = { asks: [], decide: () => "allowed-once" };
  const out2 = await adjudicateWrite(
    gateInput({ spy: confirm, sandboxMode: "danger-full-access", alwaysConfirm: true }),
  );
  assert.ok(out2.proceed && confirm.asks.length === 1);
  assert.ok(confirm.asks[0].reasons.includes("（逐条确认模式已开启）"));
});

test("裁决矩阵：逐条确认下 workspace-write 区内写入也弹卡；拒绝则不写", async () => {
  const spy: Spy = { asks: [], decide: () => "allowed-once" };
  const ok = await adjudicateWrite(gateInput({ spy, alwaysConfirm: true }));
  assert.ok(ok.proceed && spy.asks.length === 1);
  assert.ok(spy.asks[0].reasons.includes("（逐条确认模式已开启）"));
  const spy2: Spy = { asks: [], decide: () => "rejected" };
  const no = await adjudicateWrite(gateInput({ spy: spy2, alwaysConfirm: true }));
  assert.ok(!no.proceed && no.text.includes("拒绝"));
});

test("裁决矩阵：unavailable（无人值守）按拒绝处理；description/工具名透传审批卡", async () => {
  const spy: Spy = { asks: [], decide: () => "unavailable" };
  const out = await adjudicateWrite(gateInput({ spy, sandboxMode: "read-only", description: "写配置文件" }));
  assert.ok(!out.proceed && out.text.includes("无人值守"));
  assert.equal(spy.asks[0].description, "写配置文件");
  assert.equal(spy.asks[0].toolName, "write_file");
  assert.ok(spy.asks[0].command.startsWith("写入："));
});

// ---------- SA3：hash 乐观锁 + per-reader 快照 + scope 分区（docs/5 §5.3/§5.4） ----------

test("staleWriteCheck：未读拒（引导 read_file）；读后未变放行；读后被改拒（引导重读）；不存在放行", async () => {
  const d = tmp();
  const f = join(d, "x.txt");
  const ledger = createFileLedger();
  const key = ledgerKey(f);

  writeFileSync(f, "v1");
  const unread = staleWriteCheck(f, key, ledger, "写入");
  assert.equal(unread.ok, false);
  assert.ok(!unread.ok && unread.message.includes("先 read_file"));

  ledger.noteRead(key, stampOfText("v1"));
  assert.deepEqual(staleWriteCheck(f, key, ledger, "编辑"), { ok: true, exists: true });

  writeFileSync(f, "v2 改过"); // 模拟并行 worker / 外部进程修改
  const stale = staleWriteCheck(f, key, ledger, "写入");
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.message.includes("已被修改"), "应识别读取之后的修改");
  assert.ok(!stale.ok && stale.message.includes("重新 read_file"), "拒绝文案应引导重读");

  ledger.noteRead(key, stampOfText("v2 改过")); // 重读后基于最新内容
  assert.deepEqual(staleWriteCheck(f, key, ledger, "写入"), { ok: true, exists: true });

  rmSync(join(d, "x.txt"));
  assert.deepEqual(staleWriteCheck(f, key, ledger, "写入"), { ok: true, exists: false }); // 磁盘消失=重建放行
  rmSync(d, { recursive: true, force: true });
});

test("readerLedger：双 worker 共享凭据但各持快照——A 写入后 B 的旧快照失效，B 重读后自愈（C1/C2）", async () => {
  const d = tmp();
  const f = join(d, "shared.txt");
  writeFileSync(f, "base");
  const key = ledgerKey(f);
  const shared = createFileLedger();
  const a = readerLedger(shared);
  const b = readerLedger(shared);

  a.noteRead(key, stampOfText("base"));
  b.noteRead(key, stampOfText("base")); // 两个 worker 都读过同一版本
  assert.ok(shared.wasRead(key), "凭据进共享台账（wasRead 会话级）");

  // A 写入成功（写后更新自己的快照 + 磁盘）
  writeFileSync(f, "A 的产出");
  a.noteRead(key, stampOfText("A 的产出"));

  // B 凭旧快照再写 → 被拒（lost update 防线）；共享单值台账做不倒这一点（B 会读到 A 的新指纹而漏检）
  const bStale = staleWriteCheck(f, key, b, "写入");
  assert.equal(bStale.ok, false);
  assert.ok(!bStale.ok && bStale.message.includes("已被修改"));

  // B 重读最新内容后写入成功（模型自愈路径）
  b.noteRead(key, stampOfText("A 的产出"));
  assert.deepEqual(staleWriteCheck(f, key, b, "写入"), { ok: true, exists: true });
  rmSync(d, { recursive: true, force: true });
});

test("裁决矩阵：scope 分区硬拒不走审批；scope 内放行；前缀是目录级匹配", async () => {
  const spy: Spy = { asks: [], decide: () => "allowed-once" };
  const out = await adjudicateWrite(
    gateInput({ spy, abs: "F:/ws/src/other/f.txt", writeScope: ["src/auth", "docs"] }),
  );
  assert.ok(!out.proceed);
  assert.ok(!out.proceed && out.text.includes("scope"));
  assert.ok(!out.proceed && out.text.includes("src/auth"));
  assert.equal(spy.asks.length, 0, "scope 越界是结构性硬拒，不弹审批卡");

  const inScope = await adjudicateWrite(gateInput({ spy, abs: "F:/ws/src/auth/deep/token.ts", writeScope: ["src/auth", "docs"] }));
  assert.deepEqual(inScope, { proceed: true }); // 目录级前缀：src/authenticate 不会误放（见下一断言）

  const sibling = await adjudicateWrite(gateInput({ spy, abs: "F:/ws/src/authenticate.ts", writeScope: ["src/auth"] }));
  assert.ok(!sibling.proceed, "src/auth 不是 src/authenticate 的前缀（目录边界）");

  const noScope = await adjudicateWrite(gateInput({ spy, abs: "F:/ws/anywhere.txt" }));
  assert.deepEqual(noScope, { proceed: true }); // 缺省=整个工作区，行为与现状一致
});
