import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { thresholdSchema } from "./config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 防漂移（docs/40 阶段三）：README 是用户调阈值的入口文档，键清单以 THRESHOLD_RULES
 *  为唯一出处逐键校验——历史上 README 曾落后实际键数（写 34、实际 35 活跃），此测试
 *  锁定「README harness.json 示例必须覆盖 schema 全部活跃键」，新增键漏登记即红。 */
test("防漂移（docs/40）：README 阈值段覆盖全部活跃阈值键，键数口径不过期", () => {
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
  const schema = thresholdSchema();
  const missing = schema.entries.filter((e) => !readme.includes(`"${e.key}"`));
  assert.equal(
    missing.length,
    0,
    `README 阈值段（harness.json 示例块）缺键：${missing.map((m) => m.key).join("、")}——新增阈值键必须同步 README 示例与说明段（三件套惯例）`,
  );
  // 历史漂移实例的回归哨兵：总数字数文案过期即红（当前 38 活跃键；三十七 = docs/42 初版口径，修订后 +1）
  for (const stale of ["三十四个运行阈值", "三十个运行阈值", "三十七个运行阈值"]) {
    assert.ok(!readme.includes(stale), `README 阈值键数口径过期：「${stale}」（当前 ${schema.entries.length} 活跃键）`);
  }
});
