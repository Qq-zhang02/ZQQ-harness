/**
 * Anthropic 路线真机冒烟（会消耗少量 token）：验证思考块的存档与回放闭环。
 *  1. 用 anthropic 格式提供方（默认 deepseek-anthropic，可用 argv[2] 指定其他 id）跑多轮工具循环
 *  2. 检查助手消息存档了 thinking（含签名情况）
 *  3. 按当前模型构造回放请求，统计 thinking 块数量与降级告警
 * 用法：node scripts/smoke-anthropic.ts [providerId]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureProvidersFile, createProvider, type FormatLookup } from "../src/providers/store.ts";
import { anthropicFormatDef } from "../src/modules/providers/anthropic/index.ts";
import { openaiFormatDef } from "../src/modules/providers/openai/index.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createPwshTool } from "../src/modules/tools/pwsh/pwsh.ts";
import { Agent, type AgentUi } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import { toAnthropicMessages } from "../src/modules/providers/anthropic/provider.ts";
import type { ChatMessage } from "../src/llm/provider.ts";

const wantId = process.argv[2] ?? "deepseek-anthropic";
const registeredFormats: FormatLookup = { get: (f) => openaiFormatDef.format === f ? openaiFormatDef : anthropicFormatDef.format === f ? anthropicFormatDef : undefined };
const providerFile = ensureProvidersFile(join(homedir(), ".ZQQ-harness"), process.cwd(), registeredFormats);
const cfg = providerFile.data.providers.find((p) => p.id === wantId);
if (!cfg) {
  console.error(`找不到提供方 ${wantId}（providers.json 现有：${providerFile.data.providers.map((p) => p.id).join(", ")}）`);
  process.exit(1);
}
if (cfg.format !== "anthropic") {
  console.error(`提供方 ${wantId} 不是 anthropic 格式（format=${cfg.format}）`);
  process.exit(1);
}
console.log(`提供方：${cfg.name}（${cfg.baseUrl}）模型：${cfg.model} 工作区：${process.cwd()}\n`);
const provider = createProvider(cfg, registeredFormats);

let thinkChars = 0;
let degradeCount = 0;
let finalText = "";
const ui: AgentUi = {
  printReasoningDelta: (t) => {
    thinkChars += t.length;
  },
  printTextDelta: (t) => {
    finalText += t;
  },
  printToolCall: (n, p) => console.log(`  ⚙ ${n} ${p.slice(0, 80)}`),
  printToolResult: (s) => console.log(`  ↳ ${s.slice(0, 60)}`),
  printInfo: (m) => {
    degradeCount++;
    console.log(`  · ${m}`);
  },
  printUsage: () => {},
};
const registry = new ToolRegistry();
registry.register(createPwshTool());
const agent = new Agent({
  provider,
  registry,
  workspace: createWorkspace(process.cwd()),
  ui,
  requestApproval: async () => "rejected",
  settings: { alwaysConfirm: false, effort: "high" }, // 会话档位优先：强制思考模式（回放门槛=思考开启）
  maxToolRounds: 5,
  sandboxMode: "danger-full-access",
});

try {
  // 任务刻意带一点推理（数值比较），否则自适应思考的模型可能直接跳过思考块
  await agent.run(
    "请先调用工具执行 Get-Location 获取当前目录；然后不借助工具，仔细逐位比较 9.11 和 9.8 哪个更大；最后用一句话同时告诉我目录路径和比较结论。不要执行其他命令。",
  );
} catch (e) {
  console.error("❌ 工具循环失败：", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// 存档检查：助手消息的 thinking 块
let thinkMsgs = 0;
let withSig = 0;
let finalThink = false;
const msgs = agent.messages as (ChatMessage & { thinking?: { text: string; signature?: string } })[];
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i]!;
  if (m.role === "assistant" && m.thinking) {
    thinkMsgs++;
    if (m.thinking.signature !== undefined) withSig++;
    const isFinal = i === msgs.length - 1;
    if (isFinal) finalThink = true;
  }
}

// 回放构造检查：按当前模型重建请求消息，统计 thinking 块
const replayed = toAnthropicMessages([...agent.messages], { model: cfg.model });
let replayBlocks = 0;
for (const r of replayed) {
  if (Array.isArray(r.content)) {
    for (const b of r.content as Array<{ type?: string }>) {
      if (b.type === "thinking") replayBlocks++;
    }
  }
}

console.log(`\n思考流字数：${thinkChars}；存档思考块：${thinkMsgs} 条（含签名 ${withSig} 条；最终轮存档：${finalThink ? "是" : "否"}）`);
console.log(`回放构造（模型 ${cfg.model}）：thinking 块 ${replayBlocks} 个；降级告警：${degradeCount} 次`);
console.log(`最终回答：${finalText.trim().slice(0, 80) || "(空)"}`);

const problems: string[] = [];
if (thinkMsgs === 0) problems.push("未存档任何思考块（思考流或存取断链）");
if (replayBlocks === 0 && withSig > 0 && degradeCount === 0) problems.push("有签名却没回放任何 thinking 块");
if (problems.length > 0) {
  console.error(`\n❌ ${problems.join("；")}`);
  process.exit(1);
}
console.log("\n✅ anthropic 路线真机冒烟通过（工具循环 + 思考存档 + 回放构造）");
