import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPwshTool, runPwsh, stripAnsi } from "./pwsh.ts";
import { createWorkspace } from "../../../workspace.ts";
import type { ToolContext } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import type { ApprovalDecision, ApprovalRequest } from "../../../approval/types.ts";
import type { SandboxMode } from "../../../sandbox/types.ts";
import { getSandboxRunner, setSandboxRunner, noBackend, type SandboxRunner } from "../../../sandbox/runner.ts";

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

// ---------- docs/30：deps live 读——运行中改权限，下一命令（甚至卡批准后的本条）即用新值 ----------

/** live deps 桩：sandboxMode/alwaysConfirm 可变闭包（模拟会话设置运行中被改）；其余成员不影响 pwsh，桩最小集断言转型 */
function liveDeps(mut: { mode: SandboxMode; confirm: boolean }): SystemToolDeps {
  return {
    alwaysConfirm: () => mut.confirm,
    sandboxMode: () => mut.mode,
  } as unknown as SystemToolDeps;
}

test("docs/30 live 读：逐条确认运行中关掉后，下一命令不再弹卡（ctx 快照不动）", async () => {
  const mut = { mode: "danger-full-access" as SandboxMode, confirm: true };
  const tool = createPwshTool(liveDeps(mut));
  const asks: ApprovalRequest[] = [];
  const approve = async (req: ApprovalRequest) => {
    asks.push(req);
    return "allowed-once" as const;
  };
  const out1 = await tool.execute({ command: 'Write-Output "a1"', description: "逐条确认期间" }, makeCtx({ alwaysConfirm: true, requestApproval: approve }));
  assert.equal(asks.length, 1, "逐条确认开着：弹卡");
  assert.ok(out1.includes("a1"));
  mut.confirm = false; // 运行中切换审批策略（审批卡「不再询问」或顶栏下拉）
  const out2 = await tool.execute({ command: 'Write-Output "a2"', description: "切换后" }, makeCtx({ alwaysConfirm: true, requestApproval: approve }));
  assert.equal(asks.length, 1, "切换后不再弹卡——deps live 读，ctx 里残留的 alwaysConfirm=true 被无视");
  assert.ok(out2.includes("a2"));
});

test("docs/30 live 读：卡上「解除沙箱并放行」——批准后重读模式，本条命令即无约束执行（无需沙箱后端）", async () => {
  const mut = { mode: "workspace-write" as SandboxMode, confirm: true };
  const tool = createPwshTool(liveDeps(mut));
  const out = await tool.execute(
    { command: 'Write-Output "live-flip"', description: "卡上切全开放" },
    makeCtx({
      // ctx 快照故意停在 workspace-write：若实现误读 ctx，批准后会落 SANDBOX_UNAVAILABLE，断言即抓
      alwaysConfirm: true,
      sandboxMode: "workspace-write",
      requestApproval: async () => {
        mut.mode = "danger-full-access"; // 模拟决议前服务端已应用 apply 补丁（会话模式已切全开放）
        return "allowed-once";
      },
    }),
  );
  assert.ok(out.includes("live-flip"), "批准后重读 live 模式 → 本条即无约束执行");
  assert.ok(!out.includes("SANDBOX_UNAVAILABLE"));
});

// ---------- 真机回归（docs/30 §5）：exit 0 的非终止性拒绝也要识别 ----------
// 真机实录：Remove-Item 的 Access denied 是非终止性错误，脚本后续语句照跑 → pwsh 整体
// exit 0 → 旧口径（code!==0 且 stderr 命中）完全漏检：不打 [sandbox:] 标、不攒额度、
// justification 被静默忽略——删除命令全军覆没却无一卡。修复：识别只看 stderr。

const CLIXML_DENIED =
  '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  `<S S="Error">_x001B_[31;1mRemove-Item: _x001B_[31;1mAccess to the path 'F:\ws\区外.txt' is denied._x001B_[0m_x000D__x000A_</S></Objs>`;

function fakeRunner(stderr: string, stdout = "文件还存在吗: True", code = 0): SandboxRunner {
  return {
    name: "fake",
    available: () => true,
    run: async () => ({ code, timedOut: false, interrupted: false, overLimit: false, stdout, stderr }),
  };
}

