import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetWorkspace, loadRecentWorkspaces, rememberWorkspace, reorderWorkspaces, workspacesFilePath } from "./workspaces.ts";

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "zqq-ws-"));
  return { dir, file: workspacesFilePath(dir) };
}

test("workspaces：首次出现置顶，已存在不因选中而移动", () => {
  const { dir, file } = tempFile();
  try {
    let list = rememberWorkspace(file, [], "F:\\a");
    assert.deepEqual(list, ["F:\\a"]);
    list = rememberWorkspace(file, list, "F:\\b");
    list = rememberWorkspace(file, list, "F:\\c");
    assert.deepEqual(list, ["F:\\c", "F:\\b", "F:\\a"]);
    // 选中已存在的工作区：顺序不变
    list = rememberWorkspace(file, list, "F:\\b");
    assert.deepEqual(list, ["F:\\c", "F:\\b", "F:\\a"]);
    // sameDir 视为同一目录（大小写/结尾斜杠）
    list = rememberWorkspace(file, list, "f:\\C\\");
    assert.deepEqual(list, ["F:\\c", "F:\\b", "F:\\a"]);
    // 持久化一致
    assert.deepEqual(loadRecentWorkspaces(file), ["F:\\c", "F:\\b", "F:\\a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspaces：手动排序（缺失补后）与删除", () => {
  const { dir, file } = tempFile();
  try {
    const list = ["F:\\a", "F:\\b", "F:\\c"];
    assert.deepEqual(reorderWorkspaces(file, list, ["F:\\c", "F:\\a"]), ["F:\\c", "F:\\a", "F:\\b"]);
    assert.deepEqual(reorderWorkspaces(file, list, []), list); // 空 ids 保持原序
    assert.deepEqual(forgetWorkspace(file, list, "f:\\B\\"), ["F:\\a", "F:\\c"]);
    // 写失败不影响返回值：文件路径在子目录里且目录不存在，写入应失败但函数不抛
    assert.deepEqual(forgetWorkspace(join(dir, "nope", "ws.json"), list, "F:\\a"), ["F:\\b", "F:\\c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspaces：文件损坏/缺失时加载为空，非法条目被过滤", () => {
  const { dir, file } = tempFile();
  try {
    assert.deepEqual(loadRecentWorkspaces(file), []);
    writeFileSync(file, "not json", "utf8");
    assert.deepEqual(loadRecentWorkspaces(file), []);
    writeFileSync(file, JSON.stringify({ recent: ["F:\\a", 42] }), "utf8");
    assert.deepEqual(loadRecentWorkspaces(file), ["F:\\a"]);
    readFileSync(file, "utf8"); // 文件可读（内容不校验）
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspaces：排序收编孤儿组（不在列表的工作区按拖放位置插入，sameDir 去重）", () => {
  const { dir, file } = tempFile();
  try {
    const list = ["F:\\a", "F:\\b"];
    // 把孤儿组 F:\orphan 拖到 b 之后、a 之前：按拖放位置收编进列表
    const out = reorderWorkspaces(file, list, ["F:\\b", "F:\\orphan", "F:\\a"]);
    assert.deepEqual(out, ["F:\\b", "F:\\orphan", "F:\\a"]);
    assert.deepEqual(loadRecentWorkspaces(file), out, "收编结果持久化");
    // 大小写/结尾斜杠归一：已收编的不重复插入，仅按新序移动
    assert.deepEqual(reorderWorkspaces(file, out, ["f:\\ORPHAN\\", "F:\\a", "F:\\b"]), ["F:\\orphan", "F:\\a", "F:\\b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
