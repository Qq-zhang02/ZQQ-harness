import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS,
  HARNESS_CONFIG,
  COMPACTION_PRESSURE,
  ESCALATION_MAX,
  initConfig,
  isThinkingEffort,
  loadApiKey,
  loadHarnessConfig,
  parseHarnessConfig,
  parseCredentialsYaml,
  reasoningPassbackEnabled,
  resolveThresholds,
  stripJsonComments,
  SUBAGENT_MAX_CONCURRENT,
  SUBAGENT_MAX_TOTAL,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_RESULT_MAX_CHARS,
  thresholdSchema,
  validateThresholdsStrict,
  HTTP_BODY_FLOOR_BYTES,
  IMAGE_RULES,
  IMAGE_TOKEN_EST,
  READ_FILE_DEFAULT_LINES,
  SUBAGENT_TIMEOUT_MIN_MS,
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
  assert.equal(d.toolResultMaxChars, 48_000);
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

test("resolveThresholds：子代理四阈值缺省 3/24/40/16000，覆盖生效", () => {
  const d = resolveThresholds({});
  assert.equal(d.subagentMaxConcurrent, 3);
  assert.equal(d.subagentMaxTotal, 24);
  assert.equal(d.subagentMaxToolRounds, 40);
  assert.equal(d.subagentResultMaxChars, 16_000);
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

test("initConfig：显式装载重绑全部生效常量，空配置重置回缺省（docs/21 §3.3 / docs/23 D2）", () => {
  try {
    // 导入态 = 纯缺省（不读真机 harness.json——本测试在任何机器上都必须同值通过）
    const d = resolveThresholds({});
    assert.equal(COMPACTION_PRESSURE, d.compactionPressure);
    assert.equal(ESCALATION_MAX, d.escalationMax);
    assert.equal(DEFAULTS.pwshTimeoutMs, d.pwshTimeoutMs);
    // 显式装载覆盖值 → live binding 立即生效（含 DEFAULTS 整对象替换与交叉校验）
    const cfg = initConfig({ disabledModules: ["demo.x"], thresholds: { subagentMaxConcurrent: 7, compactionPressure: 0.5, pwshTimeoutMs: 120_000, pwshMaxTimeoutMs: 90_000 } });
    assert.deepEqual(cfg, HARNESS_CONFIG);
    assert.equal(SUBAGENT_MAX_CONCURRENT, 7);
    assert.equal(COMPACTION_PRESSURE, 0.5);
    assert.equal(DEFAULTS.pwshTimeoutMs, 120_000);
    assert.equal(DEFAULTS.pwshMaxTimeoutMs, 120_000); // 交叉校验：最大 < 缺省时抬到缺省
    // 空配置重置回纯缺省（可重复调用，最后一次生效）
    initConfig({ disabledModules: [], thresholds: {} });
    assert.equal(SUBAGENT_MAX_CONCURRENT, d.subagentMaxConcurrent);
    assert.equal(COMPACTION_PRESSURE, d.compactionPressure);
    assert.deepEqual(HARNESS_CONFIG, { disabledModules: [], thresholds: {} });
  } finally {
    initConfig({ disabledModules: [], thresholds: {} }); // 恢复导入态，不泄漏给同文件后续测试
  }
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

test("stripJsonComments：行/块注释剥离，字符串内的注释符原样保留（harness.json 允许 JSONC）", () => {
  assert.equal(stripJsonComments('{"a": 1} // 行尾注释\n'), '{"a": 1} \n');
  assert.equal(stripJsonComments('// 整行注释\n{"a": 1}'), '\n{"a": 1}');
  assert.equal(stripJsonComments('{"a": /* 块注释 */ 1}'), '{"a":   1}');
  // 字符串字面量内的 // 与 /* 不剥（URL/路径/转义引号）
  assert.equal(stripJsonComments('{"u": "https://x//y/*z*/", "e": "a\\"b//c"}'), '{"u": "https://x//y/*z*/", "e": "a\\"b//c"}');
  // 块注释跨行 + 未闭合容忍（剥到末尾）
  assert.equal(stripJsonComments('{"a": 1 /* 跨\n行 */ , "b": 2}'), '{"a": 1   , "b": 2}');
  assert.equal(stripJsonComments('{"a": 1 /* 未闭合'), '{"a": 1  ');
});

test("loadHarnessConfig：JSONC 注释文件正常解析（全键注释模板的读取路径）", () => {
  const dir = mkdtempSync(join(tmpdir(), "zqq-harness-jsonc-"));
  try {
    writeFileSync(
      join(dir, "c.json"),
      [
        "// 顶部说明注释",
        "{",
        '  "disabledModules": [], // 模块启停',
        '  "thresholds": {',
        '    "maxToolRounds": 5, // 整数 ≥1',
        '    "compactionPressure": 0.7 /* 块注释 */',
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const c = loadHarnessConfig(join(dir, "c.json"));
    assert.deepEqual(c.disabledModules, []);
    assert.equal(c.thresholds.maxToolRounds, 5);
    assert.equal(c.thresholds.compactionPressure, 0.7);
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

// ---- 阶段 B 第一批（docs/21 §2.3 前 8 键，docs/22 §4.2）：缺省/覆盖/非法三态 ----

test("resolveThresholds：阶段 B 第一批 8 键缺省值（8/16000/20s/60s/1MB/3/168h/24h）", () => {
  const d = resolveThresholds({});
  assert.equal(d.escalationMax, 8);
  assert.equal(d.agentsMdMaxChars, 16_000);
  assert.equal(d.mcpHandshakeTimeoutMs, 20_000);
  assert.equal(d.mcpCallTimeoutMs, 60_000);
  assert.equal(d.pwshCaptureMaxBytes, 1_000_000);
  assert.equal(d.precompactKeep, 3);
  assert.equal(d.spillMaxAgeHours, 168);
  assert.equal(d.sandboxTmpMaxAgeHours, 24);
});

test("parseHarnessConfig/resolveThresholds：阶段 B 8 键覆盖生效、非法值逐项忽略并告警", () => {
  const ok = parseHarnessConfig({
    thresholds: {
      escalationMax: 2,
      agentsMdMaxChars: 32_000,
      mcpHandshakeTimeoutMs: 60_000,
      mcpCallTimeoutMs: 180_000,
      pwshCaptureMaxBytes: 4_000_000,
      precompactKeep: 5,
      spillMaxAgeHours: 72,
      sandboxTmpMaxAgeHours: 48,
    },
  });
  assert.equal(ok.warnings.length, 0, "合法全量无告警");
  const eff = resolveThresholds(ok.config.thresholds);
  assert.equal(eff.escalationMax, 2);
  assert.equal(eff.agentsMdMaxChars, 32_000);
  assert.equal(eff.mcpHandshakeTimeoutMs, 60_000);
  assert.equal(eff.mcpCallTimeoutMs, 180_000);
  assert.equal(eff.pwshCaptureMaxBytes, 4_000_000);
  assert.equal(eff.precompactKeep, 5);
  assert.equal(eff.spillMaxAgeHours, 72);
  assert.equal(eff.sandboxTmpMaxAgeHours, 48);

  const bad = parseHarnessConfig({
    thresholds: {
      escalationMax: 0,
      agentsMdMaxChars: 0,
      mcpHandshakeTimeoutMs: 999,
      mcpCallTimeoutMs: 999,
      pwshCaptureMaxBytes: 0,
      precompactKeep: 0,
      spillMaxAgeHours: 0,
      sandboxTmpMaxAgeHours: 0.5,
    },
  });
  for (const k of [
    "escalationMax", "agentsMdMaxChars", "mcpHandshakeTimeoutMs", "mcpCallTimeoutMs",
    "pwshCaptureMaxBytes", "precompactKeep", "spillMaxAgeHours", "sandboxTmpMaxAgeHours",
  ]) {
    assert.equal((bad.config.thresholds as Record<string, number | undefined>)[k], undefined, `${k} 非法应忽略`);
    assert.ok(bad.warnings.some((w) => w.includes(`"${k}"`)), `${k} 应有告警`);
  }
  // 非法全忽略 → 全缺省（fail-closed 到原行为）
  const effBad = resolveThresholds(bad.config.thresholds);
  assert.equal(effBad.escalationMax, 8);
  assert.equal(effBad.precompactKeep, 3);
});

// ---- docs/24：thresholdSchema（前端设置页单一出处）与严格写校验 ----

test("thresholdSchema：35 活跃键全覆盖（无废弃键）、七组不重不漏、def 与 resolveThresholds({}) 同源、清扫两键标 restart", () => {
  const s = thresholdSchema();
  assert.equal(s.entries.length, 35, "活跃键 = 35（25 + 阶段 B 第二批 9 + docs/32 subagentStatusHistoryMax；spillThreshold 废弃不入表）");
  assert.ok(s.entries.every((e) => e.key !== "spillThreshold"), "废弃键不下发");
  assert.deepEqual(s.groups.map((g) => g.key), ["general", "compaction", "pwsh", "subagent", "mcp", "vision", "sweep"]);
  const d = resolveThresholds({});
  const seen = new Set<string>();
  for (const e of s.entries) {
    assert.ok(e.desc && e.hint, `${e.key} 应带说明与范围文案（前端零硬编码的依赖面）`);
    assert.equal(e.def, d[e.key], `${e.key} 缺省值应与 resolveThresholds({}) 同源`);
    assert.ok(s.groups.some((g) => g.key === e.group), `${e.key} 分组 ${e.group} 应在 groups 里`);
    assert.ok(!seen.has(e.key), `${e.key} 不重复`);
    seen.add(e.key);
  }
  // 活跃键 = EffectiveThresholds 全键 - 废弃键（防止加新阈值键忘了进 schema）
  for (const k of Object.keys(d) as Array<keyof typeof d>) {
    if (k === "spillThreshold") continue;
    assert.ok(seen.has(k), `活跃阈值 ${k} 应出现在 schema`);
  }
  const restartKeys = s.entries.filter((e) => e.restart).map((e) => e.key).sort();
  assert.deepEqual(restartKeys, ["sandboxTmpMaxAgeHours", "spillMaxAgeHours"], "仅清扫两键需重启（bootstrap 一次性）");
});

test("validateThresholdsStrict：合法子集通过；未知/废弃/类型/范围非法逐键指名、整体拒绝；pwsh 交叉拒绝", () => {
  const ok = validateThresholdsStrict({ compactionPressure: 0.5, maxToolRounds: 20 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.thresholds, { compactionPressure: 0.5, maxToolRounds: 20 });
  }
  // 非法混合：一个键坏 → 整体拒绝，合法键也不产出（fail-closed，与读的 lenient 相反）
  const bad = validateThresholdsStrict({
    compactionPressure: 0.5,
    subagentMaxConcurrent: 0, // 越界（≥1）
    maxToolRounds: "x",       // 类型错
    nopeKey: 3,               // 未知键
    spillThreshold: 100,      // 废弃键（严格写拒绝，读侧才容忍）
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const keys = bad.errors.map((e) => e.key);
    assert.deepEqual(keys.sort(), ["maxToolRounds", "nopeKey", "spillThreshold", "subagentMaxConcurrent"]);
    assert.ok(bad.errors.every((e) => e.message.length > 0), "每条错误都要有可展示文案");
  }
  // pwsh 交叉：max < timeout 拒绝并指名（lenient 读侧会静默抬升，写侧要即时反馈）
  const cross = validateThresholdsStrict({ pwshTimeoutMs: 120_000, pwshMaxTimeoutMs: 60_000 });
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.errors[0].key, "pwshMaxTimeoutMs");
    assert.ok(cross.errors[0].message.includes("pwshTimeoutMs"));
  }
  // 交叉的另一侧：只改 timeout 超过默认 max（300000）同样拒绝（表单展示生效值，用户会看到）
  const cross2 = validateThresholdsStrict({ pwshTimeoutMs: 400_000 });
  assert.equal(cross2.ok, false, "缺省 max 300000 低于 400000，应提示同步调大");
  // 顶层数据形态错
  for (const raw of [null, [], "x", 3]) assert.equal(validateThresholdsStrict(raw).ok, false);
});

test("THRESHOLD_RULES 与 lenient 读语义一致：rangePass 等价旧谓词（抽样边界值双向验证）", () => {
  // 边界抽样：每类规则取代表键，验证 rangePass 与 parseHarnessConfig 的采纳/忽略一致
  const samples: Array<[string, unknown, boolean]> = [
    ["compactionPressure", 0, false],   // (0,1]：0 开边界外
    ["compactionPressure", 1, true],    // 闭上界
    ["compactionPressure", 1.0001, false],
    ["maxToolRounds", 1, true],         // ≥1 整数
    ["maxToolRounds", 1.5, false],      // 非整数
    ["pwshTimeoutMs", 999.5, false],    // ≥1000，非整数合法但 999.5 越界
    ["pwshTimeoutMs", 1500.5, true],    // 非整数毫秒在 ≥1000 时合法（旧谓词不设 integer）
    ["subagentFollowupContextPct", 100, true],
    ["subagentFollowupContextPct", 101, false],
    ["toolResultMaxChars", 0, false],   // >0
    ["compactionManualKeepTokens", 0, true], // ≥0
    ["spillThreshold", 0, true],        // 废弃键仍按规则解析（lenient 容忍）
  ];
  for (const [key, val, shouldPass] of samples) {
    const { config, warnings } = parseHarnessConfig({ thresholds: { [key]: val } });
    const adopted = config.thresholds[key as keyof typeof config.thresholds] !== undefined;
    assert.equal(adopted, shouldPass, `${key}=${String(val)} 采纳应为 ${shouldPass}`);
    if (!shouldPass) assert.ok(warnings.some((w) => w.includes(key)), `${key} 非法应告警`);
  }
});

// ---- 阶段 B 第二批（docs/21 §2.3 后 9 键）：缺省/覆盖/非法三态 + httpBody 地板值 ----

test("阶段 B 第二批 9 键：缺省值（120s/20s/5MB/4000/200k/60s/300k/32MB/800）与 initConfig 重绑", () => {
  const d = resolveThresholds({});
  assert.equal(d.visionTimeoutMs, 120_000);
  assert.equal(d.providerTestTimeoutMs, 20_000);
  assert.equal(d.textFileMaxBytes, 5 * 1024 * 1024);
  assert.equal(d.readFileDefaultLines, 4_000);
  assert.equal(d.readFileMaxChars, 200_000);
  assert.equal(d.subagentTimeoutMinMs, 60_000);
  assert.equal(d.compactionSummaryMaxChars, 300_000);
  assert.equal(d.httpBodyMaxBytes, 32 * 1024 * 1024);
  assert.equal(d.imageTokenEst, 800);
  try {
    initConfig({ disabledModules: [], thresholds: { readFileDefaultLines: 500, imageTokenEst: 1200, subagentTimeoutMinMs: 30_000 } });
    assert.equal(READ_FILE_DEFAULT_LINES, 500, "read-file 行数 live 重绑");
    assert.equal(IMAGE_TOKEN_EST, 1200, "图片 token 估算 live 重绑");
    assert.equal(SUBAGENT_TIMEOUT_MIN_MS, 30_000, "agent-task 最小超时 live 重绑（const→let 过渡透明）");
  } finally {
    initConfig({ disabledModules: [], thresholds: {} });
  }
});

test("httpBodyMaxBytes 地板值：由 IMAGE_RULES 派生（4×5MB base64 + 1MB 余量）；低于地板 lenient 忽略、严格写拒绝", () => {
  const floor = Math.ceil((IMAGE_RULES.maxCount * IMAGE_RULES.maxBytes * 4) / 3) + 1024 * 1024;
  assert.equal(HTTP_BODY_FLOOR_BYTES, floor, "地板值单一出处派生");
  assert.ok(resolveThresholds({}).httpBodyMaxBytes >= floor, "缺省 32MB 在地板之上");
  // lenient 读：手写文件里的低值逐项忽略+告警（不阻止启动），回落缺省
  const bad = parseHarnessConfig({ thresholds: { httpBodyMaxBytes: 1_000_000 } });
  assert.equal(bad.config.thresholds.httpBodyMaxBytes, undefined, "低于地板被忽略（历史 1MB bug 不可复现）");
  assert.ok(bad.warnings.some((w) => w.includes("httpBodyMaxBytes")));
  // 严格写：UI 提交低值整体 400（即时反馈）
  const strict = validateThresholdsStrict({ httpBodyMaxBytes: 1_000_000 });
  assert.equal(strict.ok, false);
  if (!strict.ok) assert.equal(strict.errors[0].key, "httpBodyMaxBytes");
});

test("阶段 B 第二批 9 键：非法值 lenient 忽略并告警（三态之非法面）", () => {
  const bad = parseHarnessConfig({
    thresholds: {
      visionTimeoutMs: 999,          // ≥1000
      providerTestTimeoutMs: 99,     // ≥1000
      textFileMaxBytes: 0,           // >0
      readFileDefaultLines: 0,       // ≥1
      readFileMaxChars: 0,           // >0
      subagentTimeoutMinMs: 500,     // ≥1000
      compactionSummaryMaxChars: -1, // >0
      imageTokenEst: 0,              // ≥1
    },
  });
  for (const k of [
    "visionTimeoutMs", "providerTestTimeoutMs", "textFileMaxBytes", "readFileDefaultLines",
    "readFileMaxChars", "subagentTimeoutMinMs", "compactionSummaryMaxChars", "imageTokenEst",
  ]) {
    assert.equal((bad.config.thresholds as Record<string, number | undefined>)[k], undefined, `${k} 非法应忽略`);
    assert.ok(bad.warnings.some((w) => w.includes(`"${k}"`)), `${k} 应有告警`);
  }
});
