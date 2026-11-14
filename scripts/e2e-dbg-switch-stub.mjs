/**
 * docs/8 需求二排查 + 需求一（W2-L2）真机验证用桩 LLM（零 token）：在 e2e-sa4-stub-llm.mjs
 * 基础上给 worker 应答加可调延迟（默认 25s），为「worker 运行中切走会话再切回」与
 * 「运行中发消息即时应答」的浏览器复现留出窗口。
 *   协调者首轮（用户说「派两个子代理」）→ tool_calls: agent_tasks（alpha/beta）；
 *   worker（task 以「写 alpha」/「写 beta」开头）→ 延迟 WORKER_DELAY_MS 后交报告；
 *   W2-L2 interim 旁路（含「[子代理任务仍在执行中」合成状态占位）→ 即时文本回应；
 *   协调者末轮（含 tool 消息、无状态占位）→ 最终答复。
 * 用法：node scripts/e2e-dbg-switch-stub.mjs [port=18902] [WORKER_DELAY_MS=25000]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 18902);
const WORKER_DELAY_MS = Number(process.argv[3] ?? 25000);

const enc = new TextEncoder();
const chunk = (delta, finish = null) =>
  JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

function sseBody(kind, payload) {
  const events = [];
  events.push(chunk({ role: "assistant" }));
  if (kind === "text") {
    events.push(chunk({ content: payload.slice(0, Math.floor(payload.length / 2)) }));
    events.push(chunk({ content: payload.slice(Math.floor(payload.length / 2)) }));
  } else {
    events.push(chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "agent_tasks", arguments: "" } }] }));
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: payload } }] }));
  }
  events.push(chunk({}, "stop"));
  events.push(JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 321, completion_tokens: 45 } }));
  return events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
}

const TASKS_ARGS = JSON.stringify({
  tasks: [
    { name: "alpha", description: "写 alpha 模块报告", task: "写 alpha 模块：在工作区根创建 alpha.md，内容为一行完成说明，然后交报告。" },
    { name: "beta", description: "写 beta 模块报告", task: "写 beta 模块：在工作区根创建 beta.md，内容为一行完成说明，然后交报告。" },
  ],
});

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
    const hasTool = msgs.some((m) => m.role === "tool");
    const send = (kind, payload) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end(enc.encode(sseBody(kind, payload)));
    };
    // W2-L2 interim 旁路请求：含合成状态占位消息（先于 hasTool 判定，否则会误入总结分支）
    if (msgs.some((m) => m.role === "tool" && String(m.content).startsWith("[子代理任务仍在执行中"))) {
      send("text", "（即时回应）两个子代理仍在执行中：alpha 与 beta 都在写各自的模块报告，完成后我会汇总。");
      return;
    }
    if (userText.includes("派两个子代理") && !hasTool) {
      send("tool", TASKS_ARGS);
    } else if (userText.startsWith("写 alpha")) {
      // 延迟应答：复现窗口（切换会话）全在此延迟内
      setTimeout(() => send("text", "结论：完成。产出物：alpha.md（一行说明）。关键决定：无。未决问题：无。"), WORKER_DELAY_MS);
    } else if (userText.startsWith("写 beta")) {
      setTimeout(() => send("text", "结论：完成。产出物：beta.md（一行说明）。关键决定：无。未决问题：无。"), WORKER_DELAY_MS);
    } else if (hasTool) {
      send("text", "两个子代理均已完成：alpha.md 与 beta.md 已就位。");
    } else {
      send("text", "（桩）请说「请派两个子代理分别写 alpha 和 beta 模块」。");
    }
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[e2e-dbg-switch-stub] listening on http://127.0.0.1:${PORT} (worker delay ${WORKER_DELAY_MS}ms)`));
