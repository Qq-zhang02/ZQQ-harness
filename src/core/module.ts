/**
 * 模块形态与装配器（模块化架构重构 §4.2）：产品 = 组合清单（src/modules.ts 的
 * BUILTIN_MODULES）。按数组顺序 setup；dependsOn 校验依赖已在清单且先装配；
 * 单个模块 setup 抛错 → 进程退出（fail-fast，禁止半装配状态），错误信息带模块名。
 * 模块之间禁止互相 import（契约测试有 import 图哨兵）；共享下沉 core 或经 ctx 交换。
 * P8：外部模块目录装载（loadExternalModules，宽松策略）也属模块装配机制，归本文件。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessContext } from "./context.ts";

export interface HarnessModule {
  /** 如 "providers.openai"、"tools.pwsh" */
  name: string;
  /** 装配器校验依赖已在清单中且先 setup */
  dependsOn?: string[];
  setup(ctx: HarnessContext): void | Promise<void>;
}

export async function loadModules(ctx: HarnessContext, modules: HarnessModule[]): Promise<void> {
  const seen = new Set<string>();
  for (const m of modules) {
    for (const dep of m.dependsOn ?? []) {
      if (!seen.has(dep)) {
        console.error(`模块 ${m.name} 依赖的 ${dep} 不在清单中或尚未装配。请检查 src/modules.ts 组合清单顺序。`);
        process.exit(1);
      }
    }
    try {
      await m.setup(ctx);
    } catch (e) {
      console.error(`模块 ${m.name} 装配失败：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    seen.add(m.name);
  }
}

/**
 * 外部模块目录扫描（P8）：~/.ZQQ-harness/modules/*.ts，每个文件 default 导出一个
 * HarnessModule。宽松装载（沿 loadMcpConfig 宽松层的哲学：坏文件不阻止应用启动）——
 * 导入失败/形态不对/与已有模块重名/依赖不满足 → 打印错误并跳过该文件；setup 抛错
 * 仍由 loadModules fail-fast（此时模块已定位成功，半装配状态必须退出）。
 * 按文件名排序装载保证确定性；available = 尚未装载的可用模块名（依赖校验依据）。
 */
export async function loadExternalModules(dir: string, available: readonly string[]): Promise<HarnessModule[]> {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
  const accepted: HarnessModule[] = [];
  const names = new Set<string>(available);
  for (const f of files) {
    const file = join(dir, f);
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    } catch (e) {
      console.error(`[外部模块] ${f} 导入失败，已跳过：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const m = mod?.default as Partial<HarnessModule> | undefined;
    if (!m || typeof m !== "object" || typeof m.name !== "string" || !m.name.trim() || typeof m.setup !== "function") {
      console.error(`[外部模块] ${f} 缺少合法的 default 导出（需要 name 字符串 + setup 函数的模块对象），已跳过`);
      continue;
    }
    if (names.has(m.name)) {
      console.error(`[外部模块] ${f} 的模块名 "${m.name}" 与已有模块重名，已跳过`);
      continue;
    }
    const missing = (m.dependsOn ?? []).filter((d) => !names.has(d));
    if (missing.length > 0) {
      console.error(
        `[外部模块] ${f}（${m.name}）依赖的 ${missing.join("、")} 不在已装配清单（可能被 harness.json 禁用），已跳过`,
      );
      continue;
    }
    accepted.push(m as HarnessModule);
    names.add(m.name);
  }
  return accepted;
}
