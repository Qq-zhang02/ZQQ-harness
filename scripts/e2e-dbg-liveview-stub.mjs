/**
 * docs/8 第三棒真机验证桩 LLM（零 token）：在 e2e-dbg-switch-stub 基础上让 worker 走
 * 「思考 + 多轮 write_file 工具调用 + 延迟报告」——抽屉详情页实时轮询（思考/正文/工具
 * 全量）、刷新不丢、长记录滚动三条验收的数据源。
 *   协调者首轮（「派两个子代理」）→ tool_calls: agent_tasks（alpha/beta）；
 *   worker alpha（task 以「写 alpha」开头）→ 每轮延迟 3s 回 tool_calls: write_file
 *     （alpha-r1..r6.md，首轮带 reasoning_content 思考），第 7 轮延迟 25s 后交报告；
 *   worker beta（「写 beta」）→ 1 轮工具后立即交报告；
 *   W2-L2 interim（含「[子代理任务仍在执行中」状态占位）→ 即时文本回应；
 *   协调者末轮（含 tool 消息、无状态占位）→ 最终答复。
 * 用法：node scripts/e2e-dbg-liveview-stub.mjs [port=18902]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 18902);
const ROUND_DELAY_MS = 3000; // 每个工具轮前的延迟（实时观察窗口）
const FINAL_DELAY_MS = 25000; // alpha 最终报告延迟（刷新/切走切回窗口）

const enc = new TextEncoder();
const chunk = (delta, finish = null) =>
  JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

/** kind: "text" | "tool" | "thinkTool"（先思考再工具调用）；toolName 参数化（协调者=agent_tasks，worker=write_file） */
function sseBody(kind, payload, toolName = "write_file") {
  const events = [];
  events.push(chunk({ role: "assistant" }));
  if (kind === "text") {
    events.push(chunk({ content: payload.slice(0, Math.floor(payload.length / 2)) }));
    events.push(chunk({ content: payload.slice(Math.floor(payload.length / 2)) }));
  } else {
    if (kind === "thinkTool") events.push(chunk({ reasoning_content: "思考：先创建文件，再逐轮补齐内容。这一段是 worker 的思考过程。" }));
    events.push(chunk({ tool_calls: [{ index: 0, id: "call-" + Math.random().toString(36).slice(2, 8), type: "function", function: { name: toolName, arguments: "" } }] }));
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: payload } }] }));
  }
  events.push(chunk({}, "stop"));
  events.push(JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 321, completion_tokens: 45 } }));
  return events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
}

const TASKS_ARGS = JSON.stringify({
  tasks: [
    { name: "alpha", description: "写 alpha 多轮文件", task: "写 alpha 模块：逐轮创建 alpha-r1 到 alpha-r6 文件，然后交报告。" },
    { name: "beta", description: "写 beta 文件", task: "写 beta 模块：创建 beta.md，然后交报告。" },
  ],
});

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
    const hasTool = msgs.some((m) => m.role === "tool");
    const send = (kind, payload, toolName) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end(enc.encode(sseBody(kind, payload, toolName)));
    };
    if (msgs.some((m) => m.role === "tool" && String(m.content).startsWith("[子代理任务仍在执行中"))) {
      send("text", "（即时回应）两个子代理仍在执行中：alpha 在逐轮写文件，beta 已接近完成。");
      return;
    }
    if (userText.includes("派两个子代理") && !hasTool) {
      send("tool", TASKS_ARGS, "agent_tasks");
      return;
    }
    if (userText.startsWith("写 alpha")) {
      const n = nextRound("alpha");
      if (n <= 6) {
        setTimeout(
          () => send(n === 1 ? "thinkTool" : "tool", JSON.stringify({ path: `alpha-r${n}.md`, content: `alpha 第 ${n} 轮产出。\n第二行内容。` })),
          ROUND_DELAY_MS,
        );
      } else {
        setTimeout(() => send("text", "结论：完成。产出物：alpha-r1..r6.md（六轮文件）。关键决定：逐轮写入。未决问题：无。"), FINAL_DELAY_MS);
      }
      return;
    }
    if (userText.startsWith("写 beta")) {
      const n = nextRound("beta");
      if (n === 1) {
        setTimeout(() => send("thinkTool", JSON.stringify({ path: "beta.md", content: "beta 完成说明。" })), 500);
      } else {
        setTimeout(() => send("text", "结论：完成。产出物：beta.md（一行说明）。关键决定：无。未决问题：无。"), 500);
      }
      return;
    }
    if (hasTool) {
      send("text", "两个子代理均已完成：alpha 六轮文件与 beta.md 已就位。");
      return;
    }
    send("text", "（桩）请说「请派两个子代理分别写 alpha 和 beta 模块」。");
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[e2e-dbg-liveview-stub] listening on http://127.0.0.1:${PORT}/v1`));
