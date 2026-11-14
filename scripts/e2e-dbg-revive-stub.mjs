/**
 * docs/17 真机端到端验证（零 token，HTTP 级驱动，无浏览器）：存档注入 + 重启唤醒——
 *   1. 本脚本内起 stub LLM（OpenAI 兼容 SSE）+ 真 harness 服务（隔离 USERPROFILE 临时目录）；
 *   2. 「派可复用」→ agent_task(reusable, spec) → worker 写 spec-r1.md → idle；
 *      断言 transcript.json 已是主对话 SessionData 同构格式（kind=subagent + subagent meta）；
 *   3. 「追加」→ agent_followup → 历史延续写 spec-r2.md（在线复用基线）；
 *   4. 杀服务进程 → 同一 USERPROFILE 重启 → /api/sessions/load 从盘恢复 →
 *      /api/subagent/context 对 spec#1 返回 archived（待命记录快照=实例不在线，休眠）；
 *   5. 「追加唤醒」→ agent_followup spec → 服务端自动唤醒（同 subId）→ worker 写
 *      spec-r2b.md → /api/subagent/context 回 idle（句柄复活，历史延续实证）；
 *   6. 「归档」→ archive_subagent → archived；「再派」→ agent_followup 被拒（已归档）；
 *   7. 「重派接续」→ agent_task(spec2, 任务书指令先 read_archive subId=1) → 新 worker 真调
 *      read_archive → 工具结果含「存档注入」→ 写 spec-r3.md；断言 spec-r3.md 存在且
 *      spec-r3-missing.md 不存在（存档真的被转成可读文本注入了 worker 上下文）。
 * 用法：node scripts/e2e-dbg-revive-stub.mjs [llmPort=18913] [webPort=18914]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LLM_PORT = Number(process.argv[2] ?? 18913);
const WEB_PORT = Number(process.argv[3] ?? 18914);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const enc = new TextEncoder();

// ---------- 断言与轮询 ----------

const failures = [];
const ok = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(label, fn, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* 服务未就绪/任务未结束，继续等 */
    }
    await sleep(150);
  }
  ok(false, `${label}（30s 超时，最后值：${JSON.stringify(last)?.slice(0, 200)}）`);
  return null;
}
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${WEB_PORT}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: text };
  }
};

// ---------- stub LLM（脚本化协调者与 worker） ----------

const chunk = (delta, finish = null) =>
  JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
function sseBody(kind, payload, toolName) {
  const events = [chunk({ role: "assistant" })];
  if (kind === "text") {
    events.push(chunk({ content: payload.slice(0, Math.floor(payload.length / 2)) }));
    events.push(chunk({ content: payload.slice(Math.floor(payload.length / 2)) }));
  } else {
    events.push(chunk({ tool_calls: [{ index: 0, id: "call-" + Math.random().toString(36).slice(2, 8), type: "function", function: { name: toolName, arguments: "" } }] }));
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: payload } }] }));
  }
  events.push(chunk({}, "stop"));
  events.push(JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 321, completion_tokens: 45 } }));
  return events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
}
const wf = (path, content) => JSON.stringify({ path, content });
const rounds = new Map(); // worker 会话键（任务书前缀）→ 已处理的工具轮数

