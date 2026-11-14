/** docs/21 §2.2-① 回归：请求体上限必须覆盖图片消息合法上限（4×5MB base64 ≈ 27.3MB），
 *  修复前 1MB 上限先于 parseChatImages 拦截、"每张 ≤5MB"实际不可达。 */
import test from "node:test";
import assert from "node:assert/strict";
import { HTTP_BODY_MAX_BYTES, readBody } from "./http.ts";
import type { IncomingMessage } from "node:http";

/** 把一个 Buffer 伪装成 IncomingMessage（分块 async iterable，readBody 只做异步迭代）。 */
function reqOf(payload: Buffer, chunkSize = 1024 * 1024): IncomingMessage {
  let pos = 0;
  const self = {
    async *[Symbol.asyncIterator]() {
      while (pos < payload.length) {
        const end = Math.min(pos + chunkSize, payload.length);
        yield payload.subarray(pos, end);
        pos = end;
      }
    },
  };
  return self as unknown as IncomingMessage;
}

/** 构造指定总大小的合法 JSON 载荷：{"a":"AAAA…"}（字符串填充凑字节数）。 */
function jsonPayloadOf(totalBytes: number): Buffer {
  const head = Buffer.from('{"a":"');
  const tail = Buffer.from('"}');
  return Buffer.concat([head, Buffer.alloc(totalBytes - head.length - tail.length, 0x41), tail]); // 0x41 = "A"
}

test("readBody：27.3MB（4×5MB 图 base64 量级）的合法 JSON 正常读取，不再被 1MB 拦截", async () => {
  const payload = jsonPayloadOf(27 * 1024 * 1024 + 300 * 1024);
  const body = (await readBody(reqOf(payload))) as { a: string };
  assert.equal(body.a.length, payload.length - 8); // 包装 {"a":" + "} 共 8 字节
});

test("readBody：空体返回 {}（无 JSON 解析）", async () => {
  assert.deepEqual(await readBody(reqOf(Buffer.alloc(0))), {});
});

test("readBody：超过 HTTP_BODY_MAX_BYTES 抛「请求体过大」", async () => {
  const payload = jsonPayloadOf(HTTP_BODY_MAX_BYTES + 1024);
  await assert.rejects(() => readBody(reqOf(payload)), /请求体过大/);
});

test("HTTP_BODY_MAX_BYTES 覆盖 4 张 5MB 图的 base64 上限（哨兵：防回退到 1MB 时代的隐式拦截）", () => {
  const fourImagesBase64 = Math.ceil((5 * 1024 * 1024 * 4) * 4 / 3); // 解码后 20MB → base64 ≈ 26.7MB
  assert.ok(HTTP_BODY_MAX_BYTES >= fourImagesBase64 + 1024 * 1024, `上限 ${HTTP_BODY_MAX_BYTES} 应覆盖 4×5MB 图 + 余量`);
  assert.ok(HTTP_BODY_MAX_BYTES > 1_000_000, "不再是旧的 1MB");
});
