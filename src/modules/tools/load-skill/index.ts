/**
 * tools.load-skill 模块（模块化架构重构 §4.5/§10）：load_skill 系统工具的注册入口。
 * 能力（读 SKILL.md 全文）自 src/skills/skills.ts 迁入；扫描/解析等机制留在
 * core/skills.ts（P5 已归位，技能目录来自 ctx.skillSources 注册的来源）。
 * 会话技能清单经 SystemToolDeps.skills() 注入——每会话实例化，技能热重载后
 * 新实例拿到最新清单。
 */
import { readFileSync } from "node:fs";
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import type { Tool } from "../../../tools/registry.ts";
// docs/40 阶段二：SKILL.md 属阅读类输出——注册表修剪按 readToolResultMaxChars 取预算
// （超出仍由注册表统一截断 + spill 全文），不再被通用 toolResultMaxChars 锁死
import { THRESHOLDS } from "../../../config.ts";

const def: SystemToolDef = {
  name: "load_skill",
  summary: "加载某个技能的完整说明（SKILL.md 全文）",
  create(deps) {
    return {
      name: "load_skill",
      resultBudget: () => THRESHOLDS.readToolResultMaxChars, // 调用期求值（live binding，docs/40）
      description:
        "加载某个技能的完整说明（SKILL.md 全文）。当任务与系统提示“可用技能”清单中的某项相关时，先调用本工具加载后再照做。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名称，见系统提示的可用技能清单" } },
        required: ["name"],
      },
      async execute(args) {
        const name = String(args.name ?? "").trim();
        const skills = deps.skills();
        const hit = skills.find((s) => s.name === name);
        if (!hit) {
          return `错误：未找到技能 "${name}"。可用技能：${skills.map((s) => s.name).join("、") || "（无）"}`;
        }
        try {
          return readFileSync(hit.path, "utf8");
        } catch (e) {
          return `错误：技能文件读取失败：${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  },
};

export const toolLoadSkill: HarnessModule = {
  name: "tools.load-skill",
  setup(ctx) {
    ctx.tools.register(def);
  },
};
