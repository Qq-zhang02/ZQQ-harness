/**
 * sandbox.windows-acl 模块（模块化架构重构 §4.9）：Windows ACL 受限令牌后端的
 * 注册入口。实现自 src/sandbox/windows-acl.ts 迁入（windows-acl.ts：koffi FFI +
 * 受限令牌 + Job Object，koffi 加载失败归 available()=false 不再炸进程）。
 * 接缝（SandboxRunner 接口 + get/set + fail-closed 缺省）留在 src/sandbox/runner.ts
 * ——它是 pwsh 工具（modules/tools/pwsh）与 bootstrap 的进程级共享点，若迁入模块
 * 会造成模块间 import，违反依赖方向铁律。
 * 启动选型在 server bootstrap：ctx.sandboxBackends.all().find((b) => b.available())。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SandboxBackendDef } from "../../../core/types.ts";
import { WindowsAclRunner, nativeAvailable } from "./windows-acl.ts";

export const windowsAclBackend: SandboxBackendDef = {
  id: "windows-acl",
  available: () => nativeAvailable(),
  create: () => new WindowsAclRunner(),
};

export const sandboxWindowsAcl: HarnessModule = {
  name: "sandbox.windows-acl",
  setup(ctx) {
    ctx.sandboxBackends.register(windowsAclBackend);
  },
};
