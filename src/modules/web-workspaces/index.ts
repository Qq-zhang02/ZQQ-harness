/**
 * web.workspaces 模块（模块化架构重构 §4.10）：工作区选择/删除/排序 + 目录浏览。
 * 列表状态（recentWorkspaces）由壳持有，经 host.recentWorkspaces()/setRecentWorkspaces()
 * 读写；绑定与会话创建经 host.bindWorkspace / host.newSessionForView。
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  forgetWorkspace,
  sameDir,
  reorderWorkspaces,
  workspacesFilePath,
} from "../../web/workspaces.ts";
import type { HarnessModule } from "../../core/module.ts";

export const webWorkspaces: HarnessModule = {
  name: "web.workspaces",
  setup(ctx) {
    const host = ctx.sessionHost!;
    const workspacesFile = workspacesFilePath(ctx.paths.userDir);

    // 目录浏览（工作区选择器用）
    ctx.routes.register({
      method: "GET",
      path: "/api/browse",
      handler(r) {
        const p = resolve(r.url.searchParams.get("path") ?? process.cwd());
        const st = statSync(p, { throwIfNoEntry: false });
        if (!st?.isDirectory()) {
          r.json(400, { error: `不是有效目录：${p}` });
          return;
        }
        const dirs = readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("$"))
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
        const parent = dirname(p);
        r.json(200, { current: p, parent: parent === p ? null : parent, dirs });
      },
    });

    // 选择工作区 = 在该工作区开一个新会话并切换视图；其他会话（含运行中的）不受影响
    ctx.routes.register({
      method: "POST",
      path: "/api/workspace",
      async handler(r) {
        const body = await r.body();
        const p = resolve(String(body.path ?? "").trim());
        const st = statSync(p, { throwIfNoEntry: false });
        if (!st?.isDirectory()) {
          r.json(400, { error: `不是有效目录：${p}` });
          return;
        }
        const cur = host.viewRt();
        // P1-4（docs/28）：当前查看会话还没有任何用户消息（引导态或空占位）→ 一律就地换绑
        // ——反复点工作区不再"新建+清扫"（旧路径每次 createRuntime+存档+全量清扫，切换卡顿
        // 的放大器）；空占位换绑与新建空会话用户可见行为等价（侧边栏条目跟着工作区走）。
        const hasUserMsg = cur.agent.messages.some((m) => m.role === "user");
        if (cur.workspace && hasUserMsg) {
          host.persistSession(cur); // 归档当前查看对话（属于旧工作区）
          await host.newSessionForView(p);
        } else {
          await host.bindWorkspace(cur, p); // 引导会话/空占位就地绑定，避免堆积空白会话
        }
        host.broadcast("sessions", host.sessionsPayload());
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, host.currentState(host.viewRt()));
      },
    });

    // 删除工作区：从列表移除，其中对话全部转入回收站；正在该工作区运行的任务不允许删除
    ctx.routes.register({
      method: "POST",
      path: "/api/workspace/delete",
      async handler(r) {
        const body = await r.body();
        const p = resolve(String(body.path ?? "").trim());
        const busyHere = host
          .busyIds()
          .some((id) => {
            const rt = host.runtimes().get(id);
            return rt?.workspace ? sameDir(rt.workspace.root, p) : false;
          });
        if (busyHere) {
          r.json(409, { error: "该工作区有任务正在运行，无法删除" });
          return;
        }
        if (!host.recentWorkspaces().some((w) => sameDir(w, p))) {
          r.json(404, { error: "工作区不在列表中" });
          return;
        }
        host.setRecentWorkspaces(forgetWorkspace(workspacesFile, host.recentWorkspaces(), p));
        const moved = host.sessions().recycleWorkspace(p);
        const wasCurrent = host.viewRt().workspace !== null && sameDir(host.viewRt().workspace!.root, p);
        if (wasCurrent) {
          // 退出该工作区：切到全新的引导会话（其他会话运行态不受影响）
          await host.switchToBlankRuntime();
        }
        host.broadcast("sessions", host.sessionsPayload());
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, { moved, cleared: wasCurrent, workspace: p });
      },
    });

    // 工作区手动排序（工作区树拖动后前端发完整路径顺序）
    ctx.routes.register({
      method: "POST",
      path: "/api/workspaces/reorder",
      async handler(r) {
        const body = await r.body();
        const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : [];
        host.setRecentWorkspaces(reorderWorkspaces(workspacesFile, host.recentWorkspaces(), ids));
        host.broadcast("state", host.currentState(host.viewRt()));
        host.broadcast("sessions", host.sessionsPayload());
        r.json(200, host.sessionsPayload());
      },
    });
  },
};
