/**
 * skills.fs-source 模块（模块化架构重构 §4.8）：技能来源注册。
 * global = ~/.ZQQ-harness/skills，workspace = <工作区根>/skills（不适用返回 null）。
 * 同名覆盖语义由扫描顺序决定（core/skills.ts scanSkills 后者覆盖前者）；
 * 注册表按 name 排序恰好是 global → workspace，与原数组顺序一致。
 * 新增技能来源的范式：本文件再 register 一个 SkillSourceDef → modules.ts 清单加一行。
 */
import { join } from "node:path";
import type { HarnessModule } from "../../../core/module.ts";

export const skillsFsSource: HarnessModule = {
  name: "skills.fs-source",
  setup(ctx) {
    ctx.skillSources.register({
      name: "global",
      dir: () => ctx.paths.globalSkillsDir,
    });
    ctx.skillSources.register({
      name: "workspace",
      dir: (root) => (root ? join(root, "skills") : null),
    });
  },
};