test("真机回归：exit 0 的非终止性拒绝也识别——打 [sandbox:] 标并攒升级额度", async () => {
  setSandboxRunner(fakeRunner(CLIXML_DENIED));
  try {
    const tool = createPwshTool(); // 独立实例：升级额度会话内隔离
    const out = await tool.execute(
      { command: "Remove-Item out.txt; Write-Output 'done'", description: "删除区外文件" },
      makeCtx({ sandboxMode: "workspace-write" }),
    );
    assert.ok(out.includes("[sandbox: 工作区外写入/删除被拒绝"), "exit code 0 也必须识别为拒绝（旧口径漏检）");
    assert.ok(out.includes("justification"), "带升级提示");
  } finally {
    setSandboxRunner(noBackend); // 还原全局接缝（win.test.ts 同款惯例）
  }
});

test("真机回归完整链路：exit 0 拒绝攒额度 → justification 重试弹卡 → 批准后无约束执行", async () => {
  setSandboxRunner(fakeRunner(CLIXML_DENIED));
  try {
    const tool = createPwshTool();
    const asks: ApprovalRequest[] = [];
    const count = async (req: ApprovalRequest) => {
      asks.push(req);
      return "allowed-once" as const;
    };
    const deny = await tool.execute(
      { command: "Remove-Item out.txt", description: "删除区外文件" },
      makeCtx({ sandboxMode: "workspace-write", requestApproval: count }),
    );
    assert.ok(deny.includes("[sandbox:"), "第一通：拒绝被识别");
    assert.equal(asks.length, 0, "第一通无 justification：不弹卡");
    const ok = await tool.execute(
      { command: 'Write-Output "escalation-ok"', description: "带 justification 重试", justification: "需要删除上一条被拒的区外文件" },
      makeCtx({ sandboxMode: "workspace-write", requestApproval: count }),
    );
    assert.equal(asks.length, 1, "第二通：额度已攒出，justification 弹卡转人工");
    assert.equal(asks[0]!.justification, "需要删除上一条被拒的区外文件", "卡上带提权理由");
    assert.ok(ok.includes("escalation-ok"), "批准后无约束执行（真跑 pwsh）");
  } finally {
    setSandboxRunner(noBackend);
  }
});

test("真机回归：justification 带了但额度为 0 且未被拒 → 明示反馈而非静默忽略", async () => {
  setSandboxRunner(fakeRunner("", "fine"));
  try {
    const tool = createPwshTool();
    let asked = 0;
    const out = await tool.execute(
      { command: 'Write-Output "fine"', description: "带 justification 但没被拒过", justification: "想直接提权" },
      makeCtx({
        sandboxMode: "workspace-write",
        requestApproval: async () => {
          asked++;
          return "allowed-once" as const;
        },
      }),
    );
    assert.equal(asked, 0, "额度为 0，不弹卡");
    assert.ok(out.includes("justification 未生效"), "明示反馈（不再静默）");
    assert.ok(out.includes("并未被沙箱拒绝"));
  } finally {
    setSandboxRunner(noBackend);
  }
});

// ---------- docs/42：超时回执（部分输出/PID/进程树）、无缓冲、ANSI 剥离、只读子代理 ----------

