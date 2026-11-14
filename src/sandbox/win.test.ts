/**
 * Phase B 真实执行测试（跑真进程，对齐 pwsh.test.ts 风格）：
 * 受限进程写工作区内成功 / 写 %TEMP% 下失败 / 读工作区外成功 / 超时杀树无孙进程残留。
 * 仅在 Windows + pwsh 可用时运行（koffi 是唯一计划内原生依赖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { WindowsAclRunner } from "../modules/sandbox/windows-acl/windows-acl.ts";
import { setSandboxRunner, noBackend } from "./runner.ts";
import type { SandboxPolicy } from "./types.ts";
import { createPwshTool } from "../modules/tools/pwsh/pwsh.ts";
import type { ToolContext } from "../tools/registry.ts";
import type { ApprovalRequest } from "../approval/types.ts";

const RUNNER = new WindowsAclRunner();
const ENABLED = RUNNER.available();

function policy(mode: "read-only" | "workspace-write", workspaceRoot: string, privateTempDir: string): SandboxPolicy {
  return { mode, workspaceRoot, privateTempDir };
}

test("前置检查：沙箱后端可用性", () => {
  assert.equal(ENABLED, process.platform === "win32" && RUNNER.available());
  if (!ENABLED) console.log("[跳过] Phase B 真实执行测试需要 Windows + pwsh");
});
test("workspace-write：工作区内写成功", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-ws-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-tmp-"));
  try {
    const r = await RUNNER.run(
      "Set-Content -Path .\\sbx-ok.txt -Value inside; Get-Content .\\sbx-ok.txt",
      policy("workspace-write", ws, tmp),
      { timeoutMs: 120_000 },
    );
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.includes("inside"));
    assert.ok(existsSync(join(ws, "sbx-ok.txt")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("workspace-write：工作区外写被拒（Access is denied）", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-ws-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-tmp-"));
  const outside = mkdtempSync(join(tmpdir(), "zqq-sbx-out-"));
  try {
    const r = await RUNNER.run(
      `Set-Content -Path "${join(outside, "hack.txt")}" -Value x`,
      policy("workspace-write", ws, tmp),
      { timeoutMs: 120_000 },
    );
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /is denied|拒绝访问|访问被拒/i); // CLIXML 编码的 "Access to the path ... is denied"
    assert.ok(!existsSync(join(outside, "hack.txt")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("read-only：工作区内写也被拒", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-ws-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-tmp-"));
  try {
    const r = await RUNNER.run("Set-Content -Path .\\no.txt -Value x", policy("read-only", ws, tmp), {
      timeoutMs: 120_000,
    });
    assert.notEqual(r.code, 0);
    assert.ok(!existsSync(join(ws, "no.txt")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("workspace-write：读工作区外成功（只约束写不约束读）", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-ws-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-tmp-"));
  try {
    const r = await RUNNER.run("(Test-Path C:\\Windows\\System32\\cmd.exe) -or (Test-Path C:\\Windows)", policy("workspace-write", ws, tmp), {
      timeoutMs: 120_000,
    });
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.includes("True"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("超时：Job Object 杀整棵进程树（孙进程不残留）", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-ws-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-tmp-"));
  try {
    const r = await RUNNER.run(
      "Start-Process -WindowStyle Hidden cmd -ArgumentList '/c ping -n 60 127.0.0.1 >nul'; Start-Sleep -Seconds 300",
      policy("workspace-write", ws, tmp),
      { timeoutMs: 6_000 },
    );
    assert.equal(r.timedOut, true);
    // Job Object KILL_ON_JOB_CLOSE：主进程与孙进程（ping）都应被杀
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const list = execSync('tasklist /FI "IMAGENAME eq ping.exe" /FO CSV', { encoding: "utf8" });
    assert.ok(!list.includes("ping.exe"), `ping 孙进程残留：${list}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("临时目录环境重定向：TMP/TEMP 指向私有临时目录且可写", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-ws-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-tmp-"));
  try {
    const r = await RUNNER.run('$env:TEMP; Set-Content -Path (Join-Path $env:TEMP "t.txt") -Value tmp-ok; Get-Content (Join-Path $env:TEMP "t.txt")', policy("workspace-write", ws, tmp), {
      timeoutMs: 120_000,
    });
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.includes(tmp), "TEMP 应重定向到私有临时目录");
    assert.ok(r.stdout.includes("tmp-ok"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- pwshTool × 真实后端集成（workspace-write 全链路）----
test("集成：pwshTool(workspace-write) 走真实沙箱——工作区内写成功、工作区外写触发拒绝文案", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-int-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-int-tmp-"));
  setSandboxRunner(new WindowsAclRunner());
  const tool = createPwshTool(); // 新实例=额度清零（升级额度是会话内状态）
  try {
    const ctx: ToolContext = {
      workspace: { root: ws },
      requestApproval: async () => "rejected",
      sandboxMode: "workspace-write",
      privateTempDir: tmp,
    };
    const inside = await tool.execute(
      { command: "Set-Content -Path .\it.txt -Value ok; Get-Content .\it.txt", description: "写工作区内文件" },
      ctx,
    );
    assert.ok(inside.includes("ok"));
    assert.ok(inside.includes("exit code: 0"));

    const outside = join(tmpdir(), "zqq-sbx-int-outside.txt");
    const denied = await tool.execute(
      { command: `Set-Content -Path "${outside}" -Value x`, description: "写工作区外文件" },
      ctx,
    );
    assert.ok(denied.includes("sandbox: 工作区外写入/删除被拒绝"), denied.slice(0, 200));
    assert.ok(denied.includes("justification"), "应提示升级重试通道");
    assert.ok(!existsSync(outside));
    rmSync(outside, { force: true });
  } finally {
    setSandboxRunner(noBackend); // 还原全局接缝，避免影响其他测试
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- 升级重试（额度制）× 真实后端 ----
test("集成：沙箱拒绝后带 justification 的下一次调用（换命令写法也算）转人工审批放行一次", { skip: !ENABLED }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "zqq-sbx-esc-"));
  const tmp = mkdtempSync(join(tmpdir(), "zqq-sbx-esc-tmp-"));
  setSandboxRunner(new WindowsAclRunner());
  const tool = createPwshTool(); // 新实例=额度清零；同一实例内的三次调用共享额度流转
  const outside = join(tmpdir(), "zqq-sbx-esc-out.txt");
  rmSync(outside, { force: true });
  const reqs: ApprovalRequest[] = [];
  try {
    const ctx: ToolContext = {
      workspace: { root: ws },
      requestApproval: async (req) => {
        reqs.push(req);
        return "allowed-once";
      },
      sandboxMode: "workspace-write",
      privateTempDir: tmp,
    };
    const d1 = await tool.execute(
      { command: `Set-Content -Path "${outside}" -Value x`, description: "写工作区外文件" },
      ctx,
    );
    assert.ok(d1.includes("sandbox: 工作区外写入/删除被拒绝"));
    assert.equal(reqs.length, 0); // 未带 justification：直接沙箱拒绝，不弹审批

    const d2 = await tool.execute(
      {
        command: `[IO.File]::WriteAllText("${outside}", "x")`,
        description: "换一种写法写工作区外文件",
        justification: "用户明确要求把文件放到工作区外",
      },
      ctx,
    );
    assert.equal(reqs.length, 1); // 命令与被拒命令不同也弹审批（额度制）
    assert.ok(d2.includes("exit code: 0"), d2.slice(0, 200));
    assert.ok(existsSync(outside)); // 批准后无约束执行

    const d3 = await tool.execute(
      {
        command: `[IO.File]::WriteAllText("${outside}", "y")`,
        description: "再次写工作区外文件",
        justification: "再写一次",
      },
      ctx,
    );
    assert.equal(reqs.length, 1); // 额度已被消费：不再弹审批
    assert.ok(d3.includes("sandbox: 工作区外写入/删除被拒绝"));
  } finally {
    setSandboxRunner(noBackend);
    rmSync(ws, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
