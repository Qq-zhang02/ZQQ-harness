/**
 * web.sessions 模块（模块化架构重构 §4.10）：会话与运行轮的全部端点——
 * 列表/装载/新建/删除/排序/恢复/清空、对话轮（chat/stop）、会话设置、
 * 技能热重载、手动压缩。运行轮机器经 ctx.sessionHost 触达，模块不持有状态。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { COMPACTION_MANUAL_KEEP_TOKENS, IMAGE_RULES } from "../../config.ts";
import { normalizeEffort } from "../../providers/store.ts";
import { rememberWorkspace, sameDir, workspacesFilePath } from "../../web/workspaces.ts";
import { applySubagentControl } from "../../web/subagents.ts";
import { applyPermissionPatch, takeCoordinatorTurnText } from "../../web/session-lifecycle.ts";
import type { HarnessModule } from "../../core/module.ts";
import type { ChatImage } from "../../llm/provider.ts";

/** /api/chat 的 images 校验（docs/10 R3）：≤4 张、mime 白名单、base64、单张解码后 ≤5MB
 *  ——规则数字单一出处 = config.IMAGE_RULES（docs/22 §4.1，文案插值渲染不变）。
 *  合法返回 { images }（空数组/缺省 = 无图）；非法返回 { error }。 */
function parseChatImages(raw: unknown): { images?: ChatImage[]; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.length === 0) return { error: "images 必须是非空数组（无图请省略该字段）" };
  if (raw.length > IMAGE_RULES.maxCount) return { error: `一次最多携带 ${IMAGE_RULES.maxCount} 张图片` };
  const out: ChatImage[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") return { error: "images 数组元素必须是 { mime, data }" };
    const v = x as Record<string, unknown>;
    const mime = String(v.mime ?? "");
    const data = typeof v.data === "string" ? v.data : "";
    if (!IMAGE_RULES.mimes.includes(mime)) return { error: `不支持的图片格式 ${mime || "(空)"}（支持 PNG/JPEG/GIF/WEBP）` };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: "图片 data 必须是 base64 字符串（无 data: 前缀）" };
    if ((Math.floor(data.length / 4) * 3) > IMAGE_RULES.maxBytes) return { error: `单张图片超过 ${IMAGE_RULES.maxBytes / (1024 * 1024)}MB 上限` };
    out.push({ mime: mime as ChatImage["mime"], data });
  }
  return { images: out };
}

