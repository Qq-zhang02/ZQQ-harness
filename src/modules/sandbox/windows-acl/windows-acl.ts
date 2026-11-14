/**
 * Windows ACL 受限令牌沙箱后端（模块化架构重构 §4.9/§10，自 src/sandbox/windows-acl.ts 迁入；
 * Phase B，参考 DSH sandbox-windows-acl 设计）。
 *
 * 机制（koffi FFI，无构建步骤）：
 * 1. 令牌：CreateRestrictedToken(WRITE_RESTRICTED)——Windows 对"写类"访问做两次检查
 *    （正常 SID + 受限 SID），读类访问只走正常检查（所以读工作区外文件不受限）。
 * 2. 受限列表：workspace-write = [logon SID, Everyone, 工作区能力 SID, 临时目录能力 SID]；
 *    read-only = [logon SID, Everyone]。logon+Everyone 是保命组：缺了它们早期 DLL
 *    初始化即死（0xC0000142）。
 * 3. 令牌降为 Low 完整性；被放行目录打 Low 标签（NO_WRITE_UP）——内核完整性检查
 *    拦掉 DACL 之外的写（如 Public 目录这类 Everyone 可写处）。
 * 4. ACL 放行：对工作区根 / 私有临时目录授予能力 SID 写+删（deny-then-grant：
 *    附 FILE_DELETE_CHILD 对 Everyone 的拒绝，仅容器继承）。
 * 5. 执行：CreateProcessAsUserW（挂起）→ KILL_ON_JOB_CLOSE Job Object → Resume——
 *    超时杀整棵进程树，解决"超时只杀 pwsh、孙进程残留"。
 *
 * 已知边界（诚实清单，与 DSH 一致）：
 * - 只约束写/删，不约束读与网络；
 * - NTFS 硬链接可别名同一文件；NUL 设备因设备 DACL 仍可写；
 * - 受限子进程必须共享宿主控制台：CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 会让
 *   子进程死于 0xC0000142（std 重定向到管道/文件不受影响）；
 * - Authenticated Users / INTERACTIVE 不进受限列表（会开出 C:\ 公共目录与 WMI 的口子）；
 * - 目录 ACL 编辑是常驻变更（工作区每路径一次，幂等跳过由调用方缓存承担）；
 * - 未经安全审计，只防误操作，不得作为对抗恶意代码的边界。
 */
import { mkdirSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import koffi from "koffi";
import type { SandboxPolicy, SandboxRunResult } from "../../../sandbox/types.ts";
import type { SandboxRunner } from "../../../sandbox/runner.ts";

// koffi 原生函数表懒加载：DLL 缺失/加载失败不再炸进程，由 available() 探测归 false（§4.9）
type NativeTable = ReturnType<typeof buildNativeTable>;
let nativeTable: NativeTable | null | undefined;
function buildNativeTable() {
  const k32 = koffi.load("kernel32.dll");
  const a32 = koffi.load("advapi32.dll");
  return {
    GetCurrentProcess: k32.func("void *GetCurrentProcess()"),
    OpenProcessToken: a32.func("bool OpenProcessToken(void *, uint32, _Out_ void *)"),
    CreateRestrictedToken: a32.func("bool CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void *)"),
    GetTokenInformation: a32.func("bool GetTokenInformation(void *, uint32, void *, uint32, _Out_ void *)"),
    SetTokenInformation: a32.func("bool SetTokenInformation(void *, uint32, void *, uint32)"),
    CreateProcessAsUserW: a32.func("bool CreateProcessAsUserW(void *, str16, str16, void *, void *, bool, uint32, void *, str16, void *, _Out_ void *)"),
    CreateJobObjectW: k32.func("void *CreateJobObjectW(void *, str16)"),
    SetInformationJobObject: k32.func("bool SetInformationJobObject(void *, int32, void *, uint32)"),
    AssignProcessToJobObject: k32.func("bool AssignProcessToJobObject(void *, void *)"),
    ResumeThread: k32.func("uint32 ResumeThread(void *)"),
    TerminateProcess: k32.func("bool TerminateProcess(void *, uint32)"),
    WaitForSingleObject: k32.func("uint32 WaitForSingleObject(void *, uint32)"),
    GetExitCodeProcess: k32.func("bool GetExitCodeProcess(void *, _Out_ void *)"),
    CloseHandle: k32.func("bool CloseHandle(void *)"),
    CreateFileW: k32.func("void *CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)"),
    GetNamedSecurityInfoW: a32.func("uint32 GetNamedSecurityInfoW(str16, uint32, uint32, void *, void *, _Out_ void *, void *, _Out_ void *)"),
    SetNamedSecurityInfoW: a32.func("uint32 SetNamedSecurityInfoW(str16, uint32, uint32, void *, void *, void *, void *)"),
    GetAclInformation: a32.func("bool GetAclInformation(void *, void *, uint32, uint32)"),
    GetAce: a32.func("bool GetAce(void *, uint32, _Out_ void *)"),
    InitializeAcl: a32.func("bool InitializeAcl(void *, uint32, uint32)"),
    AddAce: a32.func("bool AddAce(void *, uint32, uint32, void *, uint32)"),
    AddAccessAllowedAceEx: a32.func("bool AddAccessAllowedAceEx(void *, uint32, uint8, uint32, void *)"),
    AddAccessDeniedAceEx: a32.func("bool AddAccessDeniedAceEx(void *, uint32, uint8, uint32, void *)"),
    AddMandatoryAce: a32.func("bool AddMandatoryAce(void *, uint32, uint32, uint32, void *)"),
    GetLengthSid: a32.func("uint32 GetLengthSid(void *)"),
    CopySid: a32.func("bool CopySid(uint32, void *, void *)"),
    GetLastError: k32.func("uint32 GetLastError()"),
    LocalFree: k32.func("void *LocalFree(void *)"),
  };
}
function F(): NativeTable {
  if (nativeTable === undefined) {
    try {
      nativeTable = buildNativeTable();
    } catch {
      nativeTable = null;
    }
  }
  if (nativeTable === null) throw new Error("koffi 原生函数表不可用（kernel32/advapi32 加载失败）");
  return nativeTable;
}

const native = (n: number) => koffi.alloc("uint8", n);
const writeBytes = (addr: bigint, bytes: number[]) => bytes.forEach((b, i) => koffi.encode(addr, i, "uint8", b));

function makeSid(subauths: number[], auth: number): bigint {
  const a = native(8 + subauths.length * 4);
  const bytes = [1, subauths.length];
  for (let i = 0; i < 6; i++) bytes.push(Number((BigInt(auth) >> BigInt(8 * (5 - i))) & 0xffn));
  subauths.forEach((s) => bytes.push(s & 0xff, (s >>> 8) & 0xff, (s >>> 16) & 0xff, (s >>> 24) & 0xff));
  writeBytes(a, bytes);
  return a;
}
function sidAndAttrs(entries: [bigint, number][]): bigint {
  const a = native(entries.length * 16);
  entries.forEach(([sid, attrs], i) => {
    koffi.encode(a, i * 16, "uint64", sid);
    koffi.encode(a, i * 16 + 8, "uint32", attrs);
  });
  return a;
}

const TOKEN_REQUEST = 0x1 | 0x2 | 0x8 | 0x80; // ASSIGN_PRIMARY | DUPLICATE | QUERY | ADJUST_DEFAULT
const WRITE_RESTRICTED = 13; // DSH rc.1 实测值（DISABLE_MAX_PRIVILEGE|WRITE_RESTRICTED|0x8）
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const STARTF_USESTDHANDLES = 0x100;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const TOKEN_INTEGRITY_LEVEL = 25;
const LABEL_NO_WRITE_UP = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const LABEL_SECURITY_INFORMATION = 0x10;
const SE_FILE_OBJECT = 1;
const ACL_REVISION = 2;
const ACE_FLAG_OBJECT_INHERIT = 0x1;
const ACE_FLAG_CONTAINER_INHERIT = 0x2;
const FILE_DELETE_CHILD = 0x40;
// FILE_GENERIC_WRITE + DELETE（能力 ACE 的 DELETE 是被放行目录内唯一的删除授权来源）
const WRITE_MASK = 0x120116 | 0x10000;
const ACL_APPEND = 0xffffffff; // AddAce 的 MAXDWORD：追加到末尾

const EVERYONE = makeSid([0], 1); // S-1-1-0
const LOW_LABEL = makeSid([4096], 16); // S-1-16-4096

/**
 * 从 TokenGroups 里找 logon SID（属性含 SE_GROUP_LOGON_ID 0xC0000000 的 S-1-5-5-x-y）
 * 并按 DSH 方式 CopySid 拷贝。不能用 TokenStatistics.AuthenticationId 推导——
 * 实测推导值与真实 logon SID 不一致，错误值会让 pwsh 初始化即死（0xC0000142）。
 */
function logonSidOf(hToken: bigint): bigint {
  const need = Buffer.alloc(4);
  F().GetTokenInformation(hToken, 2, null, 0, need); // 首查必然 FALSE，need 写入所需大小
  if (need.readUInt32LE(0) === 0) throw new Error("GetTokenInformation(TokenGroups) 尺寸为 0");
  const buf = Buffer.alloc(need.readUInt32LE(0));
  if (!F().GetTokenInformation(hToken, 2, buf, buf.length, need)) throw new Error("GetTokenInformation(TokenGroups) 失败");
  const count = buf.readUInt32LE(0);
  for (let i = 0; i < count; i++) {
    const sidPtr = buf.readBigUInt64LE(8 + i * 16);
    const attrs = buf.readUInt32LE(8 + i * 16 + 8);
    if (((attrs & 0xc0000000) >>> 0) === 0xc0000000) { // >>>0：JS 位运算是 32 位有符号，0xc0000007 & 0xc0000000 会变负数
      const len = F().GetLengthSid(sidPtr);
      const copy = native(len);
      if (!F().CopySid(len, copy, sidPtr)) throw new Error("CopySid(logon SID) 失败");
      return copy;
    }
  }
  throw new Error("令牌组里找不到 logon SID");
}

/** 后端选型探测（§4.9）：平台支持且 koffi 函数表可加载（加载失败归 false，不炸进程）。 */
export function nativeAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    F();
    return true;
  } catch {
    return false;
  }
}

