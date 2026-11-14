import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillMd, scanSkills, skillListText } from "./skills.ts";
import type { ToolContext } from "../tools/registry.ts";

const NO_CTX = {} as ToolContext;

test("parseSkillMd 解析 frontmatter 的 name/description", () => {
  const m = parseSkillMd("---\nname: demo\ndescription: 演示技能\n---\n\n正文内容");
  assert.equal(m.name, "demo");
  assert.equal(m.description, "演示技能");
  assert.deepEqual(parseSkillMd("没有 frontmatter 的普通文本"), {});
  assert.equal(parseSkillMd("---\nname: \"带引号\"\n---\nx").name, "带引号");
});

test("scanSkills：全局+工作区合并，同名工作区覆盖，缺 name 用目录名", () => {
  const g = mkdtempSync(join(tmpdir(), "sk-g-"));
  const w = mkdtempSync(join(tmpdir(), "sk-w-"));
  mkdirSync(join(g, "alpha"));
  writeFileSync(join(g, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 全局版\n---\n正文");
  mkdirSync(join(g, "beta"));
  writeFileSync(join(g, "beta", "SKILL.md"), "---\ndescription: 无名字用目录名\n---\n正文");
  mkdirSync(join(g, "empty")); // 无 SKILL.md，跳过
  mkdirSync(join(w, "alpha"));
  writeFileSync(join(w, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 工作区版\n---\n正文");

  const skills = scanSkills([
    { dir: g, source: "global" },
    { dir: w, source: "workspace" },
  ]);
  assert.deepEqual(skills.map((s) => s.name), ["alpha", "beta"]);
  const alpha = skills.find((s) => s.name === "alpha");
  assert.equal(alpha?.source, "workspace");
  assert.equal(alpha?.description, "工作区版");
  assert.equal(skills.find((s) => s.name === "beta")?.name, "beta"); // frontmatter 缺 name → 目录名
  assert.equal(scanSkills([{ dir: join(g, "not-exist"), source: "global" }]).length, 0);
});

test("skillListText：无技能返回 null，有技能时列出清单", () => {
  assert.equal(skillListText([]), null);
  const text = skillListText([{ name: "demo", description: "d", path: "p", source: "global" }]);
  assert.ok(text?.includes("- demo：d"));
  assert.ok(text?.includes("load_skill"));
});

