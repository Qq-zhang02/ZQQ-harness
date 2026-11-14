import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommandAgainstWorkspace, isInsideWorkspace, isReadOnlyPwshCommand, pathHintsOutsideScope, readAgentsMd } from "./workspace.ts";

const ROOT = "F:\\proj";

test("isInsideWorkspace 基本判断", () => {
  assert.equal(isInsideWorkspace(ROOT, "F:\\proj\\a.txt"), true);
  assert.equal(isInsideWorkspace(ROOT, "F:\\proj"), true);
  assert.equal(isInsideWorkspace(ROOT, "f:\\PROJ\\sub\\b"), true); // Windows 大小写不敏感
  assert.equal(isInsideWorkspace(ROOT, "F:\\other\\c.txt"), false);
  assert.equal(isInsideWorkspace(ROOT, "F:\\project-x\\d"), false); // 前缀相似但不在工作区
  assert.equal(isInsideWorkspace(ROOT, "C:\\Windows\\x"), false); // 跨盘符
  assert.equal(isInsideWorkspace(ROOT, "src/a.ts"), true); // 相对路径
  assert.equal(isInsideWorkspace(ROOT, "..\\escape"), false);
});

test("工作区内命令无需批准", () => {
  assert.equal(checkCommandAgainstWorkspace("Get-ChildItem -Recurse -Filter *.ts", ROOT).needsApproval, false);
  assert.equal(checkCommandAgainstWorkspace("Get-Process | Select-Object -First 3", ROOT).needsApproval, false);
  assert.equal(checkCommandAgainstWorkspace(`Set-Content -Path ${ROOT}\\out\\a.txt -Value hi`, ROOT).needsApproval, false);
  assert.equal(checkCommandAgainstWorkspace('Set-Content -Path "out\\a b.txt" -Value hi', ROOT).needsApproval, false);
});

test("工作区外绝对路径需要批准", () => {
  const c = checkCommandAgainstWorkspace("Set-Content -Path C:\\Windows\\a.txt -Value x", ROOT);
  assert.equal(c.needsApproval, true);
  assert.ok(c.reasons.some((r) => r.includes("工作区外")));
});

test("带空格的引号路径也能识别", () => {
  const c = checkCommandAgainstWorkspace('Get-Content "C:\\Program Files\\app\\c.txt"', ROOT);
  assert.equal(c.needsApproval, true);
});

test("UNC 路径需要批准", () => {
  assert.equal(checkCommandAgainstWorkspace("Get-ChildItem \\\\server\\share\\f", ROOT).needsApproval, true);
});

test(".. 逃逸需要批准", () => {
  assert.equal(checkCommandAgainstWorkspace("Remove-Item -Recurse ..\\..\\tmp", ROOT).needsApproval, true);
  assert.equal(checkCommandAgainstWorkspace("Get-Content src\\..\\pkg\\f", ROOT).needsApproval, true);
});

test("URL 不误报为路径", () => {
  const c = checkCommandAgainstWorkspace(
    "Invoke-WebRequest https://api.deepseek.com/v1/chat -UseBasicParsing | Select-Object -First 1",
    ROOT,
  );
  assert.equal(c.needsApproval, false);
});

test("用户/系统目录变量需要批准", () => {
  assert.equal(checkCommandAgainstWorkspace("Copy-Item $env:USERPROFILE\\doc.txt .", ROOT).needsApproval, true);
  assert.equal(checkCommandAgainstWorkspace("Get-ChildItem $HOME", ROOT).needsApproval, true);
});

test("系统级操作需要批准", () => {
  assert.equal(checkCommandAgainstWorkspace("New-ItemProperty -Path HKLM:\\SOFTWARE\\x -Name y", ROOT).needsApproval, true);
  assert.equal(checkCommandAgainstWorkspace("npm install -g typescript", ROOT).needsApproval, true);
  assert.equal(checkCommandAgainstWorkspace("npm install lodash", ROOT).needsApproval, false);
  assert.equal(checkCommandAgainstWorkspace("schtasks /create /tn x", ROOT).needsApproval, true);
});

