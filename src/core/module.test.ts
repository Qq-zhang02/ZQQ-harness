/**
 * loadExternalModules 单元测试（P8）：外部模块目录的宽松装载语义——
 * 合法模块按文件名序接受；导入失败/坏形态/重名/依赖不满足逐个跳过且不抛错。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalModules } from "./module.ts";

test("loadExternalModules：目录不存在返回空数组", async () => {
  assert.deepEqual(await loadExternalModules(join(tmpdir(), "zqq-no-such-ext-dir"), []), []);
});

test("loadExternalModules：合法模块被接受，按文件名序，dependsOn 可满足时通过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-ext-ok-"));
  try {
    writeFileSync(
      join(dir, "a-good.ts"),
      `export default { name: "ext.a", dependsOn: ["builtin.x"], setup() {} };\n`,
      "utf8",
    );
    writeFileSync(join(dir, "b-nodep.ts"), `export default { name: "ext.b", setup() {} };\n`, "utf8");
    writeFileSync(join(dir, "ignored.txt"), `这不是模块`, "utf8");
    const mods = await loadExternalModules(dir, ["builtin.x"]);
    assert.deepEqual(mods.map((m) => m.name), ["ext.a", "ext.b"]);
    assert.equal(mods[0].dependsOn?.[0], "builtin.x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadExternalModules：依赖缺失/重名/坏形态/导入失败/测试文件逐个跳过，不抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-ext-bad-"));
  try {
    writeFileSync(
      join(dir, "1-dep-missing.ts"),
      `export default { name: "x.dep", dependsOn: ["no-such-module"], setup() {} };\n`,
      "utf8",
    );
    writeFileSync(join(dir, "2-dup.ts"), `export default { name: "tools.pwsh", setup() {} };\n`, "utf8");
    writeFileSync(join(dir, "3-bad-shape.ts"), `export default { foo: 1 };\n`, "utf8");
    writeFileSync(join(dir, "4-no-default.ts"), `export const name = "x.nd";\n`, "utf8");
    writeFileSync(join(dir, "5-syntax.ts"), `export default {{{;\n`, "utf8");
    writeFileSync(join(dir, "6-case.test.ts"), `export default { name: "x.t", setup() {} };\n`, "utf8");
    const mods = await loadExternalModules(dir, ["tools.pwsh"]);
    assert.deepEqual(mods, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadExternalModules：多个外部模块相互依赖时按文件名序满足（先装载者可用）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-ext-chain-"));
  try {
    writeFileSync(join(dir, "1-base.ts"), `export default { name: "ext.base", setup() {} };\n`, "utf8");
    writeFileSync(
      join(dir, "2-user.ts"),
      `export default { name: "ext.user", dependsOn: ["ext.base"], setup() {} };\n`,
      "utf8",
    );
    const mods = await loadExternalModules(dir, []);
    assert.deepEqual(mods.map((m) => m.name), ["ext.base", "ext.user"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
