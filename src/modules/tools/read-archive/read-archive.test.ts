/**
 * tools.read-archive 模块测试（docs/17 存档注入）：JSON→可读文本渲染（角色行/工具调用行/
 * 思考块跳过/图片标注/无 JSON 结构噪音）、参数校验（二选一/正整数/清单自纠错——校验裁定
 * 在 archiveSource 接缝，工具透传）、超 archiveRenderMaxChars 预算头部截断 + 省略标记。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toolReadArchive } from "./index.ts";
import { createReadArchiveTool, renderArchiveMessages } from "./read-archive.ts";
import { buildContext } from "../../../core/context.ts";
import { loadConfig } from "../../../config.ts";
import { createFileLedger } from "../../../core/file-tools.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ChatMessage } from "../../../llm/provider.ts";
import type { ToolContext } from "../../../tools/registry.ts";

const tctx: ToolContext = { workspace: { root: "." }, requestApproval: async () => "allowed-once" };

function depsWith(impl: NonNullable<SystemToolDeps["archiveSource"]>): SystemToolDeps {
  const ctx = buildContext(
    { userDir: ".", globalSkillsDir: ".", globalMcpFile: "m.json", workspacesFile: "w.json", sessionsDir: "s" },
    loadConfig(),
  );
  return {
    ctx,
    workspace: () => ({ root: "." }),
    skills: () => [],
    requestApproval: async () => "allowed-once",
    alwaysConfirm: () => false,
    sandboxMode: () => "workspace-write",
    spillDir: () => undefined,
    privateTempDir: () => undefined,
    mcpStatus: () => [],
    reloadMcp: async () => [],
    ledger: createFileLedger(),
    archiveSource: impl,
  };
}

test("renderArchiveMessages：角色行/工具调用行/工具结果行；思考块跳过；图片标注；系统消息跳过；无 JSON 结构噪音", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "系统提示不应出现" },
    { role: "user", content: "帮我写个函数", images: [{ mime: "image/png", data: "xxx" }] },
    {
      role: "assistant",
      content: "好的，我先看看",
      thinking: { text: "内部思考不应出现" },
      toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"src/a.ts"}' }],
    },
    { role: "tool", toolCallId: "c1", content: "文件内容……" },
    { role: "assistant", content: null, toolCalls: [] },
    { role: "assistant", content: "完成", toolCalls: [] },
  ];
  const text = renderArchiveMessages(messages);
  assert.ok(!text.includes("系统提示不应出现"), "系统消息跳过");
  assert.ok(!text.includes("内部思考不应出现"), "思考块跳过");
  assert.ok(text.includes("[用户] 帮我写个函数（含图片 ×1）"), "用户行带图片标注");
  assert.ok(text.includes("[助手] 好的，我先看看"), "助手文本行");
  assert.ok(text.includes('[助手 → read_file] {"path":"src/a.ts"}'), "工具调用行（参数原样单行展示）");
  assert.ok(text.includes("[工具] 文件内容……"), "工具结果行");
  assert.ok(text.includes("[助手] （无文本回复）"), "空回复占位");
  assert.ok(text.includes("[助手] 完成"), "最终报告行");
  assert.ok(!text.includes('"role"'), "无 JSON 结构噪音");
});

test("read_archive：参数二选一与校验（接缝裁定、工具透传）；ok 路径头部标签 + 渲染文本；缺参附清单自纠错", async () => {
  const calls: { subId?: number; sessionId?: string }[] = [];
  const deps = depsWith((q) => {
    calls.push({ ...q });
    if (q.subId !== undefined && q.sessionId !== undefined) return { ok: false, error: "subId 与 sessionId 只能二选一：子代理过程存档用 subId，主对话记录用 sessionId。" };
    if (q.subId === undefined && !q.sessionId) return { ok: false, error: "需要 subId（本会话子代理过程存档）或 sessionId（主对话记录）之一。本会话可用的子代理存档：spec#1（2 次任务）。" };
    if (q.subId === 99) return { ok: false, error: "本会话没有子代理 #99 的过程存档。" };
    return {
      ok: true,
      label: "过程存档 · 子代理 spec#1（共 2 次任务）",
      messages: [{ role: "user", content: "任务书" }, { role: "assistant", content: "报告", toolCalls: [] }] as ChatMessage[],
    };
  });
  const tool = createReadArchiveTool(deps);
  assert.equal(tool.name, "read_archive");

  // 二选一由接缝裁定，工具透传
  assert.ok((await tool.execute({ subId: 1, sessionId: "x" }, tctx)).includes("二选一"));
  // 都不给 → 清单自纠错文案透传
  assert.ok((await tool.execute({}, tctx)).includes("spec#1（2 次任务）"));
  // 工具层参数校验：subId 必须正整数；sessionId 非空
  assert.ok((await tool.execute({ subId: 0 }, tctx)).includes("正整数"));
  assert.ok((await tool.execute({ subId: 1.5 }, tctx)).includes("正整数"));
  assert.ok((await tool.execute({ sessionId: "  " }, tctx)).includes("不能为空"));
  // ok 路径：头部标签 + 消息数 + 渲染正文
  const ok = await tool.execute({ subId: 1 }, tctx);
  assert.ok(ok.startsWith("存档注入 · 过程存档 · 子代理 spec#1（共 2 次任务） · 共 2 条消息"), ok.slice(0, 100));
  assert.ok(ok.includes("[用户] 任务书") && ok.includes("[助手] 报告"), "渲染正文在头部说明之后");
  assert.deepEqual(calls.at(-1), { subId: 1 }, "合法参数透传接缝（此前的校验调用不计）");
  // 模块 setup 注册（audience 缺省 worker）
  const ctx = buildContext(
    { userDir: ".", globalSkillsDir: ".", globalMcpFile: "m.json", workspacesFile: "w.json", sessionsDir: "s" },
    loadConfig(),
  );
  toolReadArchive.setup(ctx);
  assert.equal(ctx.tools.all().filter((d) => d.name === "read_archive").length, 1, "模块注册 read_archive");
  assert.equal(ctx.tools.all().find((d) => d.name === "read_archive")?.audience ?? "worker", "worker", "audience=worker（普通会话+子代理可用，协调者不注册）");
});

test("read_archive：超 archiveRenderMaxChars 预算截为头部 + 省略标记（不 spill——存档全文在盘上）", async () => {
  const big = "x".repeat(120_000);
  const deps = depsWith(() => ({ ok: true, label: "过程存档 · 子代理 big#1", messages: [{ role: "user", content: big }] as ChatMessage[] }));
  const tool = createReadArchiveTool(deps);
  const out = await tool.execute({ subId: 1 }, tctx);
  assert.ok(out.length < 120_000, "输出被截断到预算内");
  assert.ok(out.includes("[后文已省略"), "带省略标记");
  assert.ok(out.startsWith("存档注入 · 过程存档 · 子代理 big#1"), "头部标签保留");
  assert.ok((await tool.execute({ subId: 1 }, tctx)).length < 120_000, "重复调用结果稳定（无状态）");
});
