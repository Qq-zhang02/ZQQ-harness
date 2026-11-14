/**
 * tools.view-image 模块（docs/10 R3）：view_image 系统工具的注册入口。
 * 读本地图片文件发起一次多模态 chat，返回文字描述。docs/12 R2：**优先自身视觉**——
 * 会话提供方勾了视觉（selfVision 接缝）就直接用它自己读（模型自己看图，免配视觉
 * 模型即开即用）；无自身视觉才经用户在「提供方管理」里指定的视觉提供方
 * （providers.json 的 visionProvider）借用。usage 经 SystemToolDeps.reportAuxUsage
 * 计入会话合计（六类守恒，breakdown 全归 other——reportAggregated 先例）。
 */
import { readFileSync } from "node:fs";
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import type { Tool } from "../../../tools/registry.ts";
import { resolveTarget } from "../../../core/file-tools.ts";
import { createProvider } from "../../../providers/store.ts";
import type { ChatImage } from "../../../llm/provider.ts";
// 视觉分析超时（阶段 B 第二批阈值键 visionTimeoutMs）：config.ts 单一出处（initConfig 热重绑）
import { VISION_TIMEOUT_MS } from "../../../config.ts";

/** 单图大小上限：base64 后 ~10.7MB，请求体可控。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** magic bytes → mime（四种双端点通吃格式）；不认识返回 null。 */
function sniffImage(buf: Uint8Array): ChatImage["mime"] | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif"; // GIF8
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
    return "image/webp"; // RIFF....WEBP
  return null;
}

const def: SystemToolDef = {
  name: "view_image",
  summary: "分析一张本地图片文件（PNG/JPEG/GIF/WEBP，≤8MB）返回文字描述（优先用当前模型自身视觉，无视觉时借用配置的视觉模型）",
  create(deps): Tool {
    return {
      name: "view_image",
      description:
        "分析工作区磁盘上的一张图片文件（截图/照片/图表/报错对话框等都适用），返回文字描述。" +
        "注意：对话消息里直接携带的图片你已经直接看到，无需也不应调用本工具——本工具只用于读取磁盘上的图片文件路径" +
        "（有视觉能力时直接用你自身的视觉读取；无视觉能力时借用用户配置的视觉模型）。" +
        "视觉模型由用户在提供方管理里配置（未配置会返回配置指引）。question 写清要看什么——越具体描述越有用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "图片文件路径（相对工作区根，或绝对路径）" },
          question: { type: "string", description: "要视觉模型回答的问题（如「图里的报错信息是什么」「这个图表的趋势结论」）" },
        },
        required: ["path", "question"],
      },
      async execute(args) {
        const question = String(args.question ?? "").trim();
        if (!question) return "错误：question 不能为空——写清要视觉模型看什么、回答什么。";
        let abs: string;
        try {
          abs = resolveTarget(deps.workspace().root, String(args.path ?? "")).abs;
        } catch (e) {
          return `错误：${e instanceof Error ? e.message : String(e)}`;
        }
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch (e) {
          return `错误：图片读取失败（${e instanceof Error ? e.message : String(e)}）——检查路径是否存在。`;
        }
        if (buf.length > MAX_IMAGE_BYTES) {
          return `错误：图片 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 8MB 上限——先用 run_pwsh 压缩或截取关键区域。`;
        }
        const mime = sniffImage(buf.subarray(0, 16));
        if (!mime) return "错误：不支持的图片格式（支持 PNG/JPEG/GIF/WEBP；其他格式先用 run_pwsh 转换）。";
        // docs/12 R2：优先自身视觉——会话模型有视觉时模型自己读（免配视觉模型即开即用）；
        // 无自身视觉才借用用户配置的视觉模型（docs/10 R3 原路径）。
        const selfCfg = deps.selfVision?.() ?? null;
        const visionCfg = selfCfg ?? deps.vision?.() ?? null;
        if (!visionCfg) {
          return (
            "错误：无法看图——当前模型没有视觉能力，且未配置视觉模型。请在界面「提供方管理」里给支持视觉的提供方勾选「视觉能力」，" +
            "并在面板顶部「视觉模型」下拉选中它，然后重试（或为当前会话换用有视觉能力的模型）。"
          );
        }
        const image: ChatImage = { mime, data: buf.toString("base64") };
        try {
          const provider = createProvider(visionCfg, deps.ctx.providerFormats);
          const r = await provider.chat({
            messages: [{ role: "user", content: `请分析这张图片并回答。问题：${question}`, images: [image] }],
            effort: visionCfg.effort === "off" ? "off" : "default", // 遵循该提供方自身配置；仅显式 off 保持关
            signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
          });
          const text = r.content.trim();
          if (!text) return "错误：视觉模型返回了空回复，请重试或换一张更清晰的图片。";
          if (r.usage) {
            deps.reportAuxUsage?.({
              ...r.usage,
              breakdown: {
                systemPrompt: 0,
                skills: 0,
                systemTools: 0,
                mcp: 0,
                messages: 0,
                other: r.usage.promptTokens, // 输入构成（图片+问题）不属会话上下文分类，差额归 other（守恒）
              },
            });
          }
          const cost = r.usage ? `；消耗输入 ${r.usage.promptTokens} / 输出 ${r.usage.completionTokens} tokens` : "";
          const by = selfCfg ? `本会话模型 ${visionCfg.name} 自身视觉` : `视觉模型 ${visionCfg.name}`;
          return `${text}\n\n（由${by} 分析${cost}）`;
        } catch (e) {
          return `错误：视觉分析失败（${e instanceof Error ? e.message : String(e)}）——检查视觉提供方配置（${visionCfg.name}）与网络后重试。`;
        }
      },
    };
  },
};

export const toolViewImage: HarnessModule = {
  name: "tools.view-image",
  setup(ctx) {
    ctx.tools.register(def);
  },
};
