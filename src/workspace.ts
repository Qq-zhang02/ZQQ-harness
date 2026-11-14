import { isAbsolute, normalize, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";

export interface Workspace {
  /** 工作区根目录（绝对路径）。agent 的文件操作默认只应发生在这里。 */
  root: string;
}

export function createWorkspace(root: string): Workspace {
  return { root: resolve(root) };
}

const AGENTS_MD_MAX = 16_000;

/** 读取工作区的 AGENTS.md 作为附加系统指令；不存在返回 null，过长截断。 */
export function readAgentsMd(root: string): string | null {
  try {
    const text = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    if (!text.trim()) return null;
    return text.length > AGENTS_MD_MAX
      ? text.slice(0, AGENTS_MD_MAX) + "\n…（AGENTS.md 过长已截断）"
      : text;
  } catch {
    return null;
  }
}

/** candidate 可为绝对或相对（相对 root）路径；判断其是否落在工作区内。 */
export function isInsideWorkspace(root: string, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(root, candidate);
  const rel = relative(resolve(root), abs);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export interface CommandCheck {
  needsApproval: boolean;
  reasons: string[];
}

// 注册表路径（HKLM: 等）与 Registry:: 前缀
const REGISTRY_PATH_RE = /(?:\b(?:HKLM|HKCU|HKCR|HKU|HKCC):|^Registry::)/i;
// 指向用户/系统目录的变量（PowerShell $env:X / $X，以及 cmd 风格 %X%）
const PS_ENV_DIR_RE = /\$(?:env:)?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:X86)?|PROGRAMDATA|SYSTEMROOT|WINDIR|ALLUSERSPROFILE|TEMP|TMP)\b/i;
const CMD_ENV_DIR_RE = /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:X86)?|PROGRAMDATA|SYSTEMROOT|WINDIR|ALLUSERSPROFILE|TEMP|TMP)%/i;
// 系统级修改操作
const SYSTEM_COMMAND_RE = /\b(?:Set-ExecutionPolicy|Register-ScheduledTask|New-ScheduledTask|schtasks|New-Service|Set-Service|Start-Service|Stop-Service|Restart-Service|winget|choco|scoop|net\s+(?:user|localgroup|start|stop))\b/i;
// 全局安装（写入工作区外的包目录）
const GLOBAL_INSTALL_RE = /\b(?:npm|pnpm|yarn)\b[^|;&]*?\b(?:install|i|add)\b[^|;&]*?(?:\s-[a-zA-Z]*g\b|\s--global\b|\s--location=global\b)/i;
const PIP_INSTALL_RE = /(?:\bpip3?\s+install\b|\bpython\s+-m\s+pip\s+install\b)/i;
// .. 逃逸：token 以 .. 开头，或路径中含 \..\
const PARENT_TOKEN_RE = /(?:^|[\s"'=,(])\.\.(?:[\\/][^\s"'|<>&,;]*)?/;
const INNER_TRAVERSAL_RE = /[\\/]\.\.(?:[\\/]|$)/;

// ---- W1（docs/7 §1.3）：scope 守卫 token 提取精度（路线 A）+ 只读命令豁免（路线 A'）----

/** Windows 文件名非法字符集：路径段字面量不可能含这些（盘符前缀的 ":" 单独豁免）。
 *  正则 Pattern（|、(、[…）与源码文本天然命中——这正是「非路径文本」的硬判据。 */
const PATH_SEGMENT_ILLEGAL_RE = /[<>:"|?*()[\]{}]/;

/** 疑似路径文本的硬规则（路线 A）：单行、≤260 字符（NTFS 路径上限即依据）、含路径
 *  分隔符、且剥去盘符/UNC 前缀后每段都不含 Windows 文件名非法字符。多行 here-string
 *  源码、正则元字符段一律不像路径 → 不进 scope 命中集。只收紧守卫的输入 token 集，
 *  放行/弹卡逻辑不动（fail-closed 方向不变：像路径的照旧参与判定）。 */
function looksLikePathText(s: string): boolean {
  if (s.length > 260 || /[\r\n]/.test(s)) return false;
  if (!/[\\/]/.test(s)) return false;
  let t = s;
  const drive = /^[A-Za-z]:[\\/]/.exec(t);
  if (drive) t = t.slice(drive[0].length);
  else if (t.startsWith("\\\\")) t = t.slice(2); // UNC 前缀
  const segs = t.split(/[\\/]+/).filter((x) => x.length > 0);
  if (segs.length === 0) return false;
  return segs.every((seg) => !PATH_SEGMENT_ILLEGAL_RE.test(seg));
}

/** 只读 cmdlet 白名单（路线 A'）：管道段首 token 命中即该段视为只读。Get- 与 Format-
 *  两族按前缀放行（approved verbs：Get=读取）；Out 族只列不写文件的三个；别名（gci、
 *  select 等）不豁免——无法与写类别名（ri、sp…）可靠区分，宁缺毋滥。 */
const READONLY_FIRST_TOKEN_RE =
  /^(?:Get-[A-Za-z]+|Format-[A-Za-z]+|Select-String|Select-Object|Where-Object|Sort-Object|Group-Object|Measure-Object|Measure-Command|Compare-Object|Test-Path|Out-Default|Out-String|Out-Host)$/;

/** 写形态：写类 cmdlet / 任意代码执行入口（可写，只读性无法静态判定）/ .NET 写删 API。
 *  在引号剥除后的命令里出现任一 → 整条命令不豁免（脚本块内的调用也在扫描面内）。
 *  执行器词带路径上下文守卫（前后紧邻 [\\/.] 或词字符/连字符的不算——x.py 的 py、
 *  modules/pwsh/ 的 pwsh 是路径成分，不是执行入口；过短的 py/go 不收录，宁缺毋滥）。 */
const WRITE_FORM_RE =
  /\b(?:Out-File|Out-Printer|Set-Content|Add-Content|Clear-Content|Clear-Item|Tee-Object|Export-[A-Za-z]+|New-Item|New-PSDrive|Copy-Item|Move-Item|Remove-Item|Rename-[A-Za-z]+|Set-Item|Set-ItemProperty|Invoke-Expression|Invoke-Command|Start-Process|Start-Job)\b|(?<![\\/.\w-])(?:pwsh|powershell|cmd|python3|python|node|npm|npx|pnpm|yarn|pip3?|dotnet|java|javac|cargo|ruby|perl|bash)(?![\\/.\w-])|::(?:WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendText|Copy|Delete|Move|Create)\b/;

/** 按未加引号的 |、||、&& 切分 PowerShell 管道段（-Pattern 'a|b' 的引号内 | 不是段边界）。 */
function splitPipelineSegments(command: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "|") {
      if (command[i + 1] === "|") i++; // || 链式操作符
      segs.push(cur);
      cur = "";
    } else if (ch === "&" && command[i + 1] === "&") {
      i++;
      segs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/** 命令是否「静态可判只读」（路线 A'）：每个管道段首 token 都在只读 cmdlet 白名单，
 *  且不含任何写形态（> / >> 重定向、写类 cmdlet、执行器、.NET 写 API）。只用于豁免
 *  子代理 scope reason 的强制弹卡（scope 管写不管读）；checkCommandAgainstWorkspace
 *  的工作区外/.. /系统级 reason 不豁免——那是与普通会话同一安全面。 */
export function isReadOnlyPwshCommand(command: string): boolean {
  const stripped = command.replace(/"[^"]*"|'[^']*'/g, " "); // 引号内文本不参与写形态判定
  if (/[<>]/.test(stripped)) return false; // 裸 <> 必是重定向（PS 比较运算符 -gt/-lt 是字母，不含尖括号）
  if (WRITE_FORM_RE.test(stripped)) return false;
  const segs = splitPipelineSegments(command);
  return (
    segs.length > 0 &&
    segs.every((seg) => READONLY_FIRST_TOKEN_RE.test((seg.split(/\s+/)[0] ?? "").replace(/^&+\s*/, "")))
  );
}

/** 从命令字符串中提取疑似路径 token（含引号内带空格的路径）。 */
function extractPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  const quoted: string[] = [];
  const stripped = command.replace(/"([^"]*)"|'([^']*)'/g, (_m, dq: string | undefined, sq: string | undefined) => {
    quoted.push(dq ?? sq ?? "");
    return " ";
  });
  // 绝对路径：盘符（前面不能是字母数字，排除 https:// 里的 s:）或 UNC 路径
  const absRe = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'|<>&,;]*|\\\\[^\s"'|<>&,;]+)/g;
  for (const m of stripped.matchAll(absRe)) candidates.push(m[0]);
  for (const q of quoted) {
    const m = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^*?<>|"]*|\\\\[\s\S]+)/.exec(q);
    if (m) candidates.push(m[0]);
  }
  return candidates;
}