test("docs/42 stripAnsi：CSI 颜色/光标序列与 OSC 标题被剥离，普通文本（含方括号）原样", () => {
  assert.equal(stripAnsi("\x1b[31;1mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("\x1b]0;title\x07after"), "after");
  assert.equal(stripAnsi("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\."), "link.");
  assert.equal(stripAnsi("a[31]b (c) [x]"), "a[31]b (c) [x]", "方括号数字不是转义序列");
  assert.equal(stripAnsi("进度 50%\x1b"), "进度 50%", "采集截断处的半截 ESC 一并清掉");
});

test("docs/42 runPwsh：超时返回已捕获的部分输出与 PID，整棵进程树被终止（孙进程不残留、调用即时返回）", async () => {
  // 先打印一行进度，再拉一个会睡 60 s 的孙进程（打印其 PID），自己再睡 30 s——旧实现只杀 pwsh：
  // 孙进程成为孤儿并攥着继承的 stdout 管道，'close' 要等它睡完才触发
  const cmd =
    "Write-Output 'step-1 done'; " +
    "$g = Start-Process -NoNewWindow -PassThru pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60'; " +
    "Write-Output \"GPID=$($g.Id)\"; Start-Sleep -Seconds 30";
  const t0 = Date.now();
  const out = await runPwsh(cmd, { cwd: WS.root, timeoutMs: 4_000 });
  const elapsed = Date.now() - t0;
  assert.ok(out.includes("超时被终止"), out);
  assert.ok(out.includes("step-1 done"), `超时前已捕获的输出如实返回：\n${out}`);
  assert.match(out, /进程树 PID \d+ 已一并终止/, "回执报出进程树 PID");
  assert.ok(out.includes("pwshMaxTimeoutMs"), "给出下一步指引（拆分/落盘中间结果/调大上限）");
  assert.ok(elapsed < 20_000, `调用应在超时后很快返回，而不是等孙进程睡完 60 s（实际 ${elapsed}ms）`);
  const gpid = Number(/GPID=(\d+)/.exec(out)?.[1]);
  assert.ok(Number.isInteger(gpid) && gpid > 0, `应拿到孙进程 PID：${out}`);
  await new Promise((r) => setTimeout(r, 300)); // taskkill 异步收尾的余量
  assert.throws(() => process.kill(gpid, 0), "孙进程已随进程树终止（kill(pid, 0) 应抛 ESRCH）");
});

test("docs/42 runPwsh：子进程缺省 PYTHONUNBUFFERED=1（Python 行缓冲，进度不丢）；宿主显式设置则尊重", async () => {
  const prev = process.env.PYTHONUNBUFFERED;
  try {
    delete process.env.PYTHONUNBUFFERED;
    const dflt = await runPwsh('Write-Output "PYUNC=$env:PYTHONUNBUFFERED"', { cwd: WS.root, timeoutMs: 30_000 });
    assert.match(dflt, /PYUNC=1/);
    process.env.PYTHONUNBUFFERED = "0";
    const explicit = await runPwsh('Write-Output "PYUNC=$env:PYTHONUNBUFFERED"', { cwd: WS.root, timeoutMs: 30_000 });
    assert.match(explicit, /PYUNC=0/, "宿主已显式设置则原样传递");
  } finally {
    if (prev === undefined) delete process.env.PYTHONUNBUFFERED;
    else process.env.PYTHONUNBUFFERED = prev;
  }
});

test("docs/42 runPwsh：输出里的 ANSI 颜色码被剥离后入模型", async () => {
  const out = await runPwsh('[Console]::WriteLine("$([char]27)[32;1mgreen$([char]27)[0m plain")', { cwd: WS.root, timeoutMs: 30_000 });
  assert.ok(out.includes("green plain"), out);
  assert.ok(!out.includes("\x1b"), "转义序列不进模型文本");
});

test("docs/42 只读子代理：ctx.readOnly 钉死只读沙箱（会话全开放也不放开）、不可提权（justification 不弹卡）", async () => {
  const modes: string[] = [];
  let denied = 0;
  setSandboxRunner({
    name: "fake",
    available: () => true,
    run: async (_c, policy) => {
      modes.push(policy.mode);
      // 第一次：模拟写入被拒（攒升级额度）；第二次：带 justification 的重试
      if (denied++ === 0) return { code: 1, timedOut: false, interrupted: false, overLimit: false, stdout: "", stderr: "Remove-Item: Access to the path is denied." };
      return { code: 0, timedOut: false, interrupted: false, overLimit: false, stdout: "read-ok", stderr: "" };
    },
  });
  try {
    const tool = createPwshTool();
    const asks: ApprovalRequest[] = [];
    const ctx = makeCtx({
      sandboxMode: "danger-full-access", // 会话本身全开放
      readOnly: true, // 只读子代理
      requestApproval: async (req) => {
        asks.push(req);
        return "allowed-once" as const;
      },
    });
    await tool.execute({ command: "Remove-Item out.txt", description: "只读实例的写尝试" }, ctx);
    const retry = await tool.execute({ command: "Remove-Item out.txt", description: "带 justification 重试", justification: "想提权" }, ctx);
    assert.deepEqual(modes, ["read-only", "read-only"], "两条都按只读沙箱执行（不因会话全开放而无约束）");
    assert.equal(asks.length, 0, "只读实例不走升级链路：不弹提权卡");
    assert.ok(retry.includes("只读模式") && retry.includes("提权不生效"), retry);
  } finally {
    setSandboxRunner(noBackend);
  }
});

test("docs/42 源码哨兵：沙箱受限执行的 PYTHONUNBUFFERED 还原必须用 delete（赋 undefined 会写成字符串 \"undefined\"）", () => {
  const src = readFileSync(new URL("../../sandbox/windows-acl/windows-acl.ts", import.meta.url), "utf8");
  assert.ok(src.includes('process.env.PYTHONUNBUFFERED = "1"'), "受限进程创建前设置无缓冲");
  assert.ok(src.includes("delete process.env.PYTHONUNBUFFERED"), "创建后用 delete 还原");
  assert.ok(!/process\.env\.PYTHONUNBUFFERED = prev/.test(src), "不得用赋值还原（undefined → \"undefined\"）");
});
