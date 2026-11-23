/**
 * tools.load-skill 模块测试：能力自 skills.test.ts 随 loadSkillTool 迁入（§10 映射）。
 * deps 用真实 buildContext 构造（类型安全），skills 注入临时目录扫描结果；
 * 模块 setup → ctx.tools 注册 → create 实例化，与 server 组装同路径。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolLoadSkill } from "./index.ts";
import { buildContext } from "../../../core/context.ts";
import { createFileLedger } from "../../../core/file-tools.ts";
import { loadConfig } from "../../../config.ts";
import { scanSkills } from "../../../core/skills.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ToolContext } from "../../../tools/registry.ts";

const NO_CTX = {} as ToolContext;

/** 本文件建过的临时目录：全部用例跑完后清掉（此前从不清理，每跑一次 npm test 漏一个 sk-t-*）。 */
const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("load_skill：模块注册 → 每会话实例化 → 按名返回 SKILL.md 全文，未知技能报错", async () => {
  const g = mkdtempSync(join(tmpdir(), "sk-t-"));
  tempDirs.push(g);
  mkdirSync(join(g, "demo"));
  writeFileSync(join(g, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n技能正文XYZ");
  const skills = scanSkills([{ dir: g, source: "global" }]);

  const ctx = buildContext(
    { userDir: g, globalSkillsDir: g, globalMcpFile: join(g, "mcp.json"), workspacesFile: join(g, "w.json"), sessionsDir: join(g, "s") },
    loadConfig(),
  );
  const deps: SystemToolDeps = {
    ctx,
    workspace: () => {
      throw new Error("load_skill 不应使用 workspace");
    },
    skills: () => skills,
    requestApproval: async () => "rejected",
    alwaysConfirm: () => false,
    sandboxMode: () => "workspace-write",
    spillDir: () => undefined,
    privateTempDir: () => undefined,
    mcpStatus: () => [],
    reloadMcp: async () => [],
    ledger: createFileLedger(),
  };

  toolLoadSkill.setup(ctx);
  assert.equal(ctx.tools.require("load_skill").summary, "加载某个技能的完整说明（SKILL.md 全文）");
  const tool = ctx.tools.require("load_skill").create(deps);
  assert.equal(tool.name, "load_skill");

  const out = await tool.execute({ name: "demo" }, NO_CTX);
  assert.ok(out.includes("技能正文XYZ"));
  const miss = await tool.execute({ name: "nope" }, NO_CTX);
  assert.ok(miss.startsWith("错误"));
});
