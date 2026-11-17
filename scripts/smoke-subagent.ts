/**
 * SA1 隔离冒烟（docs/5 §6 SA1，零 token：桩 LLM 不发网络请求）：
 * 在真实装配路径上验证子代理闭环——
 *   1) 真实模块组合（BUILTIN_MODULES 含 agent-task）+ createRuntime(kind=coordinator)：
 *      协调者 registry 五件（docs/15 起 agent_tasks 退役，仅 agent_task 单发派发）、系统提示不含普通工具；
 *   2) subagentServiceFor → dispatch（docs/16 非阻塞派发，报告经收件箱送达）：worker 用
 *      真实系统工具（write_file→read_file→报告）在真实工作区落盘；
 *   3) alwaysConfirm 逐条确认下审批卡带 [子代理 sub-1] 标注、决议回流；
 *   4) worker 用量一次汇总进父会话 totals。
 * 全程临时目录，不触碰真实 ~/.ZQQ-harness。用法：node scripts/smoke-subagent.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../src/core/context.ts";
import { loadModules } from "../src/core/module.ts";
import { BUILTIN_MODULES } from "../src/modules.ts";
import { loadConfig } from "../src/config.ts";
import { SessionStore } from "../src/web/sessions.ts";
import { AttachmentStore } from "../src/web/attachments.ts";
import { createRuntime, type SessionShell } from "../src/web/session-runtime.ts";
import { subagentServiceFor } from "../src/web/subagents.ts";
import type { ProviderFormatDef } from "../src/core/types.ts";
import type { ChatParams, ChatResult, LLMProvider } from "../src/llm/provider.ts";
import type { SseEventName } from "../src/core/events.ts";

const results: { name: string; ok: boolean; note: string }[] = [];
function record(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? " — " + note : ""}`);
}
const fail = () => results.filter((r) => !r.ok).length;

// 桩 LLM：预设 worker 三轮（write_file → read_file → 最终报告），带用量
const workerScript: ChatResult[] = [
  {
    content: "",
    toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "out/hello.txt", content: "SA1 冒烟内容：由 worker 写入。\n" }) }],
    usage: { promptTokens: 800, completionTokens: 60 },
  },
  {
    content: "",
    toolCalls: [{ id: "w2", name: "read_file", arguments: JSON.stringify({ path: "out/hello.txt" }) }],
    usage: { promptTokens: 900, completionTokens: 40 },
  },
  {
    content: "①结论：完成\n②产出物清单：out/hello.txt（冒烟落盘）\n③关键决定：无\n④未决问题：无",
    toolCalls: [],
    usage: { promptTokens: 1000, completionTokens: 120 },
  },
];
const stubLlm: LLMProvider = {
  name: "smoke-stub",
  model: "stub-model",
  chat: async (p: ChatParams) => {
    const r = workerScript.shift() ?? { content: "(脚本耗尽)", toolCalls: [], usage: null };
    if (r.content && p.onTextDelta) p.onTextDelta(r.content);
    return r;
  },
};
const fakeFormat: ProviderFormatDef = {
  format: "fake",
  label: "冒烟桩",
  create: () => stubLlm,
  defaultEffort: () => "high",
};

const userDir = mkdtempSync(join(tmpdir(), "zqq-smoke-subagent-u-"));
const wsDir = mkdtempSync(join(tmpdir(), "zqq-smoke-subagent-ws-"));
const broadcasts: { event: SseEventName; data: unknown }[] = [];
try {
  // ---- 真实装配：ctx + 全量内置模块 + 壳 ----
  const ctx = buildContext(
    {
      userDir,
      globalSkillsDir: join(userDir, "skills"),
      globalMcpFile: join(userDir, "mcp.json"),
      workspacesFile: join(userDir, "workspaces.json"),
      sessionsDir: join(userDir, "sessions"),
    },
    loadConfig(),
  );
  ctx.providerFormats.register(fakeFormat);
  await loadModules(ctx, BUILTIN_MODULES);
  const sh = {
    ctx,
    sessions: new SessionStore(userDir),
    attachments: new AttachmentStore(userDir), // docs/33
    providerFile: {
      path: join(userDir, "providers.json"),
      data: {
        active: "p1",
        providers: [
          {
            id: "p1",
            name: "冒烟桩",
            format: "fake",
            baseUrl: "http://localhost",
            apiKey: "",
            model: "stub-model",
            effort: "high",
            contextLength: 100_000,
            maxTokens: null,
          },
        ],
      },
    },
    runtimes: new Map(),
    viewId: "",
    viewSeq: 0,
    recentWorkspaces: [],
    workspacesFile: join(userDir, "workspaces.json"),
    userDir,
    globalMcpFile: join(userDir, "mcp.json"),
    sandboxTmpRoot: join(userDir, "tmp"),
    broadcast: (event: SseEventName, data: unknown) => broadcasts.push({ event, data }),
  } as SessionShell;
  ctx.subagent = (rt) => subagentServiceFor(sh, rt);

  // ---- 协调者会话装配 ----
  const rt = await createRuntime(sh, { workspaceRoot: wsDir, kind: "coordinator" });
  const toolNames = rt.registry.list().map((t) => t.name);
  record(
    "协调者 registry 七件（docs/32：四件派发控制+subagent_status、list_files、ask_user）：agent_task + stop_subagent + agent_followup/archive_subagent（docs/18 起 pause/resume 退役）",
    toolNames.join(",") === "agent_followup,agent_task,archive_subagent,ask_user,list_files,stop_subagent,subagent_status",
    toolNames.join("、"),
  );
  const sys = String(rt.agent.messages[0]?.content ?? "");
  // docs/20 起 worker 工具行只在「子代理系统提示词说明」段重放——协调者自身工具行（该段之前）不含它们
  const replayIdx = sys.indexOf("# 子代理（worker）系统提示词说明");
  record(
    "协调者系统提示含 agent_task；run_pwsh/write_file 只出现在 docs/20 子代理说明段内（协调者自身工具行不含）",
    sys.includes("agent_task") &&
      replayIdx >= 0 &&
      !sys.slice(0, replayIdx).includes("run_pwsh") &&
      sys.slice(replayIdx).includes("run_pwsh ——"),
  );
  record("协调者不注册 MCP 工具", rt.registry.list().every((t) => !t.name.startsWith("mcp__")));

  // ---- worker 闭环（逐条确认：写入触发审批卡）。docs/16：dispatch 非阻塞——结算报告经收件箱送达 ----
  rt.settings.alwaysConfirm = true;
  const svc = ctx.subagent!(rt);
  const d = svc.dispatch({ task: "写入 out/hello.txt 并读回确认", description: "冒烟" });
  record("派发同步受理回执", d.ok && d.subId === 1 && d.name === "sub-1", d.ok ? `#${d.subId} ${d.name}` : d.error);
  let approved = 0;
  let prefixOk = false;
  let report = "";
  for (let i = 0; i < 400 && !report; i++) {
    if (rt.pendingApproval) {
      const ev = broadcasts.find((b) => b.event === "approval")!.data as { command: string };
      prefixOk ||= ev.command.startsWith("[子代理 sub-1] ");
      rt.pendingApproval!("allowed-once");
      approved++;
    }
    report = rt.inbox?.[0] ?? "";
    await new Promise((r) => setTimeout(r, 5));
  }
  record("审批卡带 [子代理 sub-1] 标注且决议回流", prefixOk && approved >= 1, `批准 ${approved} 次`);
  record(
    "worker 完成报告自动送达收件箱（docs/16）",
    report.startsWith("[子代理任务报告 · 自动送达]") && report.includes("①结论") && report.includes("out/hello.txt"),
    report.slice(0, 80),
  );
  record("真实落盘", existsSync(join(wsDir, "out", "hello.txt")) && readFileSync(join(wsDir, "out", "hello.txt"), "utf8").includes("SA1 冒烟内容"));
  record("用量汇总进父会话 totals（2700 输入）", rt.totals.prompt === 2700, `${rt.totals.prompt}`);
  record("worker 过程不推 usage（只在结束汇总一次）", broadcasts.filter((b) => b.event === "usage").length === 1);
} catch (e) {
  record("冒烟执行", false, e instanceof Error ? `${e.message}\n${e.stack?.split("\n")[1] ?? ""}` : String(e));
} finally {
  rmSync(userDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
}

console.log(`\n${fail() === 0 ? "全部通过" : `${fail()} 项失败`}`);
process.exit(fail() === 0 ? 0 : 1);
