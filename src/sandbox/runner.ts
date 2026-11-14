/**
 * 沙箱执行器接缝（capability seam）：把"受限执行"抽象为可整体替换/降级的服务，
 * 不进 agent 循环主干。
 *
 * Phase A：noBackend.available() 恒为 false，pwsh 工具对 read-only / workspace-write
 * 按 fail-closed 语义拒绝执行（SANDBOX_UNAVAILABLE）。
 * Phase B：Windows 后端（koffi 受限令牌 + Job Object）通过 setSandboxRunner 注入。
 */
import type { SandboxPolicy, SandboxRunResult } from "./types.ts";

export interface SandboxRunner {
  readonly name: string;
  /** 后端是否可用（可用 = 能保证 policy 的约束后才返回 true）。 */
  available(): boolean;
  /** 以给定策略约束执行命令（采集 stdout/stderr）。仅在 available() 为 true 后调用。 */
  run(command: string, policy: SandboxPolicy, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SandboxRunResult>;
}

/** Phase A 占位后端：永远不可用（诚实边界：Node 原生 API 造不出受限令牌）。 */
export const noBackend: SandboxRunner = {
  name: "none",
  available: () => false,
  run: async () => {
    throw new Error("SANDBOX_UNAVAILABLE：当前没有可用的沙箱后端");
  },
};

let current: SandboxRunner = noBackend;

export function getSandboxRunner(): SandboxRunner {
  return current;
}

/** 注入沙箱后端（启动时按平台探测；Windows 上注入 koffi 受限令牌后端）。 */
export function setSandboxRunner(r: SandboxRunner): void {
  current = r;
}