function hasParentTraversal(command: string): boolean {
  return PARENT_TOKEN_RE.test(command) || INNER_TRAVERSAL_RE.test(command);
}

/**
 * 启发式分析一条 PowerShell 命令是否可能影响工作区之外的内容。
 * 这是防护栏而非沙箱：只能拦截"字面上"可见的工作区外路径/系统操作，
 * 动态拼接的路径无法识别（见 README 的安全说明）。
 */
export function checkCommandAgainstWorkspace(command: string, root: string): CommandCheck {
  const reasons: string[] = [];
  const outsidePaths: string[] = [];
  for (const cand of extractPathCandidates(command)) {
    if (!isInsideWorkspace(root, cand)) outsidePaths.push(cand);
  }
  if (outsidePaths.length > 0) {
    const shown = outsidePaths.slice(0, 3).join("、");
    reasons.push(`引用了工作区外的路径：${shown}${outsidePaths.length > 3 ? " 等" : ""}`);
  }
  if (hasParentTraversal(command)) reasons.push("包含 .. 相对路径（可能跳出工作区）");
  if (PS_ENV_DIR_RE.test(command) || CMD_ENV_DIR_RE.test(command)) {
    reasons.push("引用了用户/系统目录变量（如 $env:USERPROFILE）");
  }
  if (REGISTRY_PATH_RE.test(command) || SYSTEM_COMMAND_RE.test(command) || GLOBAL_INSTALL_RE.test(command) || PIP_INSTALL_RE.test(command)) {
    reasons.push("涉及系统级操作（注册表/服务/软件安装等）");
  }
  return { needsApproval: reasons.length > 0, reasons };
}

