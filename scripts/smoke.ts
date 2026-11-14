/**
 * 真实 API 冒烟测试（会消耗少量 token）：
 *  1. 当前提供方连通性与模型可用性（验证 base_url / key / 模型名）
 *  2. 工具调用闭环（模型 → run_pwsh → 结果回传 → 最终回答）
 *  3. 工作区守卫：工作区外命令触发人工批准，拒绝后模型收到拒绝原因
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
import type { ApprovalRequest } from "../src/approval/types.ts";

const results: { name: string; ok: boolean; note: string }[] = [];
function record(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? " — " + note : ""}`);
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const cwd = process.cwd();
const registeredFormats: FormatLookup = { get: (f) => openaiFormatDef.format === f ? openaiFormatDef : anthropicFormatDef.format === f ? anthropicFormatDef : undefined };
const providerFile = ensureProvidersFile(join(homedir(), ".ZQQ-harness"), cwd, registeredFormats);
const cfg =
  providerFile.data.providers.find((p) => p.id === providerFile.data.active) ?? providerFile.data.providers[0];
console.log(`提供方：${cfg.name}  模型：${cfg.model}  工作区：${cwd}\n`);
const provider = createProvider(cfg, registeredFormats);

// 场景 1：连通性 + 模型名有效性
try {
  const r = await provider.chat({ messages: [{ role: "user", content: "请只回复两个字：收到" }] });
  record("DeepSeek 连通性与模型可用", r.content.trim().length > 0, `模型返回：${r.content.trim().slice(0, 40)}`);
} catch (e) {
  record("DeepSeek 连通性与模型可用", false, errMsg(e));
}

// 场景 2：工具调用闭环
function makeAgent(approver: (req: ApprovalRequest) => Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">, alwaysConfirm = false) {
  let finalText = "";
  const ui: AgentUi = {
    printReasoningDelta: () => {},
    printTextDelta: (t) => {
      finalText += t;
    },
    printToolCall: (n, p) => console.log(`  ⚙ ${n} ${p.slice(0, 80)}`),
    printToolResult: (s) => console.log(`  ↳ ${s.slice(0, 80)}`),
    printInfo: (m) => console.log(`  · ${m}`),
    printUsage: () => {},
  };
  const registry = new ToolRegistry();
  registry.register(createPwshTool());
  const agent = new Agent({
    provider,
    registry,
    workspace: createWorkspace(cwd),
    ui,
    requestApproval: approver,
    settings: { alwaysConfirm, effort: "high" },
    maxToolRounds: 5,
    sandboxMode: "danger-full-access", // 冒烟环境无沙箱后端：全开放模式（守卫+审批照常）
  });
  return { agent, getFinal: () => finalText };
}

try {
  const { agent, getFinal } = makeAgent(async () => "rejected");
  await agent.run("请调用工具执行 Get-Location，然后用一句话告诉我当前目录的绝对路径。不要执行其他命令。");
  const text = getFinal();
  const ok = text.toLowerCase().includes("zqq-harness") || /[a-z]:\\/i.test(text);
  record("工具调用闭环（run_pwsh）", ok, `最终回答：${text.slice(0, 60)}`);
} catch (e) {
  record("工具调用闭环（run_pwsh）", false, errMsg(e));
}

// 场景 3：审批流程（逐条确认模式下批准被拒，模型知情）
try {
  let asked = false;
  const askedReasons: string[][] = [];
  const { agent, getFinal } = makeAgent(async (req) => {
    asked = true;
    askedReasons.push(req.reasons);
    return "rejected";
  }, true);
  await agent.run(
    "请执行命令：Set-Content -Path C:\\Windows\\zqq_smoke_test.txt -Value test。如果被拒绝，直接告诉我被拒绝即可，不要尝试其他路径。",
  );
  record(
    "命令触发人工批准（拒绝后模型知情）",
    asked,
    asked ? `拦截原因：${askedReasons[0]?.[0] ?? ""}｜模型回应：${getFinal().slice(0, 60)}` : "未触发批准询问",
  );
} catch (e) {
  record("命令触发人工批准（拒绝后模型知情）", false, errMsg(e));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length > 0 ? `\n冒烟结果：${failed.length} 项失败` : "\n冒烟结果：全部通过");
process.exit(failed.length > 0 ? 1 : 0);
