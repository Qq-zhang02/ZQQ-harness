import { spawn, type ChildProcess } from "node:child_process";
import { checkCommandAgainstWorkspace, isReadOnlyPwshCommand, pathHintsOutsideScope } from "../../../workspace.ts";
import { DEFAULTS, ESCALATION_MAX, PWSH_CAPTURE_MAX_BYTES } from "../../../config.ts";
import type { Tool, ToolContext } from "../../../tools/registry.ts";
import type { SystemToolDeps } from "../../../core/types.ts";
import { getSandboxRunner } from "../../../sandbox/runner.ts";
import type { SandboxMode, SandboxPolicy } from "../../../sandbox/types.ts";
import type { ApprovalDecision } from "../../../approval/types.ts";

interface CollectResult {
  code: number | null;
  timedOut: boolean;
  interrupted: boolean;
  overLimit: boolean;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

/** 启动一个子进程并采集输出（超时/中断/UTF-8/采集上限）。child 可来自沙箱受限启动。 */
function collectChild(
  child: ChildProcess,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<CollectResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let captured = 0;
    let overLimit = false;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (chunks: Buffer[]) => (d: Buffer) => {
      if (captured >= PWSH_CAPTURE_MAX_BYTES) { // 超过后停止采集，防止极端输出撑爆内存（输出修剪由注册表层统一负责；harness.json 可覆盖）
        overLimit = true;
        return;
      }
      captured += d.length;
      chunks.push(d);
    };
    child.stdout?.on("data", collect(outChunks));
    child.stderr?.on("data", collect(errChunks));

    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        timedOut,
        interrupted: opts.signal?.aborted === true,
        overLimit,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

function formatResult(r: CollectResult): string {
  const head =
    `exit code: ${r.code ?? "unknown"}` +
    `${r.timedOut ? "（超时被终止）" : ""}` +
    `${r.interrupted ? "（被用户中断）" : ""}` +
    `${r.overLimit ? "（输出超过采集上限，已丢弃部分内容）" : ""}`;
  const body = `\n\n[stdout]\n${r.stdout || "(空)"}\n\n[stderr]\n${r.stderr || "(空)"}`;
  return head + body;
}

/** 执行一条 PowerShell 7 命令（无约束），返回给模型的结果文本。 */
export async function runPwsh(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  // 让子进程以 UTF-8 输出，避免中文乱码
  const preamble = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", preamble + command], {
    cwd: opts.cwd,
    windowsHide: true,
  });
  const r = await collectChild(child, opts);
  if (r.spawnError) {
    return `执行失败：无法启动 pwsh（${r.spawnError.message}）。请确认已安装 PowerShell 7 并在 PATH 中。`;
  }
  return formatResult(r);
}

const MODE_LABEL: Record<SandboxMode, string> = {
  "read-only": "read-only（只读）",
  "workspace-write": "workspace-write（仅工作区可写）",
  "danger-full-access": "danger-full-access（无约束）",
};

/** 审批未放行时回传给模型的文案（rejected 保持原文案，让模型自行修正）。 */
function refusalText(decision: ApprovalDecision): string {
  switch (decision) {
    case "rejected":
      return (
        "用户拒绝执行该命令（涉及工作区外的修改需要用户批准）。" +
        "请改用工作区内的相对路径重新尝试，或先向用户说明为什么需要操作工作区外的内容。"
      );
    case "cancelled":
      return "审批等待被取消（用户中断了本轮任务）。命令未执行。";
    default:
      return "审批不可用（无人值守模式或审批服务异常），命令未执行。如需执行请让用户退出无人值守模式。";
  }
}

// ---- 升级重试（escalation）：沙箱拒绝后记一次"升级额度"；下一次调用只要带 justification
// 就转交人工审批（额度无论批准与否都被消费）。不要求逐字节复现被拒命令——模型换一种
// 写法实现同一意图时同样能走到审批，人工在审批卡上看到完整命令后自行把关。 ----
// 额度上限 = config.ESCALATION_MAX（harness.json escalationMax 可覆盖，缺省 8）。 ----

/** 提供给模型的 pwsh 工具：带命令摘要（description）、守卫提示与审批/沙箱模式裁决。
 *  每会话实例化一份（SystemToolDef.create()）：升级额度是会话内状态，多会话互不影响。
 *  docs/30：沙箱模式/逐条确认经 deps **live 读**会话设置（ctx 快照仅作无 deps 测试桩的
 *  回退）——运行中改权限，本命令的裁决就用新值；审批卡「解除沙箱并放行」对本条立即生效。
 *  系统提示的"可用工具"行文案由模块 index.ts 的 SystemToolDef.summary 声明，不在此处。 */
