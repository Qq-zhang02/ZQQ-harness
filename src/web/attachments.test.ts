/**
 * 附件内容寻址库测试（docs/33）：put/resolve 往返、同字节去重（同引用单文件）、
 * 篡改/缺失/非法引用的校验拒绝、toStoredMessages/restoreStoredMessages 的引用往返
 * 与旧档内联 base64 兼容、丢失降级标注。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore, restoreStoredMessages, toStoredMessages, type StoredImage } from "./attachments.ts";
import type { ChatMessage } from "../llm/provider.ts";

// 1×1 PNG（合法字节即可——库不做图像解码）
/** 从消息联合读 images/content（测试专用窄化——ChatMessage 联合不能直接点出可选字段）。 */
const imagesOf = (m: ChatMessage): unknown => (m as unknown as { images?: unknown }).images;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// 同字节不同 base64 分组（带空白/不同 padding 语义上同一份内容？——put 按解码后字节哈希，等价输入同引用）
const OTHER_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("AttachmentStore：put/resolve 往返；同字节去重（同引用、盘上单文件）；不同字节不同引用", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-attach-"));
  try {
    const store = new AttachmentStore(dir);
    const ref1 = store.put(PNG_B64);
    const ref2 = store.put(PNG_B64); // 幂等去重
    assert.equal(ref1, ref2, "同字节 → 同引用");
    assert.equal(ref1.length, 64, "引用 = sha256 hex");
    assert.equal(store.resolve(ref1), PNG_B64, "往返还原 base64");
    // 扇区目录 <前2位>/<sha256> 盘上只有一个文件
    const sector = join(dir, "attachments", "v1", "objects", ref1.slice(0, 2));
    assert.deepEqual(
      readFileSync(join(sector, ref1)).length,
      Buffer.from(PNG_B64, "base64").length,
      "落盘 = 解码后的原始字节（非 base64 文本）",
    );
    const ref3 = store.put(OTHER_B64);
    assert.notEqual(ref3, ref1, "不同字节 → 不同引用");
    assert.equal(store.resolve(ref3), OTHER_B64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AttachmentStore：篡改/缺失/非法引用 → resolve null（读回校验整段 sha256）", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-attach-"));
  try {
    const store = new AttachmentStore(dir);
    const ref = store.put(PNG_B64);
    // 篡改一个字节 → 校验不符
    const file = join(dir, "attachments", "v1", "objects", ref.slice(0, 2), ref);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0])]));
    assert.equal(store.resolve(ref), null, "sha256 不符拒绝");
    assert.equal(store.resolve("f".repeat(64)), null, "缺失文件 null");
    assert.equal(store.resolve("../../etc/passwd"), null, "非法引用形状 null（防路径穿越）");
    assert.equal(store.resolve(""), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toStoredMessages/restoreStoredMessages：引用往返；旧档内联 data 兼容；丢失降级标注", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-attach-"));
  try {
    const store = new AttachmentStore(dir);
    const msg: ChatMessage = {
      role: "user",
      content: "看看这两张图",
      images: [
        { mime: "image/png", data: PNG_B64 },
        { mime: "image/png", data: OTHER_B64 },
      ],
    };
    const assistant: ChatMessage = { role: "assistant", content: "好的", toolCalls: [] };
    const stored = toStoredMessages(store, [msg, assistant]);
    const wire = JSON.stringify(stored);
    assert.ok(!wire.includes(PNG_B64), "落盘档不嵌 base64");
    const imgs = (stored[0] as unknown as { images: StoredImage[] }).images;
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0]!.mime, "image/png");
    assert.equal(imgs[0]!.ref.length, 64);
    assert.deepEqual(stored[1], assistant, "非图片消息原样");

    // 往返：引用 → 读库校验 → 原 base64
    const back = restoreStoredMessages(store, stored);
    assert.deepEqual(imagesOf(back[0]!), msg.images, "往返还原 images");
    assert.equal(back[0]!.content, "看看这两张图");

    // 旧档内联 data 原样兼容
    const legacy = restoreStoredMessages(store, [msg]);
    assert.deepEqual(imagesOf(legacy[0]!), msg.images, "内联 data 透传");

    // 丢失降级：引用对应的文件不存在 → 丢图 + 消息尾部标注（有存图的保留、全丢的清 images）
    const ghost: ChatMessage = { role: "user", content: "图没了", images: [{ mime: "image/png", data: PNG_B64 }] };
    const storedGhost = toStoredMessages(store, [ghost]);
    (storedGhost[0] as unknown as { images: StoredImage[] }).images[0]!.ref = "a".repeat(64); // 指向不存在的引用
    const degraded = restoreStoredMessages(store, storedGhost);
    assert.equal(imagesOf(degraded[0]!), undefined, "全丢清空 images");
    assert.ok(
      (degraded[0]!.content as string).includes("[附件丢失：1 张图片") && (degraded[0]!.content as string).includes("aaaa"),
      "标注含数量与引用前缀",
    );
    // 部分丢失：剩一张保留
    const half: ChatMessage = { role: "user", content: "两张", images: [{ mime: "image/png", data: PNG_B64 }, { mime: "image/png", data: OTHER_B64 }] };
    const storedHalf = toStoredMessages(store, [half]) as unknown as [{ images: StoredImage[] }];
    storedHalf[0].images[1].ref = "b".repeat(64);
    const halfBack = restoreStoredMessages(store, storedHalf as unknown as ChatMessage[]);
    assert.equal((halfBack[0] as unknown as { images: StoredImage[] }).images?.length, 1, "丢失的丢弃、存活的保留");
    assert.ok((halfBack[0]!.content as string).includes("[附件丢失：1 张图片"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toStoredMessages/restoreStoredMessages：无库（undefined）原样透传；无图消息不进库", () => {
  const msg: ChatMessage = { role: "user", content: "纯文本", images: [{ mime: "image/png", data: PNG_B64 }] };
  assert.deepEqual(toStoredMessages(undefined, [msg]), [msg], "缺库透传（旧形态兼容）");
  assert.deepEqual(restoreStoredMessages(undefined, [msg]), [msg]);
  const dir = mkdtempSync(join(tmpdir(), "zqq-attach-"));
  try {
    const store = new AttachmentStore(dir);
    const stored = toStoredMessages(store, [{ role: "user", content: "无图" }, { role: "assistant", content: "ok", toolCalls: [] }]);
    assert.deepEqual(stored, [{ role: "user", content: "无图" }, { role: "assistant", content: "ok", toolCalls: [] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/34：tool 消息图片（read_image）同口径引用变换 ----------

test("toStoredMessages/restoreStoredMessages：tool 消息图片与 user 同口径（引用落盘、往返还原）", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-attach-"));
  try {
    const store = new AttachmentStore(dir);
    const toolMsg: ChatMessage = {
      role: "tool",
      toolCallId: "c1",
      content: "[已读取图片 pic.png]",
      images: [{ mime: "image/png", data: PNG_B64 }],
    };
    const stored = toStoredMessages(store, [toolMsg]);
    const ref = (stored[0] as unknown as { images: StoredImage[] }).images[0]!.ref;
    assert.equal(ref.length, 64, "tool 图片转引用（档内不嵌 base64）");
    assert.ok(!JSON.stringify(stored).includes(PNG_B64));
    const back = restoreStoredMessages(store, stored);
    assert.deepEqual((back[0] as unknown as { images: unknown }).images, [{ mime: "image/png", data: PNG_B64 }], "往返还原");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
