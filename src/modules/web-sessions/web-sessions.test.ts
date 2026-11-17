/**
 * /api/sessions/new 的 kind 白名单测试（docs/5 SA2 D9）：kind="coordinator" 透传给
 * newSessionForView 建协调者会话；野值/缺省一律归一为 normal。
 * 直接在真实 webSessions 模块 setup 出的路由上调用 handler（桩 sessionHost +
 * 桩 ServerRequest），不起 HTTP 服务。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../core/context.ts";
import { loadConfig, IMAGE_RULES } from "../../config.ts";
import { metaSnapshot } from "../../web/session-runtime.ts";
import { SessionStore } from "../../web/sessions.ts";
import { webSessions } from "./index.ts";
import type { ServerRequest } from "../../core/http.ts";
import type { SessionHost } from "../../core/host.ts";

test("/api/sessions/new kind 白名单：coordinator 透传；野值/缺省归一 normal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const wsRoot = join(dir, "ws");
    const calls: Array<[string | null, "normal" | "coordinator" | undefined]> = [];
    const host = {
      viewRt: () => ({ workspace: { root: wsRoot } }), // handler 只读当前查看会话的工作区根
      newSessionForView: (ws: string | null, kind?: "normal" | "coordinator") => {
        calls.push([ws, kind]);
        return { id: "stub-rt" };
      },
      broadcast: () => {},
      sessionsPayload: () => ({ current: "", viewSeq: 0, running: [], groups: [], recycled: [] }),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/sessions/new");

    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/sessions/new"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    assert.equal((await call({ kind: "coordinator" })).status, 202);
    assert.equal((await call({ kind: "evil" })).status, 202); // 野值不报错：归一为 normal
    assert.equal((await call({})).status, 202);
    assert.deepEqual(calls.map((c) => c[1]), ["coordinator", "normal", "normal"]);
    assert.ok(calls.every(([ws]) => ws === wsRoot), "工作区取当前查看会话的根");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- P3：/api/subagent-transcript 只读路由（docs/6 §3 方案 A） ----------

test("/api/subagent-transcript：记录查找（内存优先→磁盘）、路径收口防穿越、坏形状与缺失的处理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-p3-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const store = new SessionStore(dir);
    const id = "0e0d8f8a-aaaa-4bbb-8ccc-111111111111";
    // 磁盘存档：subId1 有文件、subId2 无存档字段、subId3 记录带穿越路径、subId4 文件缺失
    store.save({
      id,
      title: "协调者档",
      updatedAt: new Date().toISOString(),
      workspace: "F:\ws",
      messageCount: 1,
      messages: [{ role: "user", content: "hi" }],
      totals: { prompt: 0, completion: 0 },
      subagents: [
        { subId: 1, name: "alpha", ok: true, transcript: join("sub-1-alpha", "transcript.json"), at: "2026-11-13T00:00:00.000Z" },
        { subId: 2, name: "beta", ok: true, at: "2026-11-13T00:00:01.000Z" },
        { subId: 3, name: "evil", ok: true, transcript: join("..", "..", "evil.json"), at: "2026-11-13T00:00:02.000Z" },
        { subId: 4, name: "gone", ok: true, transcript: join("sub-4-gone", "transcript.json"), at: "2026-11-13T00:00:03.000Z" },
      ],
    });
    const spill = store.spillDir(id)!;
    mkdirSync(join(spill, "sub-1-alpha"), { recursive: true });
    writeFileSync(join(spill, "sub-1-alpha", "transcript.json"), JSON.stringify({ messages: [{ role: "user", content: "任务书" }] }), "utf8");
    // 内存运行态：subId9 只在内存（验证查找优先级）；subId5 运行中（无完成记录，有活动句柄——第三棒实时历史）；
    // subId10 可复用 worker（docs/9）：记录+磁盘存档都在，但句柄在跑新任务——实时历史必须优先于磁盘
    const memRt = {
      subagents: [
        { subId: 9, name: "mem", ok: true, transcript: join("sub-9-mem", "transcript.json"), at: "2026-11-13T00:00:04.000Z" },
        { subId: 10, name: "reuse", ok: true, reusable: true, tasks: 1, state: "idle", transcript: join("sub-10-reuse", "transcript.json"), at: "2026-11-13T00:00:05.000Z" },
      ],
      activeSubagents: new Map([
        [5, { subId: 5, name: "live", paused: false, status: "run", liveMessages: () => [{ role: "user", content: "运行中任务书" }] }],
        [10, { subId: 10, name: "reuse", paused: false, status: "run", reusable: true, liveMessages: () => [{ role: "user", content: "第二次任务（内存）" }] }],
      ]),
    };
    mkdirSync(join(spill, "sub-9-mem"), { recursive: true });
    writeFileSync(join(spill, "sub-9-mem", "transcript.json"), JSON.stringify({ messages: [{ role: "user", content: "内存任务" }] }), "utf8");
    const host = {
      runtimes: () => new Map([[id, memRt]]),
      sessions: () => store,
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/subagent-transcript");

    const call = async (query: string) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL(`http://localhost/api/subagent-transcript?${query}`),
        body: async () => ({}),
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    assert.equal((await call("sessionId=" + id + "&subId=abc")).status, 400, "subId 非数字");
    assert.equal((await call("sessionId=" + id + "&subId=999")).status, 404, "记录不存在");
    assert.equal((await call("sessionId=" + id + "&subId=2")).status, 404, "记录无 transcript 字段");
    // 第三棒：运行中 worker（无完成记录）→ 活动句柄的实时历史（live:true），完成记录路径不受影响
    const live = await call("sessionId=" + id + "&subId=5");
    assert.equal(live.status, 200, "运行中 worker 走实时历史分支");
    assert.equal((live.data as { live?: boolean }).live, true, "live 标记（前端据此区分存档/实时）");
    assert.equal(((live.data as { messages: { content: string }[] }).messages ?? [])[0]?.content, "运行中任务书");
    assert.equal((await call("sessionId=" + id + "&subId=6")).status, 404, "无记录且无活动句柄 → 404");
    // docs/9：可复用 worker 在跑新任务（记录+磁盘存档都在但落后于内存）→ 句柄实时历史优先
    const okReuse = await call("sessionId=" + id + "&subId=10");
    assert.equal(okReuse.status, 200);
    assert.equal((okReuse.data as { live?: boolean }).live, true, "句柄在 → 实时历史优先（磁盘 transcript 按任务结束才落盘）");
    assert.equal(((okReuse.data as { messages: { content: string }[] }).messages ?? [])[0]?.content, "第二次任务（内存）");
    const okMem = await call("sessionId=" + id + "&subId=9");
    assert.equal(okMem.status, 200, "内存运行态优先查找");
    assert.equal((okMem.data as { messages: { content: string }[] }).messages[0]!.content, "内存任务");
    const okDisk = await call("sessionId=" + id + "&subId=1");
    assert.equal(okDisk.status, 200, "会话不在内存时落回磁盘存档");
    assert.equal((okDisk.data as { messages: { content: string }[] }).messages[0]!.content, "任务书");
    assert.equal((await call("sessionId=" + id + "&subId=3")).status, 400, "记录带穿越路径（../..）被拒");
    assert.equal((await call("sessionId=" + id + "&subId=4")).status, 404, "文件缺失/损坏归 404");
    assert.equal((await call("sessionId=not-a-uuid&subId=1")).status, 404, "非法 sessionId 找不到记录（load 返回 null）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- W2-L1（docs/7 §2.3）：/api/chat busy 协调者入队；W2-S：/api/subagent/control ----------

test("/api/chat：busy 协调者优先 interim 即时应答（ok→mode=interim 不入队；不适用/失败→inbox 兜底 📩）；busy 普通会话仍 409；非忙碌带遗留 inbox 保持 FIFO", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-l1-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const started: string[] = [];
    const broadcasts: { event: string; data: unknown }[] = [];
    // interject 桩（W2-L2）：可切换返回值，默认 not-pending（不在工具等待窗口 → inbox 兜底）
    let interjectMode: "ok" | "busy" | "not-pending" | "failed" = "not-pending";
    const interjected: string[] = [];
    const coordRt = {
      id: "c1",
      kind: "coordinator",
      busy: true,
      workspace: { root: dir },
      agent: {
        interject: async (text: string) => {
          interjected.push(text);
          return interjectMode;
        },
      },
    };
    const normalRt = { id: "n1", kind: "normal", busy: true, workspace: { root: dir } };
    let view: unknown = coordRt;
    const host = {
      viewRt: () => view,
      runtimes: () => new Map(),
      startTurn: (rt: { id: string }, text: string) => started.push(`${rt.id}:${text}`),
      broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
      sessionsPayload: () => ({ current: "", viewSeq: 0, running: [], groups: [], recycled: [] }),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/chat");
    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/chat"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    // busy 协调者 + interject not-pending（W2-L2 默认兜底）→ 入队 + 📩 info 广播，不 startTurn
    const r1 = await call({ text: "  插一句  " });
    assert.equal(r1.status, 202);
    assert.deepEqual(r1.data, { ok: true, mode: "queued" }, "不适用 interim 时落 inbox（W2-L1 语义）");
    assert.deepEqual((coordRt as { inbox?: string[] }).inbox, ["插一句"], "trim 后入队");
    assert.ok(
      broadcasts.some((b) => b.event === "info" && String((b.data as { message?: string }).message).startsWith("📩 已入队")),
      "入队确认经 info 广播（前端 📩 行）",
    );
    // W2-L2：interject ok → 202 mode=interim，不进 inbox、无 📩 广播（delta 由 Agent 直通）
    interjectMode = "ok";
    const r2 = await call({ text: "现在进度如何" });
    assert.equal(r2.status, 202);
    assert.deepEqual(r2.data, { ok: true, mode: "interim" }, "工具等待窗口内走 interim 即时应答");
    assert.deepEqual(interjected, ["插一句", "现在进度如何"], "文本经 trim 后交给 interject");
    assert.deepEqual((coordRt as { inbox?: string[] }).inbox, ["插一句"], "interim 不进 inbox");
    // W2-L2：interject busy/failed 也落 inbox（简化版：不做会话级 interim 串行链）
    interjectMode = "failed";
    const r2b = await call({ text: "再问一句" });
    assert.equal(r2b.status, 202);
    assert.deepEqual(r2b.data, { ok: true, mode: "queued" }, "failed 归 inbox 兜底");
    assert.deepEqual((coordRt as { inbox?: string[] }).inbox, ["插一句", "再问一句"], "排队保 FIFO");
    interjectMode = "not-pending";
    // busy 普通会话 → 409（docs/4 语义不变）
    view = normalRt;
    assert.equal((await call({ text: "x" })).status, 409);
    // 非忙碌协调者 + 队列有遗留 → 并队保 FIFO，从队首开轮
    (coordRt as { busy: boolean }).busy = false;
    (coordRt as { inbox?: string[] }).inbox = ["遗留1"];
    view = coordRt;
    const r3 = await call({ text: "新消息" });
    assert.equal(r3.status, 202);
    assert.deepEqual(started, ["c1:遗留1"], "开的是队首（遗留消息先处理）");
    assert.deepEqual((coordRt as { inbox?: string[] }).inbox, ["新消息"], "新消息留在队尾等待本轮 finally 消费");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/subagent/control：stop/archive 按 subId/name 施控；action/目标/会话校验与 miss 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-ctl-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const events: string[] = [];
    const entry = (subId: number, name: string) => ({
      subId,
      name,
      status: "run",
      stop() {
        events.push(`stop:${name}`);
      },
    });
    // docs/9：可复用句柄（带归档入口）与一次性句柄
    const reuseEntry = { ...entry(3, "wr"), reusable: true, requestArchive: () => (events.push("archive:wr"), "已归档子代理：wr#3。") };
    const rt = { activeSubagents: new Map([[1, entry(1, "wa")], [2, entry(2, "wb")], [3, reuseEntry]]) };
    const host = {
      runtimes: () => new Map([["s1", rt]]),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/subagent/control");
    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/subagent/control"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    assert.equal((await call({ sessionId: "s1", action: "kill", name: "wa" })).status, 400, "action 白名单");
    assert.equal((await call({ sessionId: "nope", action: "stop", name: "wa" })).status, 404, "会话不在内存");
    assert.equal((await call({ sessionId: "s1", action: "stop" })).status, 400, "缺 subId/name");
    assert.equal((await call({ sessionId: "s1", action: "stop", subId: 0 })).status, 400, "subId 不合法");

    const ok = await call({ sessionId: "s1", action: "stop", subId: 1 });
    assert.equal(ok.status, 200);
    assert.equal((ok.data as { ok: boolean }).ok, true);
    assert.deepEqual(events, ["stop:wa"]);
    const byName = await call({ sessionId: "s1", action: "stop", name: "wb" });
    assert.equal(byName.status, 200);
    assert.deepEqual(events, ["stop:wa", "stop:wb"]);
    const miss = await call({ sessionId: "s1", action: "stop", name: "ghost" });
    assert.equal(miss.status, 404, "无匹配 → 404 + 活动清单文案");
    assert.equal((miss.data as { ok: boolean }).ok, false);
    assert.ok(String((miss.data as { message: string }).message).includes("没有匹配"));

    // docs/9：archive 动作——可复用句柄走 requestArchive；一次性句柄给出明确说明（200 + ok）
    const arch = await call({ sessionId: "s1", action: "archive", subId: 3 });
    assert.equal(arch.status, 200);
    assert.deepEqual(events, ["stop:wa", "stop:wb", "archive:wr"]);
    const archOnce = await call({ sessionId: "s1", action: "archive", subId: 1 });
    assert.equal(archOnce.status, 200);
    assert.ok(String((archOnce.data as { message: string }).message).includes("一次性子代理"), archOnce.data as string);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/10 R3：/api/chat 的 images 校验与透传 ----------

test("/api/chat：images 校验（合法透传 startTurn / 非法 400 / 超 4 张拒绝 / busy 带图 409）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-img-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const started: Array<{ id: string; text: string; images?: { mime: string; data: string }[] }> = [];
    const normalRt = { id: "n1", kind: "normal", busy: false, workspace: { root: dir } };
    const host = {
      viewRt: () => normalRt,
      runtimes: () => new Map(),
      startTurn: (rt: { id: string }, text: string, images?: { mime: string; data: string }[]) => started.push({ id: rt.id, text, images }),
      broadcast: () => {},
      sessionsPayload: () => ({ current: "", viewSeq: 0, running: [], groups: [], recycled: [] }),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/chat");
    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/chat"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };
    const goodImg = { mime: "image/png", data: "QUJDRA==" };
    // 合法：单图透传
    const r1 = await call({ text: "这是什么", images: [goodImg] });
    assert.equal(r1.status, 202);
    assert.deepEqual(started[0]!.images, [goodImg], "images 透传 startTurn");
    // 无图：不产生 images 字段（与旧行为一致）
    await call({ text: "纯文本" });
    assert.equal(started[1]!.images, undefined);
    // 非法 mime / 非 base64 / 超 4 张 / 单张超 5MB——错误文案插值渲染不变（docs/22 §4.1 锁定）
    const errMsg = (r: { data: unknown }) => (r.data as { error?: string }).error;
    assert.equal(errMsg(await call({ text: "x", images: [{ mime: "image/bmp", data: "QQ==" }] })), "不支持的图片格式 image/bmp（支持 PNG/JPEG/GIF/WEBP）");
    assert.equal((await call({ text: "x", images: [{ mime: "image/png", data: "not base64!!" }] })).status, 400);
    assert.equal(errMsg(await call({ text: "x", images: [goodImg, goodImg, goodImg, goodImg, goodImg] })), "一次最多携带 4 张图片");
    // base64 长 6990508 → 解码 5242881 字节，刚超 5MB（5242880）上限
    assert.equal(errMsg(await call({ text: "x", images: [{ mime: "image/png", data: "A".repeat(6990508) }] })), "单张图片超过 5MB 上限");
    // busy + 图 → 409（运行中不带图）
    (normalRt as { busy: boolean }).busy = true;
    assert.equal((await call({ text: "x", images: [goodImg] })).status, 409);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("meta 下发 imageRules（docs/22 §4.1）：前端图片规则单一出处 = config.IMAGE_RULES（张数/单张字节/mime 白名单）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-metarules-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const meta = metaSnapshot({ ctx } as Parameters<typeof metaSnapshot>[0]);
    assert.deepEqual(meta.imageRules, IMAGE_RULES, "meta.imageRules 与 config.IMAGE_RULES 同源一致");
    // mime 白名单锁定为 ChatImage["mime"] 联合类型的四值（config.ts 注释引用的锁定点）
    assert.deepEqual(meta.imageRules.mimes, ["image/png", "image/jpeg", "image/gif", "image/webp"]);
    assert.equal(meta.imageRules.maxCount, 4);
    assert.equal(meta.imageRules.maxBytes, 5 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/10 R1 修订：/api/subagent/context 轻量查询（运行中实时占比） ----------

test("/api/subagent/context：活动句柄实时值（liveContextPct）、归档回存档快照、不存在 404；live transcript 分支带 contextPct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-ctx-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const rt = {
      id: "s1",
      kind: "coordinator",
      activeSubagents: new Map([
        [1, { subId: 1, name: "w1", paused: false, status: "run", liveContextPct: () => 42, liveMessages: () => [{ role: "user", content: "t" }] }],
        [2, { subId: 2, name: "w2", paused: false, status: "idle", contextPct: 12, liveContextPct: () => 12, liveMessages: () => [{ role: "user", content: "t" }] }],
      ]),
      subagents: [{ subId: 3, name: "old", ok: true, state: "archived", contextPct: 66, at: "2026-01-01T00:00:00Z" }],
    };
    const host = {
      viewRt: () => rt,
      runtimes: () => new Map([["s1", rt]]),
      broadcast: () => {},
      sessions: () => ({ load: () => null, spillDir: () => join(dir, "spill", "s1") }),
      sessionsPayload: () => ({ current: "", viewSeq: 0, running: [], groups: [], recycled: [] }),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const call = async (path: string) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost" + path),
        body: async () => ({}),
        json: (status, data) => responses.push({ status, data }),
      };
      await ctx.routes.get(path.split("?")[0])!.handler(r);
      return responses[0]!;
    };
    // 运行中句柄 → 实时估算值
    const r1 = await call("/api/subagent/context?sessionId=s1&subId=1");
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.data, { ok: true, status: "run", contextPct: 42 });
    // idle 句柄 → 快照
    const r2 = await call("/api/subagent/context?sessionId=s1&subId=2");
    assert.deepEqual(r2.data, { ok: true, status: "idle", contextPct: 12 });
    // 句柄不在（已归档）→ 存档记录快照
    const r3 = await call("/api/subagent/context?sessionId=s1&subId=3");
    assert.deepEqual(r3.data, { ok: true, status: "archived", contextPct: 66 });
    // 不存在 → 404；坏 subId → 400
    assert.equal((await call("/api/subagent/context?sessionId=s1&subId=99")).status, 404);
    assert.equal((await call("/api/subagent/context?sessionId=s1&subId=abc")).status, 400);
    // transcript 的 live 分支带 contextPct（详情页轮询随取随显）
    const r5 = await call("/api/subagent-transcript?sessionId=s1&subId=1");
    assert.equal(r5.status, 200);
    assert.equal((r5.data as { live?: boolean }).live, true);
    assert.equal((r5.data as { contextPct?: number }).contextPct, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 会话拖动排序：孤儿组（工作区已不在 workspaces.json 但会话仍在） ----------

test("/api/sessions/reorder：孤儿组可排序（有会话即合法）；完全未知的工作区仍 400", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-reord-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const store = new SessionStore(dir);
    const orphanId = "11111111-2222-3333-4444-5555555555a1";
    store.save({
      id: orphanId,
      title: "孤儿组会话",
      updatedAt: new Date().toISOString(),
      workspace: "F:\\orphan",
      messageCount: 1,
      messages: [{ role: "user", content: "hi" }],
      totals: { prompt: 0, completion: 0 },
    });
    const host = {
      recentWorkspaces: () => ["F:\\listed"], // 列表里没有 F:\orphan
      sessions: () => store,
      broadcast: () => {},
      sessionsPayload: () => ({ current: "", viewSeq: 0, running: [], groups: [], recycled: [] }),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/sessions/reorder");
    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/sessions/reorder"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    // 孤儿组：不在 recentWorkspaces 但有会话 → 200（此前 400「工作区不在列表中」= 拖不动的根因）
    const ok = await call({ workspace: "F:\\orphan", ids: [orphanId] });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      (JSON.parse(readFileSync(join(dir, "sessions", "order.json"), "utf8")) as Record<string, string[]>)["F:\\orphan"],
      [orphanId],
      "排序落盘",
    );
    // 列表内工作区照常 200；完全未知（既不在列表也无会话）仍 400
    assert.equal((await call({ workspace: "F:\\listed", ids: [] })).status, 200);
    assert.equal((await call({ workspace: "F:\\nowhere", ids: [] })).status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/30：/api/settings 权限三键运行中放行（busy bypass），effort 维持 409 ----------

test("/api/settings：busy 放行权限三键（live 应用+广播+不落盘）；busy effort 仍 409；空闲立即落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websettings-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    const settings = { alwaysConfirm: false, effort: "high", askMode: "ask", sandboxMode: "workspace-write" };
    const rt = {
      id: "rt-stub",
      busy: true,
      workspace: { root: join(dir, "ws") },
      settings,
      agent: { setSandboxMode: (m: string) => (settings.sandboxMode = m) },
    };
    const persisted: number[] = [];
    const broadcasts: string[] = [];
    const host = {
      viewRt: () => rt,
      persistSession: () => persisted.push(1),
      broadcast: (ev: string) => broadcasts.push(ev),
      currentState: () => ({ ...settings, busy: rt.busy }),
    } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/settings");
    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/settings"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    // busy + 权限三键：放行、live 应用、广播 state、不落盘（轮末自动存档兜底）
    const r1 = await call({ askMode: "auto" });
    assert.equal(r1.status, 200);
    assert.equal(settings.askMode, "auto");
    assert.ok(broadcasts.includes("state"));
    assert.equal(persisted.length, 0, "busy 补丁不落盘");
    const r2 = await call({ sandboxMode: "danger-full-access" });
    assert.equal(r2.status, 200);
    assert.equal(settings.sandboxMode, "danger-full-access");

    // busy + effort：仍 409；busy 下权限键混 effort：整体拒绝
    assert.equal((await call({ effort: "low" })).status, 409);
    assert.equal(settings.effort, "high", "档位未被改动");
    assert.equal((await call({ askMode: "never", effort: "low" })).status, 409);
    assert.equal(settings.askMode, "auto", "混发整体拒绝，权限键也不应用");

    // 空闲：权限键立即落盘；effort 照旧落盘
    rt.busy = false;
    const r3 = await call({ alwaysConfirm: true });
    assert.equal(r3.status, 200);
    assert.equal(settings.alwaysConfirm, true);
    assert.equal(persisted.length, 1, "空闲补丁立即落盘");
    assert.equal((await call({ effort: "low" })).status, 200);
    assert.equal(settings.effort, "low");
    assert.equal(persisted.length, 2, "effort 空闲照旧落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/32 真机回归：/api/ask-user 决议（预删除会让 settle 幂等守卫误判 → promise 永挂） ----------

test("/api/ask-user：按 id 决议 resolve 提问 promise（choice/text 两态）；野值 400 留槽可重试；未知 id 409", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-websessions-ask-"));
  try {
    const ctx = buildContext(
      {
        userDir: dir,
        globalSkillsDir: join(dir, "skills"),
        globalMcpFile: join(dir, "mcp.json"),
        workspacesFile: join(dir, "workspaces.json"),
        sessionsDir: join(dir, "sessions"),
      },
      loadConfig(),
    );
    // 桩 rt：pendingAskUsers 槽的 resolver 与 web/session-runtime.ts askUserFor 的 settle 同构（自删 + resolve）
    const rt = { pendingAskUsers: new Map<string, (a: unknown) => void>() };
    const host = { runtimes: () => new Map([["s1", rt]]) } as unknown as SessionHost;
    ctx.sessionHost = host;
    webSessions.setup(ctx);
    const route = ctx.routes.get("/api/ask-user");
    const call = async (body: Record<string, unknown>) => {
      const responses: Array<{ status: number; data: unknown }> = [];
      const r: ServerRequest = {
        req: {} as never,
        res: {} as never,
        url: new URL("http://localhost/api/ask-user"),
        body: async () => body,
        json: (status, data) => responses.push({ status, data }),
      };
      await route!.handler(r);
      return responses[0]!;
    };

    // 挂两个提问（模拟同轮并行多问——Map 槽互不覆盖）
    const waiter = (id: string) =>
      new Promise<unknown>((res) => {
        rt.pendingAskUsers.set(id, (a) => {
          rt.pendingAskUsers.delete(id);
          res(a);
        });
      });
    const p1 = waiter("k1");
    const p2 = waiter("k2");

    assert.equal((await call({ sessionId: "s1", id: "ghost", choice: 0 })).status, 409, "未知 id 409");
    assert.equal((await call({ sessionId: "s1", id: "k1" })).status, 400, "缺 choice/text 400");
    assert.equal((await call({ sessionId: "s1", id: "k1", choice: "x" })).status, 400, "野值 choice 400");
    assert.equal(rt.pendingAskUsers.has("k1"), true, "400 后槽仍在（卡片留在屏上可重试）");

    // 回归主断言：决议必须 resolve 提问 promise——双删 bug 在此超时（真机表现为选完选项轮次卡死）
    const race = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("决议未 resolve（预删除使 settle 守卫误判）")), 1_000))]);
    const ok1 = await call({ sessionId: "s1", id: "k1", choice: 1 });
    assert.equal(ok1.status, 202);
    assert.deepEqual(await race(p1), { choice: 1 }, "choice 决议到达 resolver");
    assert.equal(rt.pendingAskUsers.has("k1"), false, "决议后槽清空");
    const ok2 = await call({ sessionId: "s1", id: "k2", text: " 都不要，自定义 " });
    assert.equal(ok2.status, 202);
    assert.deepEqual(await race(p2), { text: "都不要，自定义" }, "text（其它）决议到达 resolver 且已 trim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