/** 由路径派生确定性能力 SID（S-1-4-<h1>-<h2>；同一路径同 SID，授权跨重启可复用）。 */
export function capabilitySidFor(path: string): bigint {
  const h = createHash("sha256").update(path.toLowerCase()).digest();
  return makeSid([h.readUInt32LE(0) | 1, h.readUInt32LE(4)], 4);
}

/**
 * deny-then-grant：对 dir 追加 [拒绝 Everyone 的 FILE_DELETE_CHILD（仅容器继承）]
 * + [允许能力 SID 写+删（对象/容器继承）] + [Low 完整性标签 NO_WRITE_UP]。
 * 原有 ACE 原样保留（复制后追加，保住用户自身权限与继承语义）。
 * 任一 Win32 失败即抛错（fail-closed，绝不带着没做好的授权放行）。
 */
function grantWrite(dir: string, capSid: bigint): void {
  const daclOut = Buffer.alloc(8);
  const sdOut = Buffer.alloc(8);
  const ownerOut = Buffer.alloc(8);
  const groupOut = Buffer.alloc(8);
  const rc = F().GetNamedSecurityInfoW(dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, ownerOut, groupOut, daclOut, null, sdOut);
  if (rc !== 0) throw new Error(`GetNamedSecurityInfoW(${dir}) 失败：code=${rc}`);
  try {
    const oldAcl = daclOut.readBigUInt64LE(0);
    const info = Buffer.alloc(12); // ACL_SIZE_INFORMATION
    if (oldAcl && !F().GetAclInformation(oldAcl, info, 12, 2)) throw new Error(`GetAclInformation(${dir}) 失败`);
    const aceCount = oldAcl ? info.readUInt32LE(0) : 0;
    const oldBytes = oldAcl ? info.readUInt32LE(4) : 0;

    // 幂等跳过：现有 DACL 已有该能力 SID 的写 ACE（重启后再授权）→ 不重复追加
    for (let i = 0; i < aceCount; i++) {
      const acePtrBuf = Buffer.alloc(8);
      if (!F().GetAce(oldAcl, i, acePtrBuf)) throw new Error(`GetAce(${dir}, ${i}) 失败`);
      const ace = acePtrBuf.readBigUInt64LE(0);
      const aceType = Number(koffi.decode(ace, 0, "uint8"));
      if (aceType !== 0) continue; // ACCESS_ALLOWED_ACE
      const aceMask = Number(koffi.decode(ace, 4, "uint32"));
      if ((aceMask & WRITE_MASK) !== WRITE_MASK) continue;
      const aceFlags = Number(koffi.decode(ace, 1, "uint8"));
      if ((aceFlags & (ACE_FLAG_OBJECT_INHERIT | ACE_FLAG_CONTAINER_INHERIT)) !== (ACE_FLAG_OBJECT_INHERIT | ACE_FLAG_CONTAINER_INHERIT)) continue;
      const sidLen = F().GetLengthSid(ace + 8n);
      const capLen = F().GetLengthSid(capSid);
      if (sidLen !== capLen) continue;
      let same = true;
      for (let b = 0; b < sidLen; b++) {
        if (Number(koffi.decode(ace + 8n, b, "uint8")) !== Number(koffi.decode(capSid, b, "uint8"))) {
          same = false;
          break;
        }
      }
      if (same) return; // 精确命中，无需再写
    }

    const newAcl = native(oldBytes + 128);
    if (!F().InitializeAcl(newAcl, oldBytes + 128, ACL_REVISION)) throw new Error("InitializeAcl 失败");
    if (!F().AddAccessDeniedAceEx(newAcl, ACL_REVISION, ACE_FLAG_CONTAINER_INHERIT, FILE_DELETE_CHILD, EVERYONE)) {
      throw new Error(`AddAccessDeniedAceEx(${dir}) 失败`);
    }
    if (!F().AddAccessAllowedAceEx(newAcl, ACL_REVISION, ACE_FLAG_OBJECT_INHERIT | ACE_FLAG_CONTAINER_INHERIT, WRITE_MASK, capSid)) {
      throw new Error(`AddAccessAllowedAceEx(${dir}) 失败`);
    }
    for (let i = 0; i < aceCount; i++) {
      const acePtrBuf = Buffer.alloc(8);
      if (!F().GetAce(oldAcl, i, acePtrBuf)) throw new Error(`GetAce(${dir}, ${i}) 失败`);
      const ace = acePtrBuf.readBigUInt64LE(0);
      const aceSize = Number(koffi.decode(ace, 2, "uint16"));
      const src = native(aceSize);
      for (let b = 0; b < aceSize; b++) koffi.encode(src, b, "uint8", Number(koffi.decode(ace, b, "uint8")));
      if (!F().AddAce(newAcl, ACL_REVISION, ACL_APPEND, src, aceSize)) throw new Error(`AddAce(${dir}, ${i}) 失败`);
    }

    // DACL 与标签分两次应用：实测部分目录（如跨盘工作区）合并写入会返回 ACCESS_DENIED，
    // 导致 DACL 已生效却整体报错。标签只是纵深防御（核心约束是 WRITE_RESTRICTED
    // 双重检查），DSH rc.1 也未实现标签，因此标签失败降级为告警。
    const daclRc = F().SetNamedSecurityInfoW(dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, newAcl, null);
    if (daclRc !== 0) throw new Error(`SetNamedSecurityInfoW(DACL, ${dir}) 失败：code=${daclRc}`);
    try {
      const sacl = native(64);
      if (!F().InitializeAcl(sacl, 64, ACL_REVISION)) throw new Error("InitializeAcl(sacl) 失败");
      if (!F().AddMandatoryAce(sacl, ACL_REVISION, 0, LABEL_NO_WRITE_UP, LOW_LABEL)) throw new Error("AddMandatoryAce 失败");
      const labelRc = F().SetNamedSecurityInfoW(dir, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null, null, null, sacl);
      if (labelRc !== 0) console.warn(`[sandbox] Low 标签写入失败（code=${labelRc}），跳过（约束仍由受限令牌双重检查保证）：${dir}`);
    } catch (e) {
      console.warn(`[sandbox] Low 标签写入失败，跳过：${dir}（${e instanceof Error ? e.message : String(e)}）`);
    }
  } finally {
    const sd = sdOut.readBigUInt64LE(0);
    if (sd) F().LocalFree(sd);
  }
}