const llm = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("data", () => {});
  req.on("end", () => {
    let msgs = [];
    try {
      msgs = JSON.parse(body).messages ?? [];
    } catch {
      /* fallback */
    }
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const userText = String(lastUser?.content ?? "");
    const lastUserIdx = msgs.lastIndexOf(lastUser);
    const hasTool = msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
    const send = (kind, payload, toolName) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end(enc.encode(sseBody(kind, payload, toolName)));
    };
    const reply = (kind, payload, toolName) => {
      console.log(`[stub] user="${userText.slice(0, 28)}" hasTool=${hasTool} → ${kind}${toolName ? ":" + toolName : ""}`);
      send(kind, payload, toolName);
    };

    // 协调者轮（脚本：派发/追加/唤醒/归档/再派/重派接续；hasTool 区分派发轮与总结轮）
    for (const [prefix, dispatch, ack] of [
      ["派可复用", ["tool", JSON.stringify({ name: "spec", description: "可复用专家：首任务", reusable: true, task: "做首任务：创建 spec-r1.md，然后交报告。" }), "agent_task"], "（总结）spec 已派出并待命。"],
      ["追加：", ["tool", JSON.stringify({ name: "spec", description: "追加：第二任务", task: "做追加任务：创建 spec-r2.md（记得首任务的产出），然后交报告。" }), "agent_followup"], "（总结）spec 追加任务已派出。"],
      ["追加唤醒", ["tool", JSON.stringify({ name: "spec", description: "唤醒后追加", task: "做唤醒任务：创建 spec-r2b.md（基于你已有的上下文），然后交报告。" }), "agent_followup"], "（总结）唤醒追加已受理。"],
      ["归档：", ["tool", JSON.stringify({ name: "spec" }), "archive_subagent"], "（总结）spec 已归档。"],
      ["再派：", ["tool", JSON.stringify({ name: "spec", description: "再派（预期被拒）", task: "做被拒任务" }), "agent_followup"], "（总结）再派被拒，已如实转述。"],
      ["重派接续", ["tool", JSON.stringify({ name: "spec2", description: "接续已归档 spec 的工作", task: "接续任务：先调用 read_archive 工具（参数 subId=1）读取过程存档，然后基于存档内容创建 spec-r3.md，交报告。" }), "agent_task"], "（总结）spec2 已派出接续。"],
    ]) {
      if (userText.startsWith(prefix)) {
        reply(...(hasTool ? ["text", ack] : dispatch));
        return;
      }
    }
    // 自动送达报告轮（协调者收到「[子代理任务报告 · 自动送达]」开头的用户消息）
    if (userText.startsWith("[子代理任务报告") || userText.startsWith("[子代理状态")) {
      reply("text", "（总结）已收到报告并向用户汇总。");
      return;
    }

    // worker 轮（按任务书前缀路由；rounds 计数区分工具轮与收尾轮）
    const workerPlan = [
      {
        prefix: "做首任务",
        steps: [["tool", wf("spec-r1.md", "r1 内容"), "write_file"], ["text", "报告：spec-r1.md 完成"]],
      },
      {
        prefix: "做追加任务",
        steps: [["tool", wf("spec-r2.md", "r2 内容"), "write_file"], ["text", "报告：spec-r2.md 完成（记得 r1）"]],
      },
      {
        prefix: "做唤醒任务",
        steps: [["tool", wf("spec-r2b.md", "r2b 内容"), "write_file"], ["text", "报告：spec-r2b.md 完成（唤醒后继续）"]],
      },
      {
        prefix: "接续任务",
        steps: [
          ["tool", JSON.stringify({ subId: 1 }), "read_archive"],
          ["text", "报告：接续完成"], // 占位：第 2 轮按工具结果动态分支（见下）
        ],
      },
    ];
    for (const plan of workerPlan) {
      if (!userText.startsWith(plan.prefix)) continue;
      const n = (rounds.get(userText) ?? 0) + 1;
      rounds.set(userText, n);
      const step = plan.steps[n - 1];
      if (!step) {
        reply("text", "报告：已全部完成");
        return;
      }
      // 接续任务第 2 轮：read_archive 结果含「存档注入」→ 写 spec-r3.md，否则写 -missing（供断言甄别）
      if (plan.prefix === "接续任务" && n === 2) {
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        const got = toolMsgs.length > 0 && String(toolMsgs.at(-1)?.content ?? "").includes("存档注入");
        reply("tool", wf(got ? "spec-r3.md" : "spec-r3-missing.md", got ? "r3 来自存档" : "read_archive 失败"), "write_file");
        return;
      }
      reply(...step);
      return;
    }
    reply("text", "（stub 兜底）收到。");
  });
});

// ---------- 驱动 ----------

const tmp = mkdtempSync(join(tmpdir(), "zqq-e2e-revive-"));
const fakeHome = join(tmp, "home");
const dataDir = join(fakeHome, ".ZQQ-harness");
const wsDir = join(tmp, "ws");
mkdirSync(dataDir, { recursive: true });
mkdirSync(wsDir, { recursive: true });
writeFileSync(
  join(dataDir, "providers.json"),
  JSON.stringify({
    active: "stub",
    providers: [{ id: "stub", name: "Stub", format: "openai", baseUrl: `http://127.0.0.1:${LLM_PORT}`, apiKey: "sk-stub", model: "stub-model", effort: "high", contextLength: 128000, maxTokens: null }],
  }),
  "utf8",
);

const serverEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, PORT: String(WEB_PORT), ZQQ_NO_BROWSER: "1" };
let web = null;
const startWeb = async () => {
  web = spawn(process.execPath, [join(ROOT, "src", "web", "server.ts")], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  web.stdout.on("data", () => {});
  web.stderr.on("data", (d) => process.stderr.write(`[web] ${d}`));
  await poll("服务启动", async () => {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/meta`);
    return r.status === 200;
  }, 30_000);
};

const chat = async (text) => {
  const r = await api("POST", "/api/chat", { text });
  if (r.status !== 202) throw new Error(`chat ${r.status}: ${JSON.stringify(r.data)}`);
};
const subStatus = async (coordId, subId) => {
  const r = await api("GET", `/api/subagent/context?sessionId=${coordId}&subId=${subId}`);
  return r.status === 200 ? r.data.status : `http${r.status}`;
};

try {
  await new Promise((res) => llm.listen(LLM_PORT, res));
  await startWeb();

  // 绑定工作区（引导会话就地绑定）→ 开协调者会话 → 切为视图
  let r = await api("POST", "/api/workspace", { path: wsDir });
  ok(r.status === 200, "绑定工作区");
  r = await api("POST", "/api/sessions/new", { kind: "coordinator" });
  ok(r.status === 202, "开协调者会话");
  const sessions = await poll("会话列表出现 coordinator", async () => {
    const p = await api("GET", "/api/sessions");
    const coord = (p.data.groups ?? []).flatMap((g) => g.items).find((s) => s.kind === "coordinator");
    return coord ?? null;
  });
  const coordId = sessions.id;
  await api("POST", "/api/sessions/load", { id: coordId });

  // 2) 派可复用 → spec-r1.md；transcript 为 SessionData 同构格式
  console.log("\n— 阶段 A：派可复用 → idle + 新格式存档");
  await chat("派可复用：做首任务");
  await poll("spec-r1.md 落盘", () => (existsSync(join(wsDir, "spec-r1.md")) ? true : null));
  ok((await subStatus(coordId, 1)) === "idle", "spec#1 任务结束转 idle（句柄驻留）");
  const archivePath = join(dataDir, "spill", coordId, "sub-1-spec", "transcript.json");
  ok(existsSync(archivePath), "transcript.json 落盘于 spill/<sessionId>/sub-1-spec/");
  const archive = JSON.parse(readFileSync(archivePath, "utf8"));
  ok(archive.kind === "subagent", "存档 kind=subagent（主对话 SessionData 同构）");
  ok(archive.subagent?.reusable === true && archive.subagent?.tasks === 1 && archive.subagent?.state === "idle", "存档 subagent meta（reusable/tasks/state）");
  ok(Array.isArray(archive.messages) && archive.messages.some((m) => m.role === "user" && String(m.content).includes("做首任务")), "存档 messages 含任务书");

  // 3) 在线追加（复用基线）
  console.log("\n— 阶段 B：在线 followup → 历史延续");
  await chat("追加：第二任务");
  await poll("spec-r2.md 落盘", () => (existsSync(join(wsDir, "spec-r2.md")) ? true : null));
  ok((await subStatus(coordId, 1)) === "idle", "追加后回到 idle");

  // 4) 重启服务（同一 USERPROFILE）→ 从盘恢复
  console.log("\n— 阶段 C：杀服务 → 重启 → 从盘恢复");
  web.kill();
  await new Promise((res) => web.on("exit", res));
  await startWeb();
  r = await api("POST", "/api/sessions/load", { id: coordId });
  ok(r.status === 200, "从盘恢复协调者会话");
  ok((await subStatus(coordId, 1)) === "archived", "重启后 spec#1 记录快照=archived（实例不在线、休眠待唤醒）");

  // 5) 追加唤醒 → 自动唤醒（同 subId）→ 历史延续
  console.log("\n— 阶段 D：followup 自动唤醒");
  await chat("追加唤醒：继续该方向");
  await poll("spec-r2b.md 落盘（唤醒后的任务真实执行）", () => (existsSync(join(wsDir, "spec-r2b.md")) ? true : null));
  ok((await subStatus(coordId, 1)) === "idle", "唤醒后句柄复活为 idle（同 subId）");

  // 6) 归档 → 再派被拒
  console.log("\n— 阶段 E：归档 → 再派被拒");
  await chat("归档：把 spec 归档");
  await poll("spec#1 归档定格", async () => ((await subStatus(coordId, 1)) === "archived" ? true : null));
  await chat("再派：试试再给 spec 派任务");
  await sleep(1500); // 拒绝回执 + 协调者总结轮
  ok((await subStatus(coordId, 1)) === "archived", "已归档不可再派");

  // 7) 重派接续 → 新 worker 真调 read_archive → spec-r3.md
  console.log("\n— 阶段 F：重派接续（read_archive 注入存档）");
  await chat("重派接续：接续已归档方向");
  await poll("spec-r3.md 落盘", () => (existsSync(join(wsDir, "spec-r3.md")) ? true : null), 45_000);
  ok(!existsSync(join(wsDir, "spec-r3-missing.md")), "read_archive 成功返回存档（未走失败分支）");
  const tr = await api("GET", `/api/subagent-transcript?sessionId=${coordId}&subId=1`);
  ok(tr.status === 200 && Array.isArray(tr.data.messages), "/api/subagent-transcript 兼容新格式存档");
} finally {
  if (web) web.kill();
  llm.close();
  await sleep(300);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放，忽略 */
  }
}

console.log(`\n${failures.length === 0 ? "✅ e2e 全过" : `❌ ${failures.length} 项失败`}`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
