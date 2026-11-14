import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isThinkingEffort,
  loadApiKey,
  loadHarnessConfig,
  parseHarnessConfig,
  parseCredentialsYaml,
  reasoningPassbackEnabled,
  resolveThresholds,
  SUBAGENT_MAX_CONCURRENT,
  SUBAGENT_MAX_TOTAL,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_RESULT_MAX_CHARS,
} from "./config.ts";
import type { EffortSetting } from "./llm/provider.ts";

test("解析极简 credentials yaml", () => {
  const y = [
    "# 注释",
    "DEEPSEEK_API_KEY: sk-abc123",
    'OTHER_KEY: "quoted value"',
    "",
  ].join("\n");
  const m = parseCredentialsYaml(y);
  assert.equal(m.DEEPSEEK_API_KEY, "sk-abc123");
  assert.equal(m.OTHER_KEY, "quoted value");
});

test("loadApiKey：文件读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-cred-"));
  try {
    const f = join(dir, ".credentials.yaml");
    writeFileSync(f, "DEEPSEEK_API_KEY: sk-from-file\n", "utf8");
    assert.equal(loadApiKey([join(dir, "not-exist.yaml"), f]), "sk-from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadApiKey：环境变量优先", () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-from-env";
  try {
    assert.equal(loadApiKey([]), "sk-from-env");
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test("loadApiKey：找不到时抛错", () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.throws(() => loadApiKey([]), /DEEPSEEK_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
  }
});

test("reasoningPassbackEnabled：默认关，识别 1/on/true/yes（大小写与空白不敏感）", () => {
  const prev = process.env.REASONING_PASSBACK;
  const set = (v?: string) => {
    if (v === undefined) delete process.env.REASONING_PASSBACK;
    else process.env.REASONING_PASSBACK = v;
  };
  try {
    set(undefined);
    assert.equal(reasoningPassbackEnabled(), false); // 默认 off
    for (const v of ["1", "on", "true", "yes", "ON", " True ", "YES"]) {
      set(v);
      assert.equal(reasoningPassbackEnabled(), true, v);
    }
    for (const v of ["0", "off", "", "2", "enabled"]) {
      set(v);
      assert.equal(reasoningPassbackEnabled(), false, v);
    }
  } finally {
    if (prev === undefined) delete process.env.REASONING_PASSBACK;
    else process.env.REASONING_PASSBACK = prev;
  }
});

test("isThinkingEffort：low/high/max 为思考模式，off/default 不是", () => {
  for (const e of ["low", "high", "max"] as const) assert.equal(isThinkingEffort(e as EffortSetting), true, e);
  for (const e of ["off", "default"] as const) assert.equal(isThinkingEffort(e as EffortSetting), false, e);
});

// ---- harness.json（P8：模块启停 + 阈值覆盖） ----

test("parseHarnessConfig：合法全量解析（去重 + trim），无告警", () => {
  const { config, warnings } = parseHarnessConfig({
    disabledModules: ["tools.pwsh", " web-workspaces ", "tools.pwsh"],
    thresholds: { compactionPressure: 0.5, maxToolRounds: 7, spillThreshold: 5_000 },
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.disabledModules, ["tools.pwsh", "web-workspaces"]);
  assert.equal(config.thresholds.compactionPressure, 0.5);
  assert.equal(config.thresholds.maxToolRounds, 7);
  assert.equal(config.thresholds.spillThreshold, 5_000);
});

test("parseHarnessConfig：非法值逐项忽略并告警，未知键告警（打字错误防护）", () => {
  const { config, warnings } = parseHarnessConfig({
    disabledModules: ["ok", 42, ""],
    thresholds: { compactionPressure: 1.5, spillThreshold: "x", maxToolRounds: 7.5, unknownKey: 1 },
    extraTop: true,
  });
  assert.deepEqual(config.disabledModules, ["ok"]);
  assert.equal(config.thresholds.compactionPressure, undefined);
  assert.equal(config.thresholds.maxToolRounds, undefined);
  assert.ok(warnings.some((w) => w.includes("compactionPressure")), warnings.join("；"));
  assert.ok(warnings.some((w) => w.includes("spillThreshold")));
  assert.ok(warnings.some((w) => w.includes("maxToolRounds")));
  assert.ok(warnings.some((w) => w.includes("unknownKey")));
  assert.ok(warnings.some((w) => w.includes("extraTop")));
  assert.ok(warnings.some((w) => w.includes("42")));
});

test("parseHarnessConfig：null/数组/字符串顶层一律全缺省", () => {
  for (const raw of [null, [1, 2], "oops", 3]) {
    const { config, warnings } = parseHarnessConfig(raw);
    assert.deepEqual(config, { disabledModules: [], thresholds: {} });
    assert.ok(warnings.length >= 1 || raw === null);
  }
});

test("resolveThresholds：缺省值正确；覆盖生效；pwsh 最大超时不低于缺省超时", () => {
  const d = resolveThresholds({});
  assert.equal(d.compactionPressure, 0.8);
  assert.equal(d.spillThreshold, 20_000);
  assert.equal(d.compactionKeepRatio, 0.3);
  assert.equal(d.compactionManualKeepTokens, 0);
  assert.equal(d.defaultContextLength, 1_000_000);
  assert.equal(d.maxToolRounds, 15);
  assert.equal(d.pwshTimeoutMs, 60_000);
  assert.equal(d.pwshMaxTimeoutMs, 300_000);
  assert.equal(d.toolResultMaxChars, 24_000);
  const o = resolveThresholds({ pwshTimeoutMs: 120_000, pwshMaxTimeoutMs: 60_000, compactionManualKeepTokens: 500 });
  assert.equal(o.compactionManualKeepTokens, 500);
  assert.equal(o.pwshTimeoutMs, 120_000);
  assert.ok(o.pwshMaxTimeoutMs >= o.pwshTimeoutMs);
});

// ---- docs/21 §2.2-④：compection*（拼写错误旧键）双读兼容 ----

test("parseHarnessConfig：compection* 旧拼写键映射到 compaction* 并告警更名（docs/21 §2.2-④）", () => {
  const a = parseHarnessConfig({
    thresholds: { compectionPressure: 0.5, compectionKeepRatio: 0.4, compectionManualKeepTokens: 100 },
  });
  assert.equal(a.config.thresholds.compactionPressure, 0.5);
  assert.equal(a.config.thresholds.compactionKeepRatio, 0.4);
  assert.equal(a.config.thresholds.compactionManualKeepTokens, 100);
  for (const old of ["compectionPressure", "compectionKeepRatio", "compectionManualKeepTokens"]) {
    assert.ok(a.warnings.some((w) => w.includes(`"${old}"`) && w.includes("已更名")), `旧键 ${old} 应告警更名提示`);
  }
});

test("parseHarnessConfig：新旧键同存时新键优先（旧键仅告警不覆盖）", () => {
  const b = parseHarnessConfig({ thresholds: { compectionPressure: 0.5, compactionPressure: 0.6 } });
  assert.equal(b.config.thresholds.compactionPressure, 0.6);
  assert.ok(b.warnings.some((w) => w.includes("已更名")));
});

test("parseHarnessConfig：旧拼写键的非法值走新键名校验（告警含规范名）", () => {
  const c = parseHarnessConfig({ thresholds: { compectionPressure: 1.5 } });
  assert.equal(c.config.thresholds.compactionPressure, undefined);
  assert.ok(c.warnings.some((w) => w.includes("已更名")));
  assert.ok(c.warnings.some((w) => w.includes("compactionPressure") && w.includes("不合法")));
});

// ---- 子代理阈值（docs/5 SA0：键名拼写即 API，测试锁缺省/覆盖/校验规则） ----

test("resolveThresholds：子代理四阈值缺省 3/24/40/8000，覆盖生效", () => {
  const d = resolveThresholds({});
  assert.equal(d.subagentMaxConcurrent, 3);
  assert.equal(d.subagentMaxTotal, 24);
  assert.equal(d.subagentMaxToolRounds, 40);
  assert.equal(d.subagentResultMaxChars, 8_000);
  const o = resolveThresholds({
    subagentMaxConcurrent: 5,
    subagentMaxTotal: 10,
    subagentMaxToolRounds: 60,
    subagentResultMaxChars: 4_000,
  });
  assert.equal(o.subagentMaxConcurrent, 5);
  assert.equal(o.subagentMaxTotal, 10);
  assert.equal(o.subagentMaxToolRounds, 60);
  assert.equal(o.subagentResultMaxChars, 4_000);
});

test("parseHarnessConfig：子代理并发/累计/轮次阈值须 ≥1 整数，非法逐项忽略并告警", () => {
  const { config, warnings } = parseHarnessConfig({
    thresholds: { subagentMaxConcurrent: 0, subagentMaxTotal: 2.5, subagentMaxToolRounds: -1, subagentMaxConcurent: 2 },
  });
  assert.equal(config.thresholds.subagentMaxConcurrent, undefined);
  assert.equal(config.thresholds.subagentMaxTotal, undefined);
  assert.equal(config.thresholds.subagentMaxToolRounds, undefined);
  assert.ok(warnings.some((w) => w.includes("subagentMaxConcurrent")));
  assert.ok(warnings.some((w) => w.includes("subagentMaxTotal")));
  assert.ok(warnings.some((w) => w.includes("subagentMaxToolRounds")));
  assert.ok(warnings.some((w) => w.includes("未知阈值") && w.includes("subagentMaxConcurent")));
});

test("parseHarnessConfig：子代理报告预算须 >0 整数，0 被忽略、合法值无告警", () => {
  const bad = parseHarnessConfig({ thresholds: { subagentResultMaxChars: 0 } });
  assert.equal(bad.config.thresholds.subagentResultMaxChars, undefined);
  assert.ok(bad.warnings.some((w) => w.includes("subagentResultMaxChars")));
  const ok2 = parseHarnessConfig({ thresholds: { subagentResultMaxChars: 12_000 } });
  assert.equal(ok2.config.thresholds.subagentResultMaxChars, 12_000);
  assert.deepEqual(ok2.warnings, []);
});

test("子代理阈值生效常量与 resolveThresholds 缺省同源（harness.json 覆盖的唯一出口）", () => {
  const d = resolveThresholds({});
  assert.equal(SUBAGENT_MAX_CONCURRENT, d.subagentMaxConcurrent);
  assert.equal(SUBAGENT_MAX_TOTAL, d.subagentMaxTotal);
  assert.equal(SUBAGENT_MAX_TOOL_ROUNDS, d.subagentMaxToolRounds);
  assert.equal(SUBAGENT_RESULT_MAX_CHARS, d.subagentResultMaxChars);
});

test("loadHarnessConfig：缺失/损坏文件全缺省，合法文件生效", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-harness-cfg-"));
  try {
    assert.deepEqual(loadHarnessConfig(join(dir, "no-such.json")), { disabledModules: [], thresholds: {} });
    writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
    assert.deepEqual(loadHarnessConfig(join(dir, "bad.json")), { disabledModules: [], thresholds: {} });
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ thresholds: { maxToolRounds: 3 } }), "utf8");
    const c = loadHarnessConfig(join(dir, "ok.json"));
    assert.deepEqual(c.disabledModules, []);
    assert.equal(c.thresholds.maxToolRounds, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- docs/10：子代理上下文治理阈值（R1）与 spillThreshold 废弃兼容（R2） ----------

test("parseHarnessConfig：subagentFollowupContextPct/subagentArchiveContextPct 规则（(0,100] 整数；越界忽略+告警）", () => {
  const ok = parseHarnessConfig({
    thresholds: { subagentFollowupContextPct: 30, subagentArchiveContextPct: 60 },
  });
  assert.equal(ok.config.thresholds.subagentFollowupContextPct, 30);
  assert.equal(ok.config.thresholds.subagentArchiveContextPct, 60);
  assert.equal(ok.warnings.length, 0);

  const bad = parseHarnessConfig({
    thresholds: { subagentFollowupContextPct: 0, subagentArchiveContextPct: 101, subagentFollowupContextPct2: 1 },
  } as Parameters<typeof parseHarnessConfig>[0]);
  assert.equal(bad.config.thresholds.subagentFollowupContextPct, undefined, "0 越界忽略");
  assert.equal(bad.config.thresholds.subagentArchiveContextPct, undefined, "101 越界忽略");
  assert.ok(bad.warnings.some((w) => w.includes("subagentFollowupContextPct")));
  assert.ok(bad.warnings.some((w) => w.includes("subagentArchiveContextPct")));

  const eff = resolveThresholds({});
  assert.equal(eff.subagentFollowupContextPct, 35, "缺省 35");
  assert.equal(eff.subagentArchiveContextPct, 50, "缺省 50");
});

test("resolveThresholds：spillThreshold 保留解析兼容旧配置（docs/10 R2 废弃但无未知键告警）", () => {
  const r = parseHarnessConfig({ thresholds: { spillThreshold: 5_000 } });
  assert.equal(r.config.thresholds.spillThreshold, 5_000);
  assert.equal(r.warnings.length, 0, "已配置旧键不告警");
  assert.equal(resolveThresholds(r.config.thresholds).spillThreshold, 5_000);
});

test("parseHarnessConfig/resolveThresholds：subagentWarnContextPct（预警线，默认 25）规则与缺省", () => {
  const ok = parseHarnessConfig({ thresholds: { subagentWarnContextPct: 25 } });
  assert.equal(ok.config.thresholds.subagentWarnContextPct, 25);
  assert.equal(ok.warnings.length, 0);
  const bad = parseHarnessConfig({ thresholds: { subagentWarnContextPct: 0 } });
  assert.equal(bad.config.thresholds.subagentWarnContextPct, undefined, "0 越界忽略");
  assert.ok(bad.warnings.some((w) => w.includes("subagentWarnContextPct")));
  assert.equal(resolveThresholds({}).subagentWarnContextPct, 25, "缺省 25");
});
