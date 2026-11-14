import test from "node:test";
import assert from "node:assert/strict";
import { createPwshTool, runPwsh } from "./pwsh.ts";
import { createWorkspace } from "../../../workspace.ts";
import type { ToolContext } from "../../../tools/registry.ts";
import type { ApprovalDecision, ApprovalRequest } from "../../../approval/types.ts";
import { getSandboxRunner, setSandboxRunner, noBackend } from "../../../sandbox/runner.ts";

const WS = createWorkspace(process.cwd());

// 本文件的用例不触发升级额度流转，共享一个实例即可（额度相关用例在 sandbox/win.test.ts，各自实例化）
const pwshTool = createPwshTool();

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: WS,
    requestApproval: async (): Promise<ApprovalDecision> => "rejected",
    sandboxMode: "danger-full-access",
    ...over,
  };
}

test("工作区内命令直接执行（不走批准）", async () => {
  const out = await pwshTool.execute(
    { command: 'Write-Output "zqq-ok"', description: "输出确认字符串" },
    makeCtx(),
  );
  assert.ok(out.includes("zqq-ok"));
  assert.ok(out.includes("exit code: 0"));
});

test("description 缺失/为空被拒（schema 逼模型交代命令摘要）", async () => {
  const missing = await pwshTool.execute({ command: "Write-Output x" }, makeCtx());
  assert.ok(missing.includes("description 不能为空"));
  const blank = await pwshTool.execute({ command: "Write-Output x", description: "   " }, makeCtx());
  assert.ok(blank.includes("description 不能为空"));
});

test("逐条确认（workspace-write）：区内命令也弹卡；拒绝则不执行", async () => {
  const asks: ApprovalRequest[] = [];
  const out = await pwshTool.execute(
    { command: 'Write-Output "should-not-run"', description: "逐条确认测试" },
    makeCtx({
      alwaysConfirm: true,
      sandboxMode: "workspace-write",
      requestApproval: async (req) => {
        asks.push(req);
        return "rejected";
      },
    }),
  );
  assert.equal(asks.length, 1);
  assert.ok(out.includes("拒绝"));
  assert.ok(!out.includes("should-not-run")); // 命令没有真正执行
});

test("逐条确认（workspace-write）：批准后仍按受约束模式走（无后端 → SANDBOX_UNAVAILABLE 而非执行）", async () => {
  const asks: ApprovalRequest[] = [];
  const out = await pwshTool.execute(
    { command: 'Write-Output "x"', description: "逐条确认测试" },
    makeCtx({
      alwaysConfirm: true,
      sandboxMode: "workspace-write",
      requestApproval: async (req) => {
        asks.push(req);
        return "allowed-once";
      },
    }),
  );
  assert.equal(asks.length, 1);
  assert.ok(out.includes("SANDBOX_UNAVAILABLE")); // 默认无后端：批准不越模式边界
});

test("全开放模式下守卫命中但未开逐条确认 → 直接执行（守卫只是提示层）", async () => {
  let asked = 0;
  const out = await pwshTool.execute(
    { command: "Get-Item C:\\Windows", description: "查看系统目录" },
    makeCtx({
      alwaysConfirm: false,
      requestApproval: async () => {
        asked++;
        return "allowed-once";
      },
    }),
  );
  assert.equal(asked, 0); // 全开放模式不走审批
  assert.ok(out.includes("exit code"));
});

test("全开放模式 + 逐条确认：审批拒绝 → 命令不实际执行", async () => {
  const seen: ApprovalRequest[] = [];
  const out = await pwshTool.execute(
    { command: "Set-Content -Path C:\\Windows\\zqq_test.txt -Value x", description: "写系统目录文件" },
    makeCtx({
      alwaysConfirm: true,
      requestApproval: async (req) => {
        seen.push(req);
        return "rejected";
      },
    }),
  );
  assert.ok(out.includes("拒绝"));
  assert.ok(out.includes("工作区"));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].description, "写系统目录文件"); // 审批请求携带模型自带摘要
});

test("全开放模式 + 逐条确认：allowed-once 放行且仅当次", async () => {
  let calls = 0;
  const ctx = makeCtx({
    alwaysConfirm: true,
    requestApproval: async () => {
      calls++;
      return "allowed-once";
    },
  });
  const out = await pwshTool.execute({ command: 'Write-Output "one"', description: "输出 one" }, ctx);
  assert.ok(out.includes("one"));
  assert.equal(calls, 1);
  const out2 = await pwshTool.execute({ command: 'Write-Output "two"', description: "输出 two" }, ctx);
  assert.ok(out2.includes("two"));
  assert.equal(calls, 2); // 不做会话级放行：每次都要批准
});

