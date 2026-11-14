/**
 * docs/9 真机验证桩 LLM（零 token）：协调者脚本化走「可复用子代理」全生命周期——
 *   用户「派可复用：…」→ agent_task（reusable:true，name=spec）→ worker 首任务
 *     （1 轮 write_file spec-r1.md + 延迟报告）→ 协调者总结（spec 待命）；
 *   用户「追加：…」→ agent_followup（name=spec）→ worker 第二任务（历史延续，写 spec-r2.md）
 *     → 协调者总结；
 *   用户「归档：…」→ archive_subagent（name=spec）→ 协调者确认；
 *   用户「再派：…」→ agent_followup（name=spec）→ 服务端拒绝（已归档）→ 协调者如实转述。
 * worker 任务按「最后一条 user 消息」路由（可复用 worker 的 messages[1] 恒为首任务）。
 * 用法：node scripts/e2e-dbg-reuse-stub.mjs [port=18903]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 18903);
const TOOL_ROUND_DELAY_MS = 3000; // worker 工具轮延迟（实时观察窗口）
const REPORT_DELAY_MS = 6000; // worker 报告延迟（idle 转换观察窗口）

const enc = new TextEncoder();
const chunk = (delta, finish = null) =>
  JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

/** kind: "text" | "tool"；toolName 参数化（协调者=agent_task/agent_followup/archive_subagent；缺省 write_file=worker 工具轮） */
function sseBody(kind, payload, toolName = "write_file") {
  const events = [];
  events.push(chunk({ role: "assistant" }));
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

const SPAWN_ARGS = JSON.stringify({
  name: "spec",
  description: "可复用专家：首任务",
  reusable: true,
  task: "做首任务：创建 spec-r1.md，然后交报告。",
});
const FOLLOWUP_ARGS = JSON.stringify({
  name: "spec",
  description: "追加：第二任务",
  task: "做追加任务：创建 spec-r2.md（记得首任务的产出），然后交报告。",
});
const ARCHIVE_ARGS = JSON.stringify({ name: "spec" });
const REFOLLOW_ARGS = JSON.stringify({ name: "spec", description: "再派（预期被拒）", task: "做被拒任务" });

/** worker 请求序号（per task 前缀）：区分工具轮与收尾轮 */
const roundOf = new Map();
const nextRound = (key) => {
  const n = (roundOf.get(key) ?? 0) + 1;
  roundOf.set(key, n);
  return n;
};

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let msgs = [];
    try {
      msgs = JSON.parse(body).messages ?? [];
    } catch {
      /* 走 fallback */
    }
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const userText = String(lastUser?.content ?? "");
    // 「本轮是否已回填工具结果」只看最后一条 user 之后的消息——多轮历史里旧 tool 消息常驻，
    // 全文 some 会把每一轮首请求都误判成总结轮（场景二曾因此跳过 agent_followup 直接编总结）
    const lastUserIdx = msgs.lastIndexOf(lastUser);
    const hasTool = msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
    console.log(`[stub] user="${userText.slice(0, 24)}" hasTool=${hasTool} n=${msgs.length}`);
    const send = (kind, payload, toolName) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end(enc.encode(sseBody(kind, payload, toolName)));
    };
    // W2-L2 interim（含状态占位）：即时文本回应
    if (msgs.some((m) => m.role === "tool" && String(m.content).startsWith("[子代理任务仍在执行中"))) {
      send("text", "（即时回应）spec 仍在执行任务，请稍候。");
      return;
    }
    // ---- 协调者轮（按 goal 标记路由；hasTool 区分派发轮与总结轮）----
    if (userText.startsWith("派可复用") && !hasTool) {
      send("tool", SPAWN_ARGS, "agent_task");
      return;
    }
    if (userText.startsWith("派可复用") && hasTool) {
      send("text", "spec 已完成首任务（写 spec-r1.md），现保留待命（空闲）。可用 agent_followup 追加任务。");
      return;
    }
    if (userText.startsWith("追加") && !hasTool) {
      send("tool", FOLLOWUP_ARGS, "agent_followup");
      return;
    }
    if (userText.startsWith("追加") && hasTool) {
      send("text", "spec 完成了第二个任务（写 spec-r2.md，记得首任务上下文），仍保留待命。");
      return;
    }
    if (userText.startsWith("归档") && !hasTool) {
      send("tool", ARCHIVE_ARGS, "archive_subagent");
      return;
    }
    if (userText.startsWith("归档") && hasTool) {
      send("text", "spec 已归档（共完成 2 次任务）：现在仅可查看过程存档，不可再派任务。");
      return;
    }
    if (userText.startsWith("再派") && !hasTool) {
      send("tool", REFOLLOW_ARGS, "agent_followup");
      return;
    }
    if (userText.startsWith("再派") && hasTool) {
      send("text", "如预期被拒：spec 已归档不可再派任务（followup 返回已归档文案）。需要时重新 agent_task 派发。");
      return;
    }
    // ---- worker 任务（按最后一条 user 消息路由：可复用 worker 的 messages[1] 恒为首任务）----
    if (userText.startsWith("做首任务")) {
      const n = nextRound("t1");
      if (n === 1) {
        setTimeout(() => send("tool", JSON.stringify({ path: "spec-r1.md", content: "spec 首任务产出。" })), TOOL_ROUND_DELAY_MS);
      } else {
        setTimeout(() => send("text", "结论：完成。产出物：spec-r1.md。关键决定：单轮写入。未决问题：无。"), REPORT_DELAY_MS);
      }
      return;
    }
    if (userText.startsWith("做追加任务")) {
      const n = nextRound("t2");
      if (n === 1) {
        setTimeout(() => send("tool", JSON.stringify({ path: "spec-r2.md", content: "spec 第二任务产出（延续首任务上下文）。" })), TOOL_ROUND_DELAY_MS);
      } else {
        setTimeout(() => send("text", "结论：完成。产出物：spec-r2.md（在首任务 spec-r1.md 基础上继续）。未决问题：无。"), REPORT_DELAY_MS);
      }
      return;
    }
    send("text", "（桩）请依次说：「派可复用：做首任务」「追加：第二个任务」「归档：把 spec 归档」「再派：试试再给 spec 派任务」。");
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[e2e-dbg-reuse-stub] listening on http://127.0.0.1:${PORT}/v1`));