/**
 * 子代理 scope 守卫（docs/5 §5.4）：命令字符串里疑似引用的路径中，落在工作区内
 * 但不在 scope 前缀内的。与 checkCommandAgainstWorkspace 同族启发式——命令内容无法
 * 可靠静态分析（动态拼接、Set-Location 后的相对操作识别不了），命中即由 run_pwsh
 * 强制弹卡交用户裁决（诚实边界，误报是安全方向）。
 * 候选 token 三路提取：extractPathCandidates 的绝对路径 + 引号内字符串 + 含路径
 * 分隔符的裸 token（相对路径形态——worker 的 cwd 就是工作区根，相对路径正是 scope
 * 越界的主要形态；既有守卫不需要它，因为相对路径天然解析进工作区）。
 * 工作区外的引用不经此函数（沙箱与既有守卫把关）；scope 为空 = 不限制。
 * W1 路线 A（docs/7 §1.3）：引号/裸 token 两路先过 looksLikePathText 硬规则（正则
 * Pattern、源码文本、多行 here-string 不再被当路径）；裸 token 路消费前先移除全部
 * 引号段（引号内容只由引号路负责——消灭 -Pattern 正则被引号分隔符切碎后的残片）。
 */
export function pathHintsOutsideScope(command: string, root: string, scope: string[]): string[] {
  if (scope.length === 0) return [];
  const rootAbs = resolve(root);
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const prefixes = scope.map(norm);
  const inside = (rel: string) => prefixes.some((b) => b === "" || b === "." || norm(rel) === b || norm(rel).startsWith(b + "/"));
  const hits = new Set<string>();
  const consider = (cand: string) => {
    const c = cand.trim();
    if (!c) return;
    const abs = isAbsolute(c) ? resolve(c) : resolve(rootAbs, c);
    const rel = relative(rootAbs, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return; // 工作区外/根：既有守卫与沙箱把关
    if (!inside(rel)) hits.add(c);
  };
  const stripped = command.replace(/"[^"]*"|'[^']*'/g, " ");
  for (const cand of extractPathCandidates(command)) consider(cand);
  for (const q of command.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const inner = q[1] ?? q[2] ?? "";
    if (looksLikePathText(inner)) consider(inner); // 像路径的引号段（正则/源码文本被硬规则豁免）
  }
  for (const tok of stripped.split(/[\s"'|<>&,;()]+/)) {
    const cleaned = tok.replace(/^[^=]*=/, ""); // 剥 -Param=value 的参数名前缀
    if (looksLikePathText(cleaned)) consider(cleaned); // 含路径分隔符的裸 token（相对路径形态）
  }
  return [...hits];
}
