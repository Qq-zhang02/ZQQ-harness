/** 用户数据目录 ~/.ZQQ-harness：sessions/、workspaces.json、全局 mcp.json 都放这里。 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 确保用户数据目录存在；顺带把旧版本放在项目根的用户数据迁移过来（只迁不覆盖；跨盘时复制后删除）。 */
export function ensureUserDir(projectRoot: string): string {
  const dir = join(homedir(), ".ZQQ-harness");
  mkdirSync(dir, { recursive: true });
  const moves: Array<[string, string]> = [
    [join(projectRoot, ".credentials.yaml"), join(dir, ".credentials.yaml")],
    [join(projectRoot, "sessions"), join(dir, "sessions")],
    [join(projectRoot, "workspaces.json"), join(dir, "workspaces.json")],
    [join(projectRoot, "mcp.json"), join(dir, "mcp.json")],
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
