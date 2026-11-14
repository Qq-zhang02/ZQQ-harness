/**
 * SA4 浏览器端到端冒烟的桩 LLM 服务（零 token）：本地 OpenAI 兼容 SSE 端点，
 * 按「最后一条 user 消息 + 是否已含 tool 消息」路由脚本化应答——
 *   协调者首轮（用户目标）→ tool_calls: agent_tasks 派 2 个 worker（alpha/beta）；
 *   worker（task 文本）→ 直接交最终报告（不走工具，验证收尾链路）；
 *   协调者末轮（含 tool 结果）→ 最终答复。
 * 用法：node scripts/e2e-sa4-stub-llm.mjs [port=18901]
 * （配套：USERPROFILE 隔离 + providers.json 的 baseUrl 指向 http://127.0.0.1:<port>/v1）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 18901);

const enc = new TextEncoder();
const chunk = (delta, finish = null, extra = {}) =>
  JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });

/** 一段完整应答 → SSE 响应体（文本按 2~3 段流出，带 usage 与 [DONE]）。 */
function sseBody(kind, payload) {
  const events = [];
  events.push(chunk({ role: "assistant" }));
  if (kind === "text") {
    const t = payload;
    const cuts = [0, Math.floor(t.length / 2), t.length];
    for (let i = 0; i < 2; i++) events.push(chunk({ content: t.slice(cuts[i], cuts[i + 1]) }));
  } else {
    // tool_calls：name + arguments 两个 delta（SDK 按 index 聚合，arguments 可分片）
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
    let bodyOut;
    if (userText.includes("派两个子代理") && !hasTool) {
      bodyOut = sseBody("tool", TASKS_ARGS);
    } else if (userText.startsWith("写 alpha")) {
      bodyOut = sseBody("text", "结论：完成。产出物：alpha.md（一行说明）。关键决定：无。未决问题：无。");
    } else if (userText.startsWith("写 beta")) {
      bodyOut = sseBody("text", "结论：完成。产出物：beta.md（一行说明）。关键决定：无。未决问题：无。");
    } else if (hasTool) {
      bodyOut = sseBody("text", "两个子代理均已完成：alpha.md 与 beta.md 已就位。");
    } else {
      bodyOut = sseBody("text", "（桩）请说「请派两个子代理分别写 alpha 和 beta 模块」。");
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.end(enc.encode(bodyOut));
    console.log(`[stub-llm] ${userText.slice(0, 24).replace(/\n/g, " ")} → ${hasTool ? "final" : userText.includes("派两个") ? "agent_tasks" : "report"}`);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[stub-llm] listening on http://127.0.0.1:${PORT}/v1`));
