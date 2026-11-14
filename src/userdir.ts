/** 用户数据目录 ~/.ZQQ-harness：sessions/、workspaces.json、全局 mcp.json 都放这里。 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 用户数据目录名（docs/21 §2.4 单一出处）：src 下不得再拼写该字面量——契约测试哨兵锁定。 */
export const USER_DIR_NAME = ".ZQQ-harness";

/** 用户目录内固定子目录/文件名（docs/21 §2.4 常量组）：server.ts 装配、SessionStore、
 *  config.ts 规范位置定位共用——目录布局变更只改这里。 */
export const USER_DIR_LAYOUT = {
  sessions: "sessions",
  spill: "spill",
  skills: "skills",
  tmp: "tmp",
  modules: "modules",
  workspacesFile: "workspaces.json",
  mcpFile: "mcp.json",
  harnessFile: "harness.json",
  credentialsFile: ".credentials.yaml",
} as const;

/** 确保用户数据目录存在；顺带把旧版本放在项目根的用户数据迁移过来（只迁不覆盖；跨盘时复制后删除）。 */
export function ensureUserDir(projectRoot: string): string {
  const dir = join(homedir(), USER_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const L = USER_DIR_LAYOUT;
  const moves: Array<[string, string]> = [
    [join(projectRoot, L.credentialsFile), join(dir, L.credentialsFile)],
    [join(projectRoot, L.sessions), join(dir, L.sessions)],
    [join(projectRoot, L.workspacesFile), join(dir, L.workspacesFile)],
    [join(projectRoot, L.mcpFile), join(dir, L.mcpFile)],
  ];
  for (const [from, to] of moves) {
    try {
      if (!existsSync(from) || existsSync(to)) continue;
      try {
        renameSync(from, to);
      } catch {
        // 跨盘 rename 会失败（EXDEV），退回复制+删除
        copyFileSync(from, to);
        rmSync(from, { recursive: true, force: true });
      }
    } catch {
      // 迁移失败不影响启动
    }
  }
  return dir;
}