export function createPwshTool(deps?: SystemToolDeps): Tool {
  let escalationCredits = 0;

  /** 沙箱后端可用时的受限执行；工作区外写入被 OS 拒绝时回传拒绝事实 + 原样 stderr + 升级提示。 */
  async function runSandboxed(
    command: string,
    policy: SandboxPolicy,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string> {
    const runner = getSandboxRunner();
    const r = await runner.run(command, policy, opts);
    // 拒绝识别只看 stderr，不设 exit-code 门槛（真机回归 docs/30 §5）：Remove-Item 等
    // 非终止性错误后脚本继续执行（Test-Path/Write-Output），pwsh 整体 exit 0——按旧口径
    // （code!==0 且 stderr 命中）这类拒绝完全漏检：不打 [sandbox:] 标、不攒升级额度，
    // 模型带 justification 重试被静默忽略，永远走不到人工审批。误攒成本可控：额度只在
    // 模型随后真的带 justification 时消费（每次 -1），且有 8 点/会话上限。
    const denied = /is denied|拒绝访问|访问被拒/i.test(r.stderr);
    if (!denied) return formatResult({ ...r, spawnError: undefined });
    escalationCredits = Math.min(escalationCredits + 1, ESCALATION_MAX);
    return (
      `[sandbox: 工作区外写入/删除被拒绝（${MODE_LABEL[policy.mode]} 模式）]\n` +
      formatResult({ ...r, spawnError: undefined }) +
      "\n如确需更宽权限，可在下一次调用带 justification 参数（一句话说明理由）申请用户人工批准；" +
      "命令可以原样重试，也可以换一种实现方式。"
    );
  }

  return {
    name: "run_pwsh",
    description:
      "在本机 Windows PowerShell 7 (pwsh) 中执行一条命令。工作目录为工作区根目录。" +
      "可用于查看/创建/修改工作区内文件、运行脚本和程序、查询系统信息。" +
      "注意：默认（workspace-write）只允许修改工作区内的文件，读操作不受限；" +
      "引用工作区外路径或系统级操作会触发审批或沙箱拦截。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 PowerShell 命令" },
        description: {
          type: "string",
          description: "用主动语态、5–10 个词概括这条命令要做什么（如：删除 build 目录下的临时文件）",
        },
        justification: {
          type: "string",
          description:
            "可选。仅当上一条命令刚被沙箱拒绝、且你确实需要更宽权限时使用：一句话说明理由，" +
            "本次执行将转交用户人工批准。不要在普通调用时填写。",
        },
        timeout_ms: { type: "integer", description: `可选，超时毫秒数，默认 ${DEFAULTS.pwshTimeoutMs}，最大 ${DEFAULTS.pwshMaxTimeoutMs}` },
      },
      required: ["command", "description"],
    },

    async execute(args, ctx: ToolContext): Promise<string> {
      const command = String(args.command ?? "");
      if (!command.trim()) return "错误：command 不能为空";
      const description = String(args.description ?? "").trim();
      if (!description) return "错误：description 不能为空，请用一句话概括这条命令的目的";
      const justification = String(args.justification ?? "").trim();

      const requested = Number(args.timeout_ms ?? DEFAULTS.pwshTimeoutMs);
      const timeoutMs = Math.min(
        Math.max(Number.isFinite(requested) ? requested : DEFAULTS.pwshTimeoutMs, 1_000),
        DEFAULTS.pwshMaxTimeoutMs,
      );

      // 守卫（提示层，永远跑）：产出 reasons 喂给审批卡，不再承担放行/拦截裁决
      const check = checkCommandAgainstWorkspace(command, ctx.workspace.root);
      // docs/30：沙箱模式 live 读（deps 会话闭包；无 deps 的测试桩回退 ctx 快照）——每个
      // 裁决点各读一次，运行中改模式/审批卡上切模式，裁决与执行就用当下生效值
      const modeOf = (): SandboxMode => deps?.sandboxMode() ?? (ctx.sandboxMode ?? "workspace-write");
      // 子代理 scope 越界（docs/5 §5.4）：文件级硬约束的 pwsh 侧补丁——守卫检测到引用
      // scope 外路径时强制弹卡（任何沙箱模式都弹，含 danger-full-access），由用户裁决。
      // 检测是启发式（与 checkCommandAgainstWorkspace 同族），如实标注为诚实边界。
      const scopeHits =
        ctx.writeScope && ctx.writeScope.length > 0
          ? pathHintsOutsideScope(command, ctx.workspace.root, ctx.writeScope)
          : [];
      // W1 路线 A'（docs/7 §1.3）：只读命令豁免 scope 强制弹卡——scope 管写不管读，
      // Select-String 查代码这类纯读不违反；白名单首 token + 无写形态才豁免（解释器等
      // 执行器天然不在白名单）。checkCommandAgainstWorkspace 的 reason 不豁免：工作区外
      // 引用与普通会话同一安全面，照常弹卡。
      const scopeReasons =
        scopeHits.length > 0 && !isReadOnlyPwshCommand(command)
          ? [
              `子代理引用了写入范围（scope）外的路径：${scopeHits.join("、")}——批准执行将允许它绕过文件工具的 scope 硬约束`,
            ]
          : [];
      const approvalReasons =
        check.reasons.length > 0
          ? [...scopeReasons, ...check.reasons]
          : scopeReasons.length > 0
            ? scopeReasons
            : ["（逐条确认模式已开启）"];

      const askApproval = async (reasons: string[], why?: string): Promise<ApprovalDecision> =>
        ctx.requestApproval({
          toolName: "run_pwsh",
          command,
          description,
          reasons,
          ...(why ? { justification: why } : {}),
        });

      // 逐条确认（任何模式）或 scope 越界（§5.4 强制）：先弹卡过人工——批准的是命令本身，
      // 执行按批准时刻的沙箱模式（live 重读：卡上点「解除沙箱并放行」本条即无约束执行；
      // 受约束模式=走下方受限执行，区外写入仍被 OS 拒绝走升级链路）
      if ((deps ? deps.alwaysConfirm() : ctx.alwaysConfirm === true) || scopeReasons.length > 0) {
        const decision = await askApproval(approvalReasons);
        if (decision !== "allowed-once") return refusalText(decision);
        if (modeOf() === "danger-full-access") {
          return await runPwsh(command, { cwd: ctx.workspace.root, timeoutMs, signal: ctx.signal });
        }
      }

      if (modeOf() === "danger-full-access") {
        // 完全不约束（用户明示）：未开逐条确认时不弹卡
        return await runPwsh(command, { cwd: ctx.workspace.root, timeoutMs, signal: ctx.signal });
      }

      // read-only / workspace-write：需要 OS 级沙箱后端（fail-closed，绝不静默放行）
      const runner = getSandboxRunner();
      if (!runner.available()) {
        return (
          `SANDBOX_UNAVAILABLE：当前平台没有可用的沙箱后端，无法保证 ${MODE_LABEL[modeOf()]} 约束。已拒绝执行。\n` +
          "可选：请用户把沙箱模式切换到 danger-full-access（无约束，守卫+审批照常工作），或在设置中启用沙箱后端。"
        );
      }

      // 升级重试：刚有命令被沙箱拒绝（有额度）+ 本次带 justification → 走人工审批，批准后以无约束方式执行一次
      if (escalationCredits > 0 && justification) {
        escalationCredits--;
        const decision = await askApproval(
          ["上一条命令刚被沙箱拒绝，模型为本次命令申请提权", ...check.reasons],
          justification,
        );
        if (decision !== "allowed-once") return refusalText(decision);
        return await runPwsh(command, { cwd: ctx.workspace.root, timeoutMs, signal: ctx.signal });
      }

      const out = await runSandboxed(
        command,
        { mode: modeOf(), workspaceRoot: ctx.workspace.root, ...(ctx.privateTempDir ? { privateTempDir: ctx.privateTempDir } : {}) },
        { timeoutMs, signal: ctx.signal },
      );
      // justification 带了但入口时额度为 0（额度由真实拒绝攒出）——此前静默忽略，模型与
      // 用户都不知道提权没发生（真机实录：删除命令连试多次全败却无一卡）。给一句明示：
      // 刚被拒（本拒绝攒出 1 点）→ 指引立即带 justification 重试即可弹卡；未被拒 → 说明无需提权。
      if (justification) {
        const hint = escalationCredits > 0
          ? "（本次 justification 未生效：申请时升级额度为 0；该命令刚被沙箱拒绝、现已攒出 1 点额度——下一次调用带 justification 重试即可转人工审批。）"
          : "（本次 justification 未生效：升级额度为 0，且本命令并未被沙箱拒绝——无需提权，请直接使用以上结果。）";
        return out + "\n" + hint;
      }
      return out;
    },
  };
}
