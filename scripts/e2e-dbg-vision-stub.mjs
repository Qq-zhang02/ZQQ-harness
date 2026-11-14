/**
 * docs/12 R2 真机端到端验证（零 token）：视觉链路——普通会话直发图片，断言到达 LLM 端点的
 * 请求形状（user content = 多模态数组，含 image_url data URI）+ 系统提示含「图片输入」直看
 * 指引行（vision=true 提供方）。自包含：记录桩端点 + 隔离 USERPROFILE 起服务 + API 驱动 + 断言。
 * 背景：docs/12 修复 server.ts 适配器丢参（两参箭头把 images 静默丢弃——模型从未收到图），
 * 本脚本即该断点的回归网（docs/10 只验了 UI 元素与 provider 单测，漏了这一层）。
 * 用法：node scripts/e2e-dbg-vision-stub.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const STUB_PORT = 18912;
const SRV_PORT = 18790;
const HERE = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// 1x1 红色 PNG（最小合法图，base64）
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const enc = new TextEncoder();
const chunk = (delta, finish = null) =>
  JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub-vl", choices: [{ index: 0, delta, finish_reason: finish }] });

// ---- 记录桩：OpenAI 兼容 SSE 端点，收到的每个请求体落盘 req-log.jsonl ----
const logFile = join(tmpdir(), "zqq-vision-e2e-reqs.jsonl");
rmSync(logFile, { force: true });
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.includes("/chat/completions")) {
      appendFileSync(logFile, JSON.stringify({ url: req.url, body }) + "\n");
      const events = [
        chunk({ role: "assistant" }),
        chunk({ content: "看到了：一个 1x1 的红色像素。" }),
        chunk({}, "stop"),
        JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } }),
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(enc.encode(events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n"));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});

// ---- 隔离环境：临时 USERPROFILE（homedir→.ZQQ-harness）+ 临时工作区 ----
const home = mkdtempSync(join(tmpdir(), "zqq-vision-home-"));
const ws = mkdtempSync(join(tmpdir(), "zqq-vision-ws-"));
mkdirSync(join(home, ".ZQQ-harness"), { recursive: true });
writeFileSync(
  join(home, ".ZQQ-harness", "providers.json"),
  JSON.stringify({
    active: "p1",
    providers: [
      { id: "p1", name: "桩视觉模型", format: "openai", baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, apiKey: "sk-stub", model: "stub-vl", effort: "default", contextLength: 32000, maxTokens: null, vision: true },
    ],
  }, null, 2),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (port, path, payload) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const fails = [];
const check = (name, cond, extra = "") => { console.log((cond ? "  ✅ " : "  ❌ ") + name + (cond ? "" : "  " + extra)); if (!cond) fails.push(name); };

// ---- 跑 ----
let server;
try {
  await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));
  server = spawn(process.execPath, ["src/web/server.ts"], {
    cwd: HERE,
    env: { ...process.env, USERPROFILE: home, HOME: home, PORT: String(SRV_PORT) },
    stdio: "ignore",
  });
  // 等服务就绪
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    try { up = (await fetch(`http://127.0.0.1:${SRV_PORT}/api/meta`)).ok; } catch { /* 未起 */ }
  }
  if (!up) throw new Error("服务 60s 未就绪");

  const bind = await post(SRV_PORT, "/api/workspace", { path: ws });
  check("绑定工作区成功", bind.status === 200, JSON.stringify(bind));

  const chat = await post(SRV_PORT, "/api/chat", { text: "这张图里有什么？", images: [{ mime: "image/png", data: TINY_PNG_B64 }] });
  check("/api/chat 带图 202", chat.status === 202, JSON.stringify(chat));

  // 等桩收到请求（chat 是异步开轮）
  let lines = [];
  for (let i = 0; i < 40 && lines.length === 0; i++) { await sleep(500); try { lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean); } catch { /* 还没落盘 */ } }
  if (lines.length === 0) { throw new Error("桩 20s 未收到任何 LLM 请求"); }
  const req0 = JSON.parse(lines[0]).body;
  const body0 = JSON.parse(req0);
  const msgs = body0.messages;

  const sys = msgs.find((m) => m.role === "system");
  check("系统提示含「图片输入」直看指引行（vision=true 注入）", typeof sys?.content === "string" && sys.content.includes("图片输入：消息可能直接携带图片"), sys?.content?.slice(0, 120));
  check("系统提示含「不要声称看不到」", sys?.content?.includes("不要声称看不到"));

  const user = msgs.find((m) => m.role === "user");
  check("带图 user 消息 content 是多模态数组（修复前：images 在 server.ts 适配器被丢，消息退化为纯文本）", Array.isArray(user?.content), JSON.stringify(user?.content)?.slice(0, 120));
  if (Array.isArray(user?.content)) {
    const textPart = user.content.find((p) => p.type === "text");
    const imgPart = user.content.find((p) => p.type === "image_url");
    check("多模态 text 部分 = 用户提问", textPart?.text === "这张图里有什么？", textPart?.text);
    check("多模态 image_url = data URI（png + 原 base64）", typeof imgPart?.image_url?.url === "string" && imgPart.image_url.url === `data:image/png;base64,${TINY_PNG_B64}`, imgPart?.image_url?.url?.slice(0, 60));
  }

  console.log(fails.length === 0 ? "\n视觉链路 e2e：全部通过" : `\n视觉链路 e2e：${fails.length} 项失败——${fails.join("；")}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error("❌ e2e 执行失败：", e);
  process.exitCode = 1;
} finally {
  server?.kill();
  stub.close();
  await sleep(300);
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  rmSync(logFile, { force: true });
}