export const webSessions: HarnessModule = {
  name: "web.sessions",
  setup(ctx) {
    const host = ctx.sessionHost!;
    const workspacesFile = workspacesFilePath(ctx.paths.userDir);

    ctx.routes.register({
      method: "GET",
      path: "/api/sessions",
      handler(r) {
        r.json(200, host.sessionsPayload());
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/chat",
      async handler(r) {
        const body = await r.body();
        const rt = host.viewRt();
        const text = String(body.text ?? "").trim();
        if (!text) {
          r.json(400, { error: "内容为空" });
          return;
        }
        if (!rt.workspace) {
          r.json(409, { error: "请先在左侧选择工作区" });
          return;
        }
        // docs/10 R3：图片校验（普通发送路径与 busy 分支都要先过）；非法直接 400
        const imgs = parseChatImages(body.images);
        if (imgs.error) {
          r.json(400, { error: imgs.error });
          return;
        }
        const images = imgs.images;
        if (rt.busy) {
          // 运行中不带图（docs/10 §0.2 边界：interim/排队消息纯文本）——防御前端 busy 态上传
          if (images) {
            r.json(409, { error: "任务运行中不支持发送图片——请等本轮完成后重试" });
            return;
          }
          // W2-L2（docs/8 §1.3）：协调者 busy 期消息优先走 interim 旁路即时应答（Agent 在
          // 工具等待窗口内发起一次不带 tools 的 chat，流式回 UI 并缓冲，轮末合并进历史）；
          // 不在窗口/在飞/失败一律落 inbox 兜底（W2-L1 语义：📩 行 + 轮末排空）——
          // "busy"（interim 在飞）的简化处理也直接落 inbox：回应晚到轮末，不做会话级
          // interim 串行链（approvalChain 先例），选型见 docs/8 实施记录。
          // 普通会话维持 409（防轮中变更撕裂状态，docs/4 语义）。
          if (rt.kind === "coordinator") {
            const mode = await rt.agent.interject(text);
            if (mode === "ok") {
              r.json(202, { ok: true, mode: "interim" });
              return;
            }
            (rt.inbox ??= []).push(text);
            host.broadcast("info", { sessionId: rt.id, message: "📩 已入队（当前任务结束后处理）：" + text });
            r.json(202, { ok: true, mode: "queued" });
            return;
          }
          r.json(409, { error: "该对话任务进行中，请等待完成或先停止" });
          return;
        }
        // 非忙碌但队列有余（被中止轮的遗留）：并入队列保持 FIFO，从队首消费（带图消息不排队——
        // inbox 只存文本，直接开轮保证图片不丢）。docs/16：队头及其后连续的自动送达报告
        // 合并为一条只开一轮（与轮末排空同口径）。
        if (rt.kind === "coordinator" && rt.inbox?.length && !images) {
          rt.inbox.push(text);
          host.startTurn(rt, takeCoordinatorTurnText(rt));
        } else {
          host.startTurn(rt, text, images);
        }
        r.json(202, { ok: true });
      },
    });

    // W2-S（docs/7 §2.3）：手动暂停/恢复运行中的子代理（前端抽屉行的 ⏸/▶ 按钮）。
    // docs/9：增 archive（前端抽屉行「归档」按钮/协调者工具共用）——空闲可复用立即归档，
    // 执行/暂停中=中止当前任务后归档。只操作内存运行态的活动登记——worker 运行实例不跨
    // 重启存活（docs/17：休眠的可复用记录由 agent_followup 从存档自动唤醒），不在内存的
    // 会话按无活动处理。
    ctx.routes.register({
      method: "POST",
      path: "/api/subagent/control",
      async handler(r) {
        const body = await r.body();
        const action = body.action === "stop" ? ("stop" as const) : body.action === "archive" ? ("archive" as const) : null;
        if (!action) {
          r.json(400, { error: "action 必须是 stop 或 archive" });
          return;
        }
        const rt = host.runtimes().get(String(body.sessionId ?? ""));
        if (!rt) {
          r.json(404, { error: "会话不在内存（服务可能已重启）——运行中的子代理不跨重启存活" }); // docs/17：休眠的可复用记录 followup 可唤醒
          return;
        }
        const subIdRaw = body.subId;
        const subId = subIdRaw === undefined || subIdRaw === null ? undefined : Number(subIdRaw);
        const name = body.name === undefined || body.name === null ? undefined : String(body.name).trim();
        if (subId === undefined && !name) {
          r.json(400, { error: "需要 subId 或 name 之一" });
          return;
        }
        if (subId !== undefined && (!Number.isInteger(subId) || subId < 1)) {
          r.json(400, { error: "subId 不合法" });
          return;
        }
        // docs/11 W1：界面入口标记 via:"ui"——空闲归档等协调者不可见的异常变动会向其收件箱
        // 送达状态通知（工具路径的返回文案本身已抵达协调者，不重复送）。
        const message = applySubagentControl(rt, subId !== undefined ? { subId, ...(name ? { name } : {}) } : { name: name! }, action, "ui");
        const ok = !message.startsWith("没有匹配") && !message.startsWith("错误");
        r.json(ok ? 200 : 404, { ok, message });
      },
    });

    // docs/10 R1 修订（一直显示）：子代理实时上下文占用的轻量查询——前端抽屉对运行中
    // worker 定时轮询（列表行 ⚠ 档位刷新），不拉全量 transcript。run 态实时估算、
    // idle 态收尾快照；不在内存（已归档/重启后休眠）按 404 + 存档记录兜底。
    ctx.routes.register({
      method: "GET",
      path: "/api/subagent/context",
      async handler(r) {
        const sessionId = String(r.url.searchParams.get("sessionId") ?? "");
        const subIdRaw = String(r.url.searchParams.get("subId") ?? "");
        if (!/^\d+$/.test(subIdRaw)) {
          r.json(400, { error: "subId 不合法" });
          return;
        }
        const subId = Number(subIdRaw);
        const rt = host.runtimes().get(sessionId);
        const handle = rt?.activeSubagents.get(subId);
        if (handle) {
          const pct = handle.liveContextPct?.();
          const ms = handle.liveElapsedMs?.();
          r.json(200, {
            ok: true,
            status: handle.status,
            ...(pct !== undefined ? { contextPct: pct } : {}),
            ...(handle.taskStartedAt !== undefined ? { taskStartedAt: handle.taskStartedAt } : {}),
            ...(ms !== undefined ? { elapsedMs: ms } : {}),
          });
          return;
        }
        // 句柄不在：已归档/一次性已结束 → 回存档记录的收尾快照（展示仍有数）
        const rec = rt?.subagents.find((s) => s.subId === subId) ?? host.sessions().load(sessionId)?.subagents?.find((s) => s.subId === subId);
        if (rec) {
          r.json(200, {
            ok: true,
            status: "archived",
            ...(rec.contextPct !== undefined ? { contextPct: rec.contextPct } : {}),
            ...(rec.elapsedMs !== undefined ? { elapsedMs: rec.elapsedMs } : {}),
          });
          return;
        }
        r.json(404, { error: "子代理不存在" });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/stop",
      async handler(r) {
        const body = await r.body();
        const rt = host.runtimes().get(String(body.sessionId ?? "")) ?? host.viewRt();
        rt.abortCtl?.abort();
        r.json(202, { ok: true });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/settings",
      async handler(r) {
        const body = await r.body();
        const rt = host.viewRt();
        // docs/30：权限三键（askMode/alwaysConfirm/sandboxMode）运行中也放行——工具 live 读
        // deps，下一命令即生效；busy 时补丁不落盘（轮末自动存档兜底）。其余键（effort）维持
        // 运行中 409（请求在飞，改档位口径不清）；busy 下混发权限键+effort 整体拒绝（fail-closed）。
        const touchesPermission =
          body.askMode !== undefined || body.alwaysConfirm !== undefined || body.sandboxMode !== undefined;
        if (rt.busy && (!touchesPermission || body.effort !== undefined)) {
          r.json(409, { error: "该对话任务运行中无法更改设置" });
          return;
        }
        // 白名单校验在 applyPermissionPatch 内逐键归一化（野值忽略该键，不整包拒绝）
        if (touchesPermission) applyPermissionPatch(host, rt, body);
        const nextEffort = normalizeEffort(body.effort);
        if (nextEffort) {
          rt.settings.effort = nextEffort;
          host.persistSession(rt); // 思考档位按对话记录，立即写入存档
        }
        if (!touchesPermission) host.broadcast("state", host.currentState(rt)); // 补丁路径已随 applyPermissionPatch 广播
        r.json(200, host.currentState(rt));
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/skills/rescan",
      async handler(r) {
        const skills = host.rescanSkills(host.viewRt());
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, { skills: skills.map((s) => s.name) });
      },
    });

    // 切换正在查看的会话：目标常驻内存则直接切（后台运行不受影响），否则从磁盘装载
    ctx.routes.register({
      method: "POST",
      path: "/api/sessions/load",
      async handler(r) {
        const body = await r.body();
        const target = await host.switchView(String(body.id ?? ""));
        if (!target) {
          r.json(404, { error: "会话不存在或已损坏" });
          return;
        }
        host.broadcast("sessions", host.sessionsPayload());
        r.json(200, { sessionId: host.viewId(), messages: target.agent.messages, state: host.currentState(target) });
      },
    });

    // worker 全程过程存档（docs/6 P3 方案 A）+ 运行中实时历史（docs/8 第三棒）：只读。
    // 会话不在内存（重启/未查看）时落回磁盘存档；有活动句柄（docs/9：含运行中与空闲待命
    // 的可复用 worker——磁盘 transcript 按任务结束落盘，运行中新任务期间会落后于内存）
    // → 优先返回其实时历史（live:true，前端抽屉详情页轮询——刷新/切回后进度记录不丢）；
    // 文件路径一律经 sessions.spillDir(sessionId) 收口（sessionId 需为合法 UUID）+
    // 相对路径防穿越纵深（存档是自己写的，仍不信任其内容）。
    ctx.routes.register({
      method: "GET",
      path: "/api/subagent-transcript",
      async handler(r) {
        const sessionId = String(r.url.searchParams.get("sessionId") ?? "");
        const subIdRaw = String(r.url.searchParams.get("subId") ?? "");
        if (!/^\d+$/.test(subIdRaw)) {
          r.json(400, { error: "subId 不合法" });
          return;
        }
        const subId = Number(subIdRaw);
        const rt = host.runtimes().get(sessionId);
        const handle = rt?.activeSubagents.get(subId);
        const live = handle?.liveMessages?.();
        if (live && live.length > 0) {
          // docs/10 R1 修订：live 分支顺带实时上下文占用与运行计时（详情页轮询随取随显）
          const pct = handle?.liveContextPct?.();
          const ms = handle?.liveElapsedMs?.();
          r.json(200, {
            messages: live,
            live: true,
            ...(pct !== undefined ? { contextPct: pct } : {}),
            ...(handle?.taskStartedAt !== undefined ? { taskStartedAt: handle.taskStartedAt } : {}),
            ...(ms !== undefined ? { elapsedMs: ms } : {}),
          });
          return;
        }
        const rec =
          rt?.subagents.find((s) => s.subId === subId) ??
          host.sessions().load(sessionId)?.subagents?.find((s) => s.subId === subId);
        if (!rec?.transcript) {
          r.json(404, { error: "该子代理没有过程存档（可能已被清理或未落盘成功）" });
          return;
        }
        const base = host.sessions().spillDir(sessionId);
        if (!base) {
          r.json(400, { error: "sessionId 不合法" });
          return;
        }
        const file = resolve(base, rec.transcript);
        const rel = relative(base, file);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          r.json(400, { error: "存档路径不合法" });
          return;
        }
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as { messages?: unknown };
          if (!Array.isArray(parsed.messages)) throw new Error("bad shape");
          r.json(200, { messages: parsed.messages });
        } catch {
          r.json(404, { error: "过程存档不存在或已损坏" });
        }
      },
    });

    // 新对话 = 在当前查看会话的工作区开新会话并切换视图。
    // kind 白名单：仅 "coordinator" 有效（协调者会话，docs/5 D9），其余值（含缺省）一律 normal。
    ctx.routes.register({
      method: "POST",
      path: "/api/sessions/new",
      async handler(r) {
        const body = await r.body();
        const ws = host.viewRt().workspace?.root ?? null;
        const kind = body.kind === "coordinator" ? "coordinator" : "normal";
        const rt = await host.newSessionForView(ws, kind);
        if (!rt) {
          r.json(409, { error: "请先在左侧选择工作区" });
          return;
        }
        host.broadcast("sessions", host.sessionsPayload());
        r.json(202, { ok: true });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/sessions/delete",
      async handler(r) {
        const body = await r.body();
        const id = String(body.id ?? "");
        const target = host.runtimes().get(id);
        if (target?.busy) {
          r.json(409, { error: "该对话任务运行中，无法删除" });
          return;
        }
        const wsRoot = target?.workspace?.root ?? null; // 先取再删：删除后 map 可能已空
        host.runtimes().delete(id);
        host.sessions().delete(id);
        if (id === host.viewId()) {
          await host.newSessionForView(wsRoot);
        }
        host.broadcast("sessions", host.sessionsPayload());
        r.json(202, { ok: true });
      },
    });

    // 会话手动排序（拖动后前端发完整顺序；允许对列表内任意工作区排序，不要求是当前选中的）
    ctx.routes.register({
      method: "POST",
      path: "/api/sessions/reorder",
      async handler(r) {
        const body = await r.body();
        const ws = resolve(String(body.workspace ?? "").trim());
        const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : [];
        // 孤儿组（会话仍在、工作区已被移出 workspaces.json）也在树里渲染成组——可见即应可拖，
        // 只拒绝既不在列表、也没有任何会话的未知路径（防脏写 order.json）
        const known =
          host.recentWorkspaces().some((w) => sameDir(w, ws)) ||
          host.sessions().list().some((s) => !s.recycled && sameDir(s.workspace, ws));
        if (!known) {
          r.json(400, { error: "工作区不在列表中" });
          return;
        }
        host.sessions().setOrder(ws, ids);
        host.broadcast("sessions", host.sessionsPayload());
        r.json(200, host.sessionsPayload());
      },
    });

    // 从回收站恢复对话（工作区同时回到下拉列表）
    ctx.routes.register({
      method: "POST",
      path: "/api/sessions/restore",
      async handler(r) {
        const body = await r.body();
        const data = host.sessions().restore(String(body.id ?? ""));
        if (!data) {
          r.json(404, { error: "会话不存在" });
          return;
        }
        if (data.workspace) {
          host.setRecentWorkspaces(rememberWorkspace(workspacesFile, host.recentWorkspaces(), data.workspace));
        }
        host.broadcast("sessions", host.sessionsPayload());
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, { ok: true, workspace: data.workspace, title: data.title });
      },
    });

    // 彻底删除回收站中的对话（仅 busy 或正在查看的会话拒绝；空闲的内存缓存连带清除）
    ctx.routes.register({
      method: "POST",
      path: "/api/sessions/purge",
      async handler(r) {
        const body = await r.body();
        const id = String(body.id ?? "");
        const cached = host.runtimes().get(id);
        if (cached && (cached.busy || id === host.viewId())) {
          r.json(400, { error: "该对话正在使用中" });
          return;
        }
        if (cached) host.runtimes().delete(id);
        if (!host.sessions().purge(id)) {
          r.json(404, { error: "会话不存在" });
          return;
        }
        host.broadcast("sessions", host.sessionsPayload());
        r.json(200, { ok: true });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/clear",
      async handler(r) {
        const ws = host.viewRt().workspace?.root ?? null;
        const rt = await host.newSessionForView(ws);
        if (!rt) {
          r.json(409, { error: "请先在左侧选择工作区" });
          return;
        }
        host.broadcast("info", { sessionId: host.viewId(), message: "已开始新对话（原对话已存档）" });
        r.json(202, { ok: true });
      },
    });

    // 压缩触发二（手动 /compact）：只锁该会话自身的运行
    ctx.routes.register({
      method: "POST",
      path: "/api/compact",
      async handler(r) {
        const rt = host.viewRt();
        if (rt.busy) {
          r.json(409, { error: "该对话任务运行中无法压缩，请等待完成或先停止" });
          return;
        }
        if (!rt.workspace) {
          r.json(409, { error: "请先在左侧选择工作区" });
          return;
        }
        // 手动压缩用小保留预算（用户预期"立刻变小"；KEEP_RATIO×上下文长度会几乎切不动）
        const outcome = await host.compact(rt, { keepTokens: COMPACTION_MANUAL_KEEP_TOKENS });
        r.json(200, outcome);
      },
    });
  },
};
