/**
 * src/mcp/config.ts（严格层）测试：损坏文件 fail-closed、条目校验、原子写保留未知键。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServerConfig,
  parseMcpConfigText,
  readMcpConfigFile,
  validateServerEntry,
  writeMcpConfigFile,
} from "./config.ts";

const okTransport = (t: string) => t === "stdio";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mcp-cfg-"));
}

test("parseMcpConfigText：合法/缺键/坏 JSON/顶层非对象 各归其位；未知顶层键保留", () => {
  const ok = parseMcpConfigText('{"mcpServers":{"a":{"command":"x"}},"future":1}');
  assert.ok(ok.ok);
  assert.ok(ok.ok && ok.servers.a.command === "x");
  assert.ok(ok.ok && (ok.obj as Record<string, unknown>).future === 1);

  assert.ok(!parseMcpConfigText("{}").ok); // 缺 mcpServers
  assert.ok(!parseMcpConfigText('{"mcpServers":[]}').ok);
  assert.ok(!parseMcpConfigText("{bad json").ok);
  assert.ok(!parseMcpConfigText("[]").ok);
  assert.ok(!parseMcpConfigText('{"mcpServers":"x"}').ok);
});

test("validateServerEntry：服务名/命令/args/env/type 逐项把关", () => {
  assert.equal(validateServerEntry("demo", { command: "node" }, okTransport), null);
  assert.ok(validateServerEntry(" ", { command: "node" }, okTransport) !== null);
  assert.ok(validateServerEntry(" a", { command: "node" }, okTransport) !== null); // 首尾空白
  assert.ok(validateServerEntry("a b", { command: "node" }, okTransport) !== null); // 内部空格
  assert.ok(validateServerEntry("a".repeat(65), { command: "node" }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "" }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "node", args: [1] }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "node", args: "x" }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "node", env: { K: 1 } }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "node", env: null }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "node", cwd: 3 }, okTransport) !== null);
  assert.ok(validateServerEntry("a", { command: "node", type: "http" }, okTransport) !== null); // 未注册
  assert.equal(validateServerEntry("a", { command: "node", type: "stdio" }, okTransport), null);
  assert.ok(validateServerEntry("a", "not-an-object", okTransport) !== null);
});

test("buildServerConfig：只保留提供的键", () => {
  const minimal = buildServerConfig({ command: "node" });
  assert.deepEqual(Object.keys(minimal), ["command"]);
  const full = buildServerConfig({
    command: "node",
    type: "stdio",
    args: ["a.js", "--x"],
    env: { K: "V" },
    cwd: "d:/w",
  });
  assert.deepEqual(full, { command: "node", type: "stdio", args: ["a.js", "--x"], env: { K: "V" }, cwd: "d:/w" });
});

test("readMcpConfigFile：missing / ok / corrupt（坏 JSON、缺键）", () => {
  const d = tmp();
  const p = join(d, "mcp.json");
  assert.equal(readMcpConfigFile(p).state, "missing");
  writeFileSync(p, '{"mcpServers":{"a":{"command":"node"}}}');
  const ok = readMcpConfigFile(p);
  assert.ok(ok.state === "ok" && ok.servers.a.command === "node");
  writeFileSync(p, "{broken");
  const bad = readMcpConfigFile(p);
  assert.ok(bad.state === "corrupt" && bad.error.includes("JSON"));
  writeFileSync(p, '{"other":1}');
  assert.equal(readMcpConfigFile(p).state, "corrupt");
  rmSync(d, { recursive: true, force: true });
});

test("writeMcpConfigFile：原子写回后未知顶层键与其他条目不丢；自动建父目录", () => {
  const d = tmp();
  const p = join(d, "nested", "mcp.json");
  writeMcpConfigFile(p, {
    mcpServers: { keep: { command: "node" } },
    note: "手工备注",
  });
  const back = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(back.mcpServers.keep, { command: "node" });
  assert.equal(back.note, "手工备注");
  rmSync(d, { recursive: true, force: true });
});
