/**
 * read_image 工具实现（docs/34）：视觉会话直接读取工作区图片文件——图片作为**图像块**
 * 挂到本工具的 tool 消息进入对话，模型下一轮请求原生看到（与贴图同一条附件/回放管线）；
 * 区别于 view_image（借视觉模型出**文字描述**，调用方不直接看图）。
 * 闸门：会话模型无视觉能力（selfVision()=null）直接拒绝——纯文本模型不会先存再变占位
 * （DSH 口径）。格式按文件魔数识别（PNG/JPEG/GIF/WebP），大小沿用 IMAGE_RULES 单张上限；
 * 路径守卫与 read_file 同口径（isInsideWorkspace）。存储走 docs/33 内容寻址（落盘边界
 * 在 toStoredMessages——工具只返回字节，持久化/去重由会话档统一处理）。
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatImage } from "../../../llm/provider.ts";
import type { Tool, ToolContext } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import { IMAGE_RULES, THRESHOLDS } from "../../../config.ts";
import { isInsideWorkspace } from "../../../workspace.ts";

/** 文件魔数 → MIME（无扩展名也能识别；不认识返回 null）。 */
function sniffImageMime(bytes: Buffer): ChatImage["mime"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("latin1") === "GIF87a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function kb(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 102.4) / 10} KB` : `${bytes} B`;
}

/** 读取主体（execute 与 executeImage 共用；docs/34——注册表优先走 executeImage 带图路径）。 */
async function readImage(args: Record<string, unknown>, ctx: ToolContext, deps: SystemToolDeps): Promise<{ text: string; images?: ChatImage[] }> {
  if (!deps.selfVision || deps.selfVision() === null) {
    return {
      text:
        "错误：本会话模型没有视觉能力，read_image 无法让你直接看到图片——改用 view_image（借视觉模型出文字描述）；" +
        "或在设置里换用有视觉能力的提供方后再用本工具。",
    };
  }
  const rel = String(args.path ?? "").trim();
  if (!rel) return { text: "错误：path 不能为空——给出工作区内图片文件的相对路径。" };
  const root = ctx.workspace.root;
  const abs = resolve(root, rel);
  if (!isInsideWorkspace(root, abs)) return { text: `错误：路径 ${rel} 超出工作区边界（只允许读取工作区内文件）。` };
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return { text: `错误：文件不存在：${rel}。` };
  if (!st.isFile()) return { text: `错误：${rel} 不是文件（目录无法作为图片读取——用 list_files/读目录工具查看内容）。` };
  if (st.size > IMAGE_RULES.maxBytes) {
    return {
      text:
        `错误：图片 ${rel} 大小 ${kb(st.size)} 超过单张上限 ${kb(IMAGE_RULES.maxBytes)}——先压缩或转格式（可用 run_pwsh 调系统工具）后再读。`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (e) {
    return { text: `错误：图片无法读取：${e instanceof Error ? e.message : String(e)}` };
  }
  const mime = sniffImageMime(bytes);
  if (!mime) {
    return {
      text:
        `错误：${rel} 不是可识别的图片格式（按文件魔数识别，支持 PNG/JPEG/GIF/WebP）——确认路径或先转格式（可用 run_pwsh 调系统工具）。`,
    };
  }
  return {
    text:
      `[已读取图片 ${rel}] 格式 ${mime} · ${kb(bytes.length)}。图片已作为图像块进入本对话——下一次请求你会直接看到它，之后随历史保留在上下文里（可随时回看），` +
      `直到被压缩摘要替换，或会话内图片超出预算（上限 ${THRESHOLDS.imageContextMaxCount} 张）时最早的图被移出。` +
      `看到后把观察结论写成文字；同一张图不要重复读——改图后读新文件即可。`,
    images: [{ mime, data: bytes.toString("base64") }],
  };
}

/**
 * read_image（docs/34）：视觉会话直读工作区图片——图片原生进入对话（工具结果带图像块）。
 * 无视觉能力的模型被闸门拒绝并指引 view_image（借视觉模型出文字描述，二者互补）。
 */
export function createReadImageTool(deps: SystemToolDeps): Tool {
  return {
    name: "read_image",
    description:
      "直接读取工作区内的图片文件，图片作为图像块进入本对话（下一次请求你将原生看到它，无需文字转述）。" +
      "仅当本会话模型有视觉能力时可用（无视觉时调用会被拒绝，请改用 view_image 借视觉模型出文字描述）。" +
      "支持 PNG/JPEG/GIF/WebP（按文件魔数识别）；单张不超过大小上限；路径相对工作区根。" +
      `图片随历史保留在上下文里（之后可随时回看，也持续占视觉 token）——直到被压缩摘要替换，或会话内图片超出预算（上限 ${THRESHOLDS.imageContextMaxCount} 张）时最早的图被移出。` +
      "读后用文字总结观察结论，不要反复读同一张图；改图后读新文件即可。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内图片文件的相对路径（PNG/JPEG/GIF/WebP，按魔数识别）" },
      },
      required: ["path"],
    },
    // 注册表优先走 executeImage（带图路径）；execute 只是回退兜底（无图纯文本说明）
    execute: (args, ctx) => readImage(args, ctx, deps).then((r) => r.text),
    executeImage: async (args, ctx) => {
      const r = await readImage(args, ctx, deps);
      return { text: r.text, images: r.images ?? [] };
    },
  } as Tool;
}