test("readAgentsMd：读取/缺失/截断", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-agents-"));
  try {
    assert.equal(readAgentsMd(dir), null); // 无文件
    const empty = join(dir, "empty");
    mkdirSync(empty);
    writeFileSync(join(empty, "AGENTS.md"), "   \n");
    assert.equal(readAgentsMd(empty), null); // 空白
    const full = join(dir, "full");
    mkdirSync(full);
    writeFileSync(join(full, "AGENTS.md"), "规则一：用中文", "utf8");
    assert.equal(readAgentsMd(full), "规则一：用中文");
    const big = join(dir, "big");
    mkdirSync(big);
    writeFileSync(join(big, "AGENTS.md"), "A".repeat(20000), "utf8");
    const got = readAgentsMd(big) ?? "";
    assert.ok(got.length < 20000 && got.includes("已截断"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- SA3：scope 守卫（docs/5 §5.4，相对路径形态是主要威胁面） ----------

test("pathHintsOutsideScope：相对/绝对/引号内路径的越界检测与目录级前缀", () => {
  const scope = ["src/auth", "docs"];
  // 相对路径（worker cwd=工作区根，主要形态）
  assert.deepEqual(pathHintsOutsideScope("Set-Content -Path src/other/f.txt -Value x", ROOT, scope), ["src/other/f.txt"]);
  assert.deepEqual(pathHintsOutsideScope('Get-Content "src/other/f.txt"', ROOT, scope), ["src/other/f.txt"]);
  assert.deepEqual(pathHintsOutsideScope("Set-Content docs/spec.md -Value x", ROOT, scope), []); // 前缀内
  assert.deepEqual(pathHintsOutsideScope("Set-Content src/auth/token.ts -Value x", ROOT, scope), []); // 目录级前缀：深层子目录也在内
  assert.deepEqual(pathHintsOutsideScope("Set-Content src/authenticate.ts -Value x", ROOT, scope), ["src/authenticate.ts"]); // 前缀相似不算
  // 绝对路径（工作区内）
  assert.deepEqual(pathHintsOutsideScope(`Get-Item ${ROOT}\\src\\other\\f.txt`, ROOT, scope), [`${ROOT}\\src\\other\\f.txt`]);
  assert.deepEqual(pathHintsOutsideScope(`Get-Item ${ROOT}\\docs\\a.md`, ROOT, scope), []);
  // 工作区外 / 根 / scope 为空：不经此守卫
  assert.deepEqual(pathHintsOutsideScope("Get-Item C:\\Windows\\System32\\x.dll", ROOT, scope), []);
  assert.deepEqual(pathHintsOutsideScope("Write-Output src/other/f.txt", ROOT, []), []);
  // -Param=value 形态剥前缀后再判
  assert.deepEqual(pathHintsOutsideScope("Copy-Item a.ts -Destination=src/other/b.ts", ROOT, scope), ["src/other/b.ts"]);
});

// ---------- W1 路线 A（docs/7 §1.1 实弹命令回归）：token 提取精度——正则/源码不再被当路径 ----------

test("W1 路线 A：卡 A 实弹——Select-String 的 -Pattern 正则内容不再进 scope 命中集", () => {
  const scope = ["e5_highprec.txt", "TASKS.md", "scripts"];
  const cmdA =
    "Select-String -Path scripts/e5_highprec.py -Pattern 'e5_via_mpmath|e5_via_decimal|range\\(ndigits\\)|if have <= want' | Select-Object LineNumber,Line";
  // scripts/e5_highprec.py 在 scope 内；三个被误报的 token 全是 -Pattern 的正则内容 → 命中集为空
  assert.deepEqual(pathHintsOutsideScope(cmdA, ROOT, scope), []);
  // 同一命令引用真区外路径（-Path 换成区外）仍命中：误报修掉、正报不动
  const cmdA2 =
    "Select-String -Path src/other/f.py -Pattern 'e5_via_mpmath|e5_via_decimal|range\\(ndigits\\)' | Select-Object LineNumber,Line";
  assert.deepEqual(pathHintsOutsideScope(cmdA2, ROOT, scope), ["src/other/f.py"]);
});

test("W1 路线 A：卡 B 实弹——python here-string 源码（多行）不再进 scope 命中集", () => {
  const scope = ["e5_highprec.txt", "TASKS.md", "scripts"];
  const cmdB =
    '$env:PYTHONUTF8="1"; & "D:/Programs/Python/Python314/python.exe" -c @"\nfrom decimal import Decimal, localcontext\nimport mpmath as mp\nprint(mp.e ** 5)\n"@';
  const hits = pathHintsOutsideScope(cmdB, ROOT, scope);
  assert.ok(
    hits.every((h) => !h.includes("import") && !h.includes("decimal") && !h.includes("print")),
    `源码文本不再是命中项：${JSON.stringify(hits)}`,
  );
});

test("W1 路线 A：正报保持——引号内/裸 token 的真区外相对路径、写形态命令照旧命中", () => {
  const scope = ["src/auth", "docs"];
  assert.deepEqual(pathHintsOutsideScope("python x.py 'src/other/a.py'", ROOT, scope), ["src/other/a.py"]);
  assert.deepEqual(pathHintsOutsideScope("Get-Content ..\\x", ROOT, scope), []); // 工作区外（..）不经此守卫
  assert.deepEqual(pathHintsOutsideScope("Get-Content src/other/x.txt > out.txt", ROOT, scope), ["src/other/x.txt"]);
  assert.deepEqual(pathHintsOutsideScope("Out-File src/other/x.txt", ROOT, scope), ["src/other/x.txt"]);
  // 引号内正则里夹真区外路径（既像正则又引用路径）：正则元字符豁免只作用于「整段」，
  // 裸路径形态（无元字符）仍在判定面内
  assert.deepEqual(pathHintsOutsideScope("Set-Content -Value 'a|b' -Path 'src/other/c.txt'", ROOT, scope), ["src/other/c.txt"]);
});

// ---------- W1 路线 A'：只读命令豁免（scope 管写不管读；白名单 + 无写形态） ----------

test("W1 路线 A'：isReadOnlyPwshCommand——白名单/管道/引号感知/写形态", () => {
  // 只读命令（含卡 A 实弹：引号内 | 不是管道边界）
  assert.equal(isReadOnlyPwshCommand("Get-Content a.txt"), true);
  assert.equal(isReadOnlyPwshCommand("Get-ChildItem -Recurse -Filter *.ts | Select-Object -First 3"), true);
  assert.equal(
    isReadOnlyPwshCommand("Select-String -Path scripts/x.py -Pattern 'e5_via_mpmath|e5_via_decimal' | Select-Object LineNumber,Line"),
    true,
  );
  assert.equal(isReadOnlyPwshCommand("Select-String -Path x.py -Pattern 'a>b'"), true, "引号内 > 不算重定向");
  assert.equal(isReadOnlyPwshCommand("Test-Path src/auth"), true);
  // 写形态：重定向、写 cmdlet（含脚本块内）、执行器、.NET 写 API——一律不豁免
  assert.equal(isReadOnlyPwshCommand("Get-Content a.txt > out.txt"), false, "重定向");
  assert.equal(isReadOnlyPwshCommand("Get-Content a.txt | Out-File b.txt"), false, "管道尾写 cmdlet");
  assert.equal(isReadOnlyPwshCommand("Get-Content a.txt | Set-Content src/other/b.txt"), false);
  assert.equal(isReadOnlyPwshCommand('python x.py "src/other/a.py"'), false, "执行器不可豁免（只读性无法静态判定）");
  assert.equal(isReadOnlyPwshCommand('& "D:/Programs/Python/Python314/python.exe" -c "print(1)"'), false);
  assert.equal(isReadOnlyPwshCommand("Where-Object { [IO.File]::WriteAllText('a','b') }"), false, "脚本块内 .NET 写 API");
  assert.equal(isReadOnlyPwshCommand('Get-ChildItem | ForEach-Object { Set-Content x y }'), false, "脚本块内写 cmdlet");
  // 非白名单首 token（别名/写 cmdlet/表达式）不豁免
  assert.equal(isReadOnlyPwshCommand("gci | select -First 3"), false, "别名不在白名单（fail-closed）");
  assert.equal(isReadOnlyPwshCommand("Set-Content a.txt x"), false);
  assert.equal(isReadOnlyPwshCommand("Write-Output hi"), false);
});
