/**
 * web.approval 模块（模块化架构重构 §4.10）：审批决议端点。
 * 会话的 pendingApproval 决议经 ctx.sessionHost 触达（模块↔壳唯一通道）。
 * fail-closed：野值/缺失一律归一化为 unavailable（按拒绝处理）。
 * docs/30：body 可带 apply 权限补丁（审批卡「允许并不再询问 / 解除沙箱并放行」）——
 * 在决议 settle **之前**应用：排队的并行 worker 后卡立即看到新模式，不出现
 * 「批了一张又弹一张」的竞态；busy 是必然（有卡必在轮中），落盘由轮末存档兜底。
 */
import { normalizeDecision } from "../../approval/types.ts";
import { applyPermissionPatch } from "../../web/session-lifecycle.ts";
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
        if (body.apply !== undefined) applyPermissionPatch(host, rt, body.apply);
        // fail-closed：野值/缺失一律归一化为 unavailable（按拒绝处理）
        rt.pendingApproval(normalizeDecision(body.decision));
        r.json(202, { ok: true });
      },
    });
  },
};
