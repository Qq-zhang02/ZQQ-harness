/**
 * web.approval 模块（模块化架构重构 §4.10）：审批决议端点。
 * 会话的 pendingApproval 决议经 ctx.sessionHost 触达（模块↔壳唯一通道）。
 * fail-closed：野值/缺失一律归一化为 unavailable（按拒绝处理）。
 */
import { normalizeDecision } from "../../approval/types.ts";
import type { HarnessModule } from "../../core/module.ts";

export const webApproval: HarnessModule = {
  name: "web.approval",
  setup(ctx) {
    const host = ctx.sessionHost!;
    ctx.routes.register({
      method: "POST",
      path: "/api/approval",
      async handler(r) {
        const body = await r.body();
        const rt = host.runtimes().get(String(body.sessionId ?? "")) ?? host.viewRt();
        if (!rt.pendingApproval) {
          r.json(409, { error: "当前没有待批准的命令" });
          return;
        }
        // fail-closed：野值/缺失一律归一化为 unavailable（按拒绝处理）
        rt.pendingApproval(normalizeDecision(body.decision));
        r.json(202, { ok: true });
      },
    });
  },
};