function makeLowIntegrityRestrictedToken(restrictSids: bigint[]): bigint {
  const hProc = F().GetCurrentProcess();
  const tokOut = Buffer.alloc(8);
  if (!F().OpenProcessToken(hProc, TOKEN_REQUEST, tokOut)) throw new Error("OpenProcessToken 失败");
  const hToken = tokOut.readBigUInt64LE(0);
  const restrict = sidAndAttrs(restrictSids.map((s) => [s, 0]));
  const newTokOut = Buffer.alloc(8);
  if (!F().CreateRestrictedToken(hToken, WRITE_RESTRICTED, 0, null, 0, null, restrictSids.length, restrict, newTokOut)) {
    throw new Error("CreateRestrictedToken 失败");
  }
  const hRestricted = newTokOut.readBigUInt64LE(0);
  return hRestricted;
}

export class WindowsAclRunner implements SandboxRunner {
  readonly name = "windows-acl";

  private pwshPath: string | null | undefined;
  private logonSid: bigint | null = null;
  private tokenCache = new Map<string, bigint>(); // mode|wsSid|tempSid → 句柄
  private granted = new Map<string, boolean>(); // dir|capSid → 已放行
  private seq = 0;

  available(): boolean {
    return process.platform === "win32" && !!this.findPwsh();
  }