test("审批 cancelled/unavailable 都按拒绝处理，文案不同", async () => {
  const cancelled = await pwshTool.execute(
    { command: "Write-Output x", description: "输出 x" },
    makeCtx({ alwaysConfirm: true, requestApproval: async () => "cancelled" }),
  );
  assert.ok(cancelled.includes("取消"));
  const unavailable = await pwshTool.execute(
    { command: "Write-Output x", description: "输出 x" },
    makeCtx({ alwaysConfirm: true, requestApproval: async () => "unavailable" }),
  );
  assert.ok(unavailable.includes("不可用"));
});

test("受约束模式（workspace-write）无后端 → SANDBOX_UNAVAILABLE（fail-closed）", async () => {
  setSandboxRunner(noBackend);
  for (const sandboxMode of ["workspace-write", "read-only"] as const) {
    const out = await pwshTool.execute(
      { command: 'Write-Output "zqq-ok"', description: "输出确认字符串" },
      makeCtx({ sandboxMode }),
    );
    assert.ok(out.includes("SANDBOX_UNAVAILABLE"), sandboxMode);
    assert.ok(!out.includes("zqq-ok"), sandboxMode); // 绝不静默放行
  }
});

test("沙箱接缝：默认 noBackend 不可用", () => {
  assert.equal(getSandboxRunner().available(), false);
});

test("runPwsh：正常执行并捕获 exit code", async () => {
  const out = await runPwsh("Write-Output 42", { cwd: WS.root, timeoutMs: 30_000 });
  assert.ok(out.includes("42"));
  assert.ok(out.includes("exit code: 0"));
});

test("runPwsh：超时被终止", async () => {
  const out = await runPwsh("Start-Sleep -Seconds 30", { cwd: WS.root, timeoutMs: 1_500 });
  assert.ok(out.includes("超时"));
});

test("runPwsh：中文输出不乱码（UTF-8）", async () => {
  const out = await runPwsh('Write-Output "你好，工作区"', { cwd: WS.root, timeoutMs: 30_000 });
  assert.ok(out.includes("你好，工作区"));
});

// ---------- SA3：scope 越界强制弹卡（docs/5 §5.4，任何沙箱模式含 danger 都弹） ----------

test("scope 越界：danger-full-access 下也强制弹卡，reasons 标注 scope（诚实边界由用户裁决）", async () => {
  const asks: ApprovalRequest[] = [];
  const out = await pwshTool.execute(
    { command: 'Write-Output "reading" | Set-Content src/other/f.txt', description: "写 scope 外文件" },
    makeCtx({
      alwaysConfirm: false, // 未开逐条确认
      sandboxMode: "danger-full-access", // 全开放模式
      writeScope: ["src/auth", "docs"],
      requestApproval: async (req) => {
        asks.push(req);
        return "rejected";
      },
    }),
  );
  assert.equal(asks.length, 1, "scope 越界即使 danger-full-access 也弹卡");
  assert.ok(asks[0].reasons.some((r) => r.includes("scope")), JSON.stringify(asks[0].reasons));
  assert.ok(out.includes("拒绝"));
});

test("scope 命中区内：不额外弹卡，照常执行", async () => {
  let asked = 0;
  const out = await pwshTool.execute(
    { command: 'Write-Output "ok-scope"', description: "scope 内输出" },
    makeCtx({
      alwaysConfirm: false,
      sandboxMode: "danger-full-access",
      writeScope: ["src/auth", "docs"],
      requestApproval: async () => {
        asked++;
        return "rejected";
      },
    }),
  );
  assert.equal(asked, 0);
  assert.ok(out.includes("ok-scope"));
});

test("scope 越界批准后照常执行（用户裁决可放行）", async () => {
  const out = await pwshTool.execute(
    { command: 'Write-Output "approved-scope"', description: "用户批准越界" },
    makeCtx({
      alwaysConfirm: false,
      sandboxMode: "danger-full-access",
      writeScope: ["src/auth"],
      requestApproval: async () => "allowed-once",
    }),
  );
  assert.ok(out.includes("approved-scope"), "批准后执行");
});

