/**
 * 技能机制（模块化架构重构 §4.8/§10，自 src/skills/skills.ts 归位 core）：
 * 目录约定 <技能目录>/<技能名>/SKILL.md。SKILL.md 头部 frontmatter 提供
 * name/description，正文是模型照做的完整说明。扫描目录来自 ctx.skillSources
 * 注册的来源（global = ~/.ZQQ-harness/skills，workspace = <工作区根>/skills，
 * 同名时后扫描的来源覆盖先前的）。系统提示只注入技能清单，模型按需用
 * load_skill 工具加载全文，避免常驻 token 开销。load_skill 能力本体在
 * modules/tools/load-skill/。
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 来源名（"global" | "workspace" | 未来值），P5 起随注册表放宽为 string */
  source: string;
}

export interface SkillDir {
  dir: string;
  source: string;
}

/** 解析 SKILL.md 头部 `---` 包围的 frontmatter（只认 name/description 两个键）。 */
export function parseSkillMd(text: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const v = kv[2].trim().replace(/^["']|["']$/g, "");
      if (v) out[kv[1] as "name" | "description"] = v;
    }
  }
  return out;
}

/** 扫描技能目录；按给定顺序扫描，同名后者覆盖前者（注册表 key 序=global 先、workspace 后）。frontmatter 缺 name 时用目录名。 */
export function scanSkills(dirs: SkillDir[]): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const { dir, source } of dirs) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const md = join(dir, ent.name, "SKILL.md");
      if (!existsSync(md)) continue;
      let meta: ReturnType<typeof parseSkillMd>;
      try {
        meta = parseSkillMd(readFileSync(md, "utf8"));
      } catch {
        continue; // 读取失败跳过
      }
      const name = meta.name ?? ent.name;
      byName.set(name, { name, description: meta.description ?? "", path: md, source });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能清单注入系统提示的文本；无技能返回 null（不占 token）。 */
export function skillListText(skills: SkillInfo[]): string | null {
  if (skills.length === 0) return null;
  return (
    "# 可用技能\n" +
    "下列技能与当前任务相关时，先调用 load_skill 工具加载完整说明，再按说明执行：\n" +
    skills.map((s) => `- ${s.name}：${s.description || "（无描述）"}`).join("\n")
  );
}

/**
 * 由技能来源定义解析扫描目录（P5：server 的技能目录数组改由 ctx.skillSources 驱动）。
 * 不适用的来源（如无工作区时的 workspace 来源）dir() 返回 null，剔除。
 */
export function skillDirsOf(
  sources: ReadonlyArray<{ name: string; dir(workspaceRoot: string | null): string | null }>,
  workspaceRoot: string | null,
): SkillDir[] {
  const out: SkillDir[] = [];
  for (const s of sources) {
    const d = s.dir(workspaceRoot);
    if (d !== null) out.push({ dir: d, source: s.name });
  }
  return out;
}