  private findPwsh(): string | null {
    if (this.pwshPath !== undefined) return this.pwshPath;
    try {
      const r = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true });
      this.pwshPath = r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
    } catch {
      this.pwshPath = null;
    }
    return this.pwshPath;
  }

  private restrictedToken(mode: "read-only" | "workspace-write", wsSid: bigint | null, tempSid: bigint | null): bigint {
    const key = `${mode}|${wsSid}|${tempSid}`;
    const hit = this.tokenCache.get(key);
    if (hit) return hit;
    if (!this.logonSid) {
      const hProc = F().GetCurrentProcess();
      const tokOut = Buffer.alloc(8);
      if (!F().OpenProcessToken(hProc, TOKEN_REQUEST, tokOut)) throw new Error("OpenProcessToken 失败");
      this.logonSid = logonSidOf(tokOut.readBigUInt64LE(0));
    }
    const list = [this.logonSid, EVERYONE, ...(wsSid ? [wsSid] : []), ...(tempSid ? [tempSid] : [])];
    const h = makeLowIntegrityRestrictedToken(list);
    if (this.tokenCache.size >= 16) this.tokenCache.clear();
    this.tokenCache.set(key, h);
    return h;
  }

  private ensureGrant(dir: string, capSid: bigint): void {
    const key = `${dir.toLowerCase()}|${capSid}`;
    if (this.granted.has(key)) return;
    mkdirSync(dir, { recursive: true });
    grantWrite(dir, capSid);
    this.granted.set(key, true);
  }

  /** 受限执行：输出重定向到临时目录下的文件。任何 Win32 失败抛错（fail-closed）。 */
  async run(command: string, policy: SandboxPolicy, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SandboxRunResult> {
    if (policy.mode !== "read-only" && policy.mode !== "workspace-write") {
      throw new Error("SANDBOX_UNAVAILABLE：danger-full-access 不经过沙箱执行器");
    }
    const pwsh = this.findPwsh();
    if (!pwsh) throw new Error("SANDBOX_UNAVAILABLE：找不到 pwsh（PowerShell 7）");
    if (!policy.privateTempDir) throw new Error("SANDBOX_UNAVAILABLE：私有临时目录未指定");
    mkdirSync(policy.privateTempDir, { recursive: true });

    // 授权与受限列表按模式（workspace-write 才有放行；read-only 双 SID 保命组）
    const wsSid = capabilitySidFor(`ws:${policy.workspaceRoot}`);
    const tempSid = capabilitySidFor(`tmp:${policy.privateTempDir}`);
    if (policy.mode === "workspace-write") {
      this.ensureGrant(policy.workspaceRoot, wsSid);
      this.ensureGrant(policy.privateTempDir, tempSid);
    }
    const hTok = this.restrictedToken(policy.mode, policy.mode === "workspace-write" ? wsSid : null, policy.mode === "workspace-write" ? tempSid : null);

    // 输出采集文件：放在被放行的临时目录里（服务端打开 + 句柄继承，子进程直接写）
    const stamp = `${Date.now()}-${++this.seq}`;
    const outPath = join(policy.privateTempDir, `out-${stamp}.txt`);
    const errPath = join(policy.privateTempDir, `err-${stamp}.txt`);
    const sa = native(24);
    koffi.encode(sa, 0, "uint32", 24);
    koffi.encode(sa, 8, "uint64", 0);
    koffi.encode(sa, 16, "uint32", 1); // bInheritHandle
    const GENERIC_WRITE = 0x40000000, OPEN_ALWAYS = 4, FILE_ATTRIBUTE_NORMAL = 0x80, FILE_SHARE_RWX = 7;
    const INVALID_HANDLE = 0xffffffffffffffffn; // CreateFileW 失败返回 INVALID_HANDLE_VALUE
    const hOut = F().CreateFileW(outPath, GENERIC_WRITE, FILE_SHARE_RWX, sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
    const hErr = F().CreateFileW(errPath, GENERIC_WRITE, FILE_SHARE_RWX, sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
    if (hOut === INVALID_HANDLE || hErr === INVALID_HANDLE) throw new Error("CreateFileW(输出采集) 失败");

    let hProcess = 0n, hThread = 0n, hJob = 0n;
    // env 传 NULL（继承父进程），TMP/TEMP 通过改父进程环境变量实现重定向——
    // CreateProcessAsUserW 是同步 FFI 调用，JS 单线程下"改→spawn→还原"窗口内无并发。
    const prevTmp = process.env.TMP;
    const prevTemp = process.env.TEMP;
    process.env.TMP = policy.privateTempDir;
    process.env.TEMP = policy.privateTempDir;
    try {
      // STARTUPINFOW x64 布局（104 字节，含 dwXSize/dwYSize）：cb@0, dwFlags@60,
      // hStdInput@80, hStdOutput@88, hStdError@96（布局错误曾是 pwsh 启动即死的元凶）
      const si = native(104);
      koffi.encode(si, 0, "uint32", 104);
      koffi.encode(si, 60, "uint32", STARTF_USESTDHANDLES);
      koffi.encode(si, 80, "uint64", hOut);
      koffi.encode(si, 88, "uint64", hOut);
      koffi.encode(si, 96, "uint64", hErr);
      const pi = native(24);

      // EncodedCommand（UTF-16LE base64）：命令内容不经过命令行解析，无引号转义问题
      const encoded = Buffer.from("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command, "utf16le").toString("base64");
      const cmdLine = `"${pwsh}" -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
      const ok = F().CreateProcessAsUserW(
        hTok,
        pwsh,
        cmdLine,
        null,
        null,
        true,
        CREATE_SUSPENDED,
        null,
        policy.workspaceRoot,
        si,
        pi,
      );
      process.env.TMP = prevTmp;
      process.env.TEMP = prevTemp;
      if (!ok) throw new Error(`CreateProcessAsUserW 失败：code=${F().GetLastError()}`);
      hProcess = koffi.decode(pi, 0, "uint64");
      hThread = koffi.decode(pi, 8, "uint64");

      // Job Object：句柄一关整棵进程树被杀（超时杀树，孙进程不残留）
      hJob = F().CreateJobObjectW(null, null);
      const jobInfo = native(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
      koffi.encode(jobInfo, 16, "uint32", JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE); // Basic.LimitFlags @16
      if (!F().SetInformationJobObject(hJob, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, jobInfo, 144)) throw new Error("SetInformationJobObject 失败");
      if (!F().AssignProcessToJobObject(hJob, hProcess)) throw new Error("AssignProcessToJobObject 失败");
      F().ResumeThread(hThread);

      // 异步轮询等待：WaitForSingleObject 以 0 超时做非阻塞探测，探测之间 await 让出
      // 事件循环；abort/超时 → TerminateProcess。此处曾是"async 函数里的纯同步 for(;;)"：
      // WaitForSingleObject(200) 是同步 FFI 调用，长命令（如 Start-Sleep 20s）运行期间
      // 整个服务进程的事件循环被堵死——同进程的子代理/会话 HTTP·SSE 全部无响应，
      // abort 信号也无法投递（UI 暂停点了没反应）；短命令只各堵几百毫秒，不易察觉。
      const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      let timedOut = false;
      const start = Date.now();
      for (;;) {
        if (opts.signal?.aborted) F().TerminateProcess(hProcess, 1);
        if (F().WaitForSingleObject(hProcess, 0) === 0) break;
        if (Date.now() - start >= opts.timeoutMs) {
          timedOut = true;
          F().TerminateProcess(hProcess, 1);
          // 死等终结核同样不能同步堵 5s：有界异步轮询（超界放弃，finally 关 job 句柄
          // 仍会 KILL_ON_JOB_CLOSE 杀树兜底）
          const killStart = Date.now();
          while (F().WaitForSingleObject(hProcess, 0) !== 0 && Date.now() - killStart < 5_000) {
            await pause(50);
          }
          break;
        }
        await pause(200);
      }

      const codeOut = native(4);
      F().GetExitCodeProcess(hProcess, codeOut);
      const code = koffi.decode(codeOut, 0, "uint32");
      return {
        code,
        timedOut,
        interrupted: opts.signal?.aborted === true,
        overLimit: false,
        stdout: readFileSync(outPath, "utf8"),
        stderr: readFileSync(errPath, "utf8"),
      };
    } finally {
      if (hThread) F().CloseHandle(hThread);
      if (hProcess) F().CloseHandle(hProcess);
      if (hJob) F().CloseHandle(hJob);
      // 采集文件句柄归本函数所有（子进程另带继承副本，不受影响）：服务端副本不关会
      // 泄漏句柄，且一直占着 out/err 文件——rmSync(force 静默吞错) 实际删不掉，沙箱
      // 临时目录会持续膨胀。先关句柄再删文件。
      if (hOut !== INVALID_HANDLE) F().CloseHandle(hOut);
      if (hErr !== INVALID_HANDLE) F().CloseHandle(hErr);
      rmSync(outPath, { force: true });
      rmSync(errPath, { force: true });
    }
    // 注意：TMP/TEMP 的还原在 spawn 调用后立即同步执行（上方）；此 finally 只负责句柄与文件
  }
}

/** 启动时清理残留的沙箱临时目录（>24h；服务启动时无任务在跑）。 */
export function sweepStaleSandboxTmp(tmpRoot: string, maxAgeMs = 24 * 3600_000): void {
  let names: string[] = [];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return; // 目录不存在
  }
  for (const name of names) {
    const p = join(tmpRoot, name);
    try {
      const mtime = statSync(p)?.mtimeMs ?? 0;
      if (Date.now() - mtime > maxAgeMs) rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