// ---------- W1 路线 A'（docs/7 §1.3）：只读命令豁免 scope reason（scope 管写不管读） ----------

test("W1 只读豁免：Select-String 查 scope 外代码不再弹卡，照常执行", async () => {
  let asked = 0;
  const out = await pwshTool.execute(
    { command: "Select-String -Path src/modules/tools/pwsh/pwsh.ts -Pattern 'zqq-should-not-match-xyz'", description: "查源码" },
    makeCtx({
      alwaysConfirm: false,
      sandboxMode: "danger-full-access",
      writeScope: ["src/auth", "docs"],
      requestApproval: async () => {
        asked++;
        return "rejected";
      },
    }),
  );
  assert.equal(asked, 0, "只读命令（首 token 白名单 + 无写形态）豁免 scope 强制弹卡");
  assert.ok(out.includes("exit code: 0"));
});

test("W1 只读豁免的边界：含重定向写形态不豁免；逐条确认下工作区外 reason 照常上卡且不带 scope", async () => {
  const asks: ApprovalRequest[] = [];
  const out = await pwshTool.execute(
    { command: "Get-Content docs/a.txt > src/other/b.txt", description: "读并重定向到区外" },
    makeCtx({
      alwaysConfirm: false,
      sandboxMode: "danger-full-access",
      writeScope: ["docs"],
      requestApproval: async (req) => {
        asks.push(req);
        return "rejected";
      },
    }),
  );
  assert.equal(asks.length, 1, "重定向是写形态 → 不豁免");
  assert.ok(asks[0].reasons.some((r) => r.includes("scope")));

  asks.length = 0;
  const out2 = await pwshTool.execute(
    { command: 'Get-Content "C:\\Windows\\win.ini" | Select-Object -First 1', description: "读系统文件" },
    makeCtx({
      alwaysConfirm: true, // 既有守卫的 reason 上卡展示面 = 逐条确认（守卫是提示层，read 本不受限）
      sandboxMode: "danger-full-access",
      writeScope: ["docs"],
      requestApproval: async (req) => {
        asks.push(req);
        return "rejected";
      },
    }),
  );
  assert.equal(asks.length, 1);
  assert.ok(asks[0].reasons.some((r) => r.includes("工作区外")), "工作区外 reason 不豁免（普通会话同一安全面）");
  assert.ok(!asks[0].reasons.some((r) => r.includes("scope")), "scope reason 已被只读豁免");
  assert.ok(out2.includes("拒绝"));
});

test("W1 卡 B 实弹：python here-string 源码不再触发 scope 强制弹卡；逐条确认下解释器绝对路径 reason 照常上卡", async () => {
  // 默认模式（未开逐条确认）：scope 命中集为空 → 不再强制弹卡，直接执行（B 类默认选项①：
  // 绝对路径守卫不动——它的 reason 只在逐条确认等既有弹卡面上展示）
  let asked = 0;
  const out = await pwshTool.execute(
    {
      command: '& "D:/Programs/Python/Python314/python.exe" -c @"\nimport mpmath as mp\nprint(1/2)\n"@',
      description: "跑高精度计算",
    },
    makeCtx({
      alwaysConfirm: false,
      sandboxMode: "danger-full-access",
      writeScope: ["scripts"],
      requestApproval: async () => {
        asked++;
        return "rejected";
      },
    }),
  );
  assert.equal(asked, 0, "here-string 源码不再进 scope 命中集 → 无强制弹卡");
  assert.ok(out.includes("exit code"));

  const asks: ApprovalRequest[] = [];
  await pwshTool.execute(
    {
      command: '& "D:/Programs/Python/Python314/python.exe" -c @"\nimport mpmath as mp\nprint(1/2)\n"@',
      description: "跑高精度计算",
    },
    makeCtx({
      alwaysConfirm: true,
      sandboxMode: "danger-full-access",
      writeScope: ["scripts"],
      requestApproval: async (req) => {
        asks.push(req);
        return "rejected";
      },
    }),
  );
  assert.equal(asks.length, 1);
  assert.ok(asks[0].reasons.some((r) => r.includes("工作区外")), "解释器绝对路径的既有守卫照常（不动守卫，提示词引导用 PATH 短名）");
  assert.ok(!asks[0].reasons.some((r) => r.includes("scope")), "scope 命中集不含 here-string 源码");
});
