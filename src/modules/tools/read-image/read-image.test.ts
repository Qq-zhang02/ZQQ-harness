/**
 * read_image 工具测试（docs/34 视觉会话直读图片）：selfVision 闸门（纯文本模型拒绝并
 * 指引 view_image）、路径守卫（越界/不存在/目录）、魔数识别（PNG/JPEG/GIF/WebP 与未知
 * 格式拒绝）、大小上限、成功返回（text 信封 + images 图像块）；executeImage 优先路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLedger } from "../../../core/file-tools.ts";
import { IMAGE_RULES } from "../../../config.ts";
import type { ProviderConfig } from "../../../providers/store.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ToolContext } from "../../../tools/registry.ts";
import { createReadImageTool } from "./read-image.ts";

// 1×1 PNG 的真实字节（魔数头合法）
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tctx = (root: string): ToolContext => ({ workspace: { root }, requestApproval: async () => "allowed-once" });

function makeTool(root: string, selfVision: boolean): ReturnType<typeof createReadImageTool> {
  const deps = {
    ledger: createFileLedger(),
    workspace: () => ({ root }),
    selfVision: () => (selfVision ? ({ id: "p", vision: true } as unknown as ProviderConfig) : null),
  } as unknown as SystemToolDeps;
  return createReadImageTool(deps);
}

test("read_image：selfVision 闸门——无视觉模型直接拒绝并指引 view_image（不读文件）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-readimg-"));
  try {
    writeFileSync(join(dir, "a.png"), Buffer.from(PNG_B64, "base64"));
    const out = await makeTool(dir, false).executeImage!({ path: "a.png" }, tctx(dir));
    assert.ok(out.text.includes("没有视觉能力") && out.text.includes("view_image"), out.text);
    assert.deepEqual(out.images, [], "拒绝不带图像块");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_image：成功路径——魔数识别 PNG、信封说明 + 图像块返回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-readimg-"));
  try {
    writeFileSync(join(dir, "pic.png"), Buffer.from(PNG_B64, "base64"));
    const out = await makeTool(dir, true).executeImage!({ path: "pic.png" }, tctx(dir));
    assert.equal(out.images?.length, 1);
    assert.equal(out.images?.[0]!.mime, "image/png");
    assert.equal(out.images?.[0]!.data, PNG_B64, "字节原样（不做重编码）");
    assert.ok(out.text.includes("已读取图片 pic.png") && out.text.includes("image/png"), out.text);
    assert.ok(out.text.includes("重复出现"), "提醒每轮重放占视觉 token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_image：路径守卫（越界/不存在/目录）与非图片内容拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-readimg-"));
  try {
    writeFileSync(join(dir, "a.txt"), "纯文本不是图片");
    mkdirSync(join(dir, "sub"));
    const t = makeTool(dir, true);
    assert.ok((await t.executeImage!({ path: "../x.png" }, tctx(dir))).text.includes("超出工作区边界"));
    assert.ok((await t.executeImage!({ path: "nope.png" }, tctx(dir))).text.includes("不存在"));
    assert.ok((await t.executeImage!({ path: "sub" }, tctx(dir))).text.includes("不是文件"));
    assert.ok((await t.executeImage!({ path: "a.txt" }, tctx(dir))).text.includes("不是可识别的图片格式"), "魔数不识别拒绝");
    assert.ok((await t.executeImage!({}, tctx(dir))).text.includes("path 不能为空"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_image：大小超限拒绝（IMAGE_RULES 单张上限）；JPEG/GIF/WebP 魔数识别", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-readimg-"));
  try {
    const big = Buffer.alloc(IMAGE_RULES.maxBytes + 1, 0x89);
    writeFileSync(join(dir, "big.png"), big);
    assert.ok((await makeTool(dir, true).executeImage!({ path: "big.png" }, tctx(dir))).text.includes("超过单张上限"));
    // 各格式魔数（JPEG FF D8 FF / GIF87a / RIFF…WEBP）
    const cases: Array<[string, Buffer, string]> = [
      ["j.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], ), "image/jpeg"],
      ["g.gif", Buffer.from("GIF87a" + "xxxxxx"), "image/gif"],
      ["w.webp", Buffer.from("RIFF" + "\x00\x00\x00\x00" + "WEBP"), "image/webp"],
    ];
    for (const [name, buf, mime] of cases) {
      writeFileSync(join(dir, name), buf);
      const out = await makeTool(dir, true).executeImage!({ path: name }, tctx(dir));
      assert.equal(out.images?.[0]!.mime, mime, `${name} → ${mime}`);
    }
    // execute 回退路径：只返回文本不带图（注册表优先 executeImage，此处防御直调）
    const plain = await makeTool(dir, true).execute({ path: "j.jpg" }, tctx(dir));
    assert.ok(plain.includes("已读取图片 j.jpg"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
