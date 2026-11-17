/**
 * 图片附件内容寻址库（docs/33，对齐 DSH 设计）：图片字节按 sha256 落盘一份
 * （<userDir>/attachments/v1/objects/<前2位>/<sha256>，内容寻址、不可变、同字节只存一份、
 * **永不自动清理**——不随会话删除/回收站清空），会话档 JSON 只存 { mime, ref } 引用。
 * 内存中的 ChatMessage.images 仍是 { mime, data }（内联 base64——提供方/前端/用量估算零改动）；
 * 引用只存在于两个边界：落盘（toStoredMessages：写会话档/压缩备份前）与恢复
 * （restoreStoredMessages：createRuntime 从磁盘回读时）。
 * 读取校验整段 sha256；缺失/被改 → **降级**：丢图 + 消息尾部「附件丢失」标注（不炸会话）——
 * DSH 口径是明确报错，本仓库选择降级原因见 docs/33 §与 DSH 的偏差。
 * 不做 EXIF 剥离/重编码/像素预算（零原生依赖边界，Node 标准库解不了 JPEG/PNG——docs/33 §偏差）；
 * 上传准入沿用 config.IMAGE_RULES（docs/10 R3/docs/22 §4.1）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_DIR_LAYOUT } from "../userdir.ts";
import type { ChatImage, ChatMessage } from "../llm/provider.ts";

/** 引用 = 文件内容的 sha256（hex 64）；路径 = objects/<前2位>/<hex>（DSH 同款扇区目录防单目录膨胀）。 */
const REF_RE = /^[0-9a-f]{64}$/;

export class AttachmentStore {
  private readonly root: string;

  constructor(userDir: string) {
    this.root = join(userDir, USER_DIR_LAYOUT.attachments, "v1", "objects");
    mkdirSync(this.root, { recursive: true });
  }

  /** base64 → 字节 → sha256 → 落盘（幂等去重：existsSync 命中即跳过——同字节全局只存一份）。返回引用。 */
  put(dataB64: string): string {
    const bytes = Buffer.from(dataB64, "base64");
    const ref = createHash("sha256").update(bytes).digest("hex");
    const file = this.pathOf(ref);
    if (!existsSync(file)) {
      mkdirSync(join(this.root, ref.slice(0, 2)), { recursive: true });
      writeFileSync(file, bytes);
    }
    return ref;
  }

  /** 引用 → base64；文件缺失 / 引用形状非法 / sha256 不符（被改/损坏/截断）→ null（调用方降级）。 */
  resolve(ref: string): string | null {
    if (!REF_RE.test(ref)) return null;
    try {
      const bytes = readFileSync(this.pathOf(ref));
      return createHash("sha256").update(bytes).digest("hex") === ref ? bytes.toString("base64") : null;
    } catch {
      return null;
    }
  }

  private pathOf(ref: string): string {
    return join(this.root, ref.slice(0, 2), ref);
  }
}

/** 会话档内图片的落盘形态（docs/33）：{ mime, ref }（ref=sha256）——旧档 { mime, data } 内联 base64 兼容读取。 */
export type StoredImage = { mime: ChatImage["mime"]; ref: string };

/** 是否为引用形态（与旧档内联 data 区分——恢复路径按此分流）。 */
function isStoredImage(im: unknown): im is StoredImage {
  return typeof im === "object" && im !== null && "ref" in im && !("data" in im);
}

/**
 * 内存消息 → 会话档形态（写会话档/压缩备份前调用）：user 图片 {mime,data} → {mime,ref}
 * （幂等：同字节同引用，库内 existsSync 去重）。attachments 缺省时原样透传
 * （旧形态兼容路径——测试直调/未来无库环境）。非 user 消息与无图消息原样。
 */
export function toStoredMessages(attachments: AttachmentStore | undefined, messages: ChatMessage[]): ChatMessage[] {
  if (!attachments) return messages;
  return messages.map((m) => {
    // docs/34：tool 消息也带图（read_image）——引用变换与 user 同口径
    if (m.role !== "user" && m.role !== "tool") return m;
    if (!m.images?.length) return m;
    return {
      ...m,
      images: m.images.map((im) => ({ mime: im.mime, ref: attachments.put(im.data) })),
    } as unknown as ChatMessage; // 落盘档形态（images 为 StoredImage[]）——JSON 序列化按 ChatMessage 结构走
  });
}

/**
 * 会话档 → 内存形态（createRuntime 恢复调用）：{mime,ref} → 读附件库校验整段 sha256 →
 * {mime,data}；缺失/损坏的图**丢弃**并在消息尾部追加「附件丢失」标注（会话照常可用——
 * 降级偏差见 docs/33）；旧档内联 data 原样保留（向后兼容）。
 */
export function restoreStoredMessages(attachments: AttachmentStore | undefined, stored: ChatMessage[]): ChatMessage[] {
  if (!attachments) return stored;
  return stored.map((m) => {
    // docs/34：tool 消息也带图（read_image）——引用变换与 user 同口径
    if (m.role !== "user" && m.role !== "tool") return m;
    if (!m.images?.length) return m;
    const images: ChatImage[] = [];
    const lost: string[] = [];
    for (const im of m.images as unknown as Array<ChatImage | StoredImage>) {
      if (isStoredImage(im)) {
        const data = attachments.resolve(im.ref);
        if (data === null) {
          lost.push(`sha256=${im.ref.slice(0, 12)}…`);
          continue;
        }
        images.push({ mime: im.mime, data });
      } else {
        images.push(im); // 旧档内联 base64（未迁移档案）原样
      }
    }
    if (lost.length === 0) return { ...m, images } as ChatMessage;
    const content = `${typeof m.content === "string" ? m.content : ""}\n[附件丢失：${lost.length} 张图片（${lost.join("、")}）——附件库中缺失或校验不符，已从本消息移除]`;
    return {
      ...m,
      content,
      // 必须显式覆盖 images：{...m} 会把落盘档里的引用形态数组原样带上（同名展开字段漏覆盖
      // 的坑）——全丢置 undefined（JSON 序列化即省略该字段）
      images: images.length > 0 ? images : undefined,
    } as unknown as ChatMessage;
  });
}
