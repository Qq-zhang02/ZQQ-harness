/**
 * 沙箱类型与策略（功能三，Phase A 骨架）。
 * 诚实边界：启发式守卫是护栏不是隔离；Phase B（koffi 受限令牌）落地前，
 * 受约束模式在没有可用后端时一律 fail-closed 拒绝执行，绝不静默放行。
 */

/** 沙箱模式（三档，随会话存档）。默认 workspace-write（工作区 + 私有临时目录可写）。 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

/** 归一化沙箱模式：合法值原样返回，缺省/野值回默认档 workspace-write。 */
export function normalizeSandboxMode(raw: unknown): SandboxMode {
  return raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access"
    ? raw
    : "workspace-write";
}

export interface SandboxPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
  /** workspace-write 时的私有临时目录（~/.ZQQ-harness/tmp/<sessionId>/），环境变量 TMP/TEMP 重定向目标 */
  privateTempDir?: string;
}

/** 沙箱执行器的采集结果（与 pwsh.ts 的无约束采集字段对齐）。 */
export interface SandboxRunResult {
  code: number;
  timedOut: boolean;
  interrupted: boolean;
  overLimit: boolean;
  stdout: string;
  stderr: string;
}

/** fail-closed 专用错误：约束被选中但后端不可用时抛出，绝不静默降级为无约束执行。 */
export class SandboxUnavailableError extends Error {
  constructor(mode: SandboxMode) {
    super(`SANDBOX_UNAVAILABLE：无法保证 ${mode} 约束（当前没有可用的沙箱后端）`);
    this.name = "SandboxUnavailableError";
  }
}
