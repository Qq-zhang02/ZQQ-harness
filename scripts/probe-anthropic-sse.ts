/** 探针：直连 anthropic 端点抓原始 SSE 事件类型（诊断思考流是否返回）。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureProvidersFile } from "../src/providers/store.ts";

const pf = ensureProvidersFile(join(homedir(), ".ZQQ-harness"), process.cwd(), { get: () => undefined });
const cfg = pf.data.providers.find((p) => p.id === (process.argv[2] ?? "deepseek-anthropic"))!;
const budget = process.argv[3] ? Number(process.argv[3]) : 16384;

const body: Record<string, unknown> = {
  model: cfg.model,
  max_tokens: budget + 8192,
  messages: [{ role: "user", content: "9.11 和 9.8 哪个大？请仔细比较后回答。" }],
  thinking: { type: "enabled", budget_tokens: budget },
  stream: true,
  ...(process.env.PROBE_TOOLS
    ? {
        tools: [
          {
            name: "run_pwsh",
            description: "在 PowerShell 中执行命令",
            input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        ],
      }
    : {}),
};
const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});
console.log("HTTP", res.status);
if (!res.ok || !res.body) {
  console.log(await res.text());
  process.exit(1);
}
const decoder = new TextDecoder();
const counts = new Map<string, number>();
const samples = new Map<string, string>();
let buffer = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const ev = JSON.parse(payload) as Record<string, unknown>;
      const type = String(ev.type ?? "?");
      let key = type;
      if (type === "content_block_delta") {
        const d = ev.delta as Record<string, unknown> | undefined;
        key = "delta." + String(d?.type ?? "?");
      }
      if (type === "content_block_start") {
        const cb = ev.content_block as Record<string, unknown> | undefined;
        key = "start." + String(cb?.type ?? "?");
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!samples.has(key)) samples.set(key, payload.slice(0, 200));
    } catch {
      /* ignore */
    }
  }
}
console.log("\n事件统计：");
for (const [k, n] of [...counts.entries()].sort()) console.log(`  ${k}: ${n}`);
console.log("\n各类型首条样例：");
for (const [k, s] of samples) console.log(`  [${k}] ${s}`);
