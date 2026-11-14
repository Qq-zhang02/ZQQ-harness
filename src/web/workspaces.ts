/** 已选工作区注册表：侧边栏工作区树的数据源，数量不设上限（workspaces.json，手动顺序即文件顺序）。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 路径归一化比较（大小写、结尾斜杠） */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, "");
  return norm(a) === norm(b);
}

export function workspacesFilePath(baseDir: string): string {
  return join(baseDir, "workspaces.json");
}

export function loadRecentWorkspaces(file: string): string[] {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { recent?: unknown };
    return Array.isArray(d.recent) ? d.recent.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 确保工作区在列表中：首次出现置顶；已存在则保持现有顺序（选中/切换不改变位置）。 */
export function rememberWorkspace(file: string, list: string[], p: string): string[] {
  if (list.some((w) => sameDir(w, p))) return list;
  const next = [p, ...list];
  try {
    writeFileSync(file, JSON.stringify({ recent: next }, null, 2), "utf8");
  } catch {
    // 写失败不影响本次会话
  }
  return next;
}

/** 手动排序（工作区拖动后调用）：按 ids 顺序重排，缺失的保持原相对顺序补后。 */
export function reorderWorkspaces(file: string, list: string[], ids: string[]): string[] {
  const rest = [...list];
  const out: string[] = [];
  for (const id of ids) {
    const i = rest.findIndex((w) => sameDir(w, id));
    if (i >= 0) out.push(...rest.splice(i, 1));
  }
  out.push(...rest);
  try {
    writeFileSync(file, JSON.stringify({ recent: out }, null, 2), "utf8");
  } catch {
    // 写失败不影响本次会话
  }
  return out;
}

/** 删除工作区：从最近列表移除并持久化（对话由调用方负责转入回收站）。 */
export function forgetWorkspace(file: string, list: string[], p: string): string[] {
  const next = list.filter((w) => !sameDir(w, p));
  try {
    writeFileSync(file, JSON.stringify({ recent: next }, null, 2), "utf8");
  } catch {
    // 写失败不影响本次会话
  }
  return next;
}
