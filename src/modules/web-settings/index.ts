/**
 * web.settings 模块（docs/24）：/api/settings/harness 读 + /save 写——运行阈值可视化编辑。
 * 读 = 当前生效值 + schema（config.ts 单一出处：范围/说明/默认值/分组/重启标注）；
 * 写 = fail-closed 严格校验（validateThresholdsStrict，任一键非法整体 400 拒绝、不落盘）→
 * 原子写 harness.json（writeTextAtomic；写回纯 JSON，文件原有注释会被移除——非 bug，
 * 解析两种形态都接受）→ initConfig(cfg) 热应用（live binding，/api/meta 等运行时读取点
 * 下一次请求即见新值；schema 标 restart 的清扫类键仍需重启，模块装配/disabledModules 一次性）。
 * 全局文件不经会话（无需 sessionHost）：路径取 ctx.paths.userDir + USER_DIR_LAYOUT——
 * bootstrap 传真实用户目录（与 config.harnessFilePath() 同一文件），测试传临时目录。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HARNESS_CONFIG,
  initConfig,
  resolveThresholds,
  thresholdSchema,
  validateThresholdsStrict,
} from "../../config.ts";
import { USER_DIR_LAYOUT } from "../../userdir.ts";
import { writeTextAtomic } from "../../core/file-tools.ts";
import type { HarnessModule } from "../../core/module.ts";

export const webSettings: HarnessModule = {
  name: "web.settings",
  setup(ctx) {
    const harnessFile = () => join(ctx.paths.userDir, USER_DIR_LAYOUT.harnessFile);

    ctx.routes.register({
      method: "GET",
      path: "/api/settings/harness",
      handler(r) {
        r.json(200, {
          config: HARNESS_CONFIG, // 文件级覆盖项 + disabledModules（只读展示）
          effective: resolveThresholds(HARNESS_CONFIG.thresholds), // 表单初值 = 生效值
          schema: thresholdSchema(),
          fileExists: existsSync(harnessFile()),
        });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/settings/harness/save",
      async handler(r) {
        const body = await r.body();
        const v = validateThresholdsStrict(body.thresholds);
        if (!v.ok) {
          // 任一键非法整体拒绝（fail-closed，与读的 lenient 语义相反）：指名键 + 合法范围
          r.json(400, { error: v.errors[0]!.message, errors: v.errors });
          return;
        }
        // thresholds 整体替换（表单加载全量、提交全量）；disabledModules 原样透传——
        // 首版只读展示（高危：禁 web.* 或被依赖模块 → 功能消失/启动失败，开放需强警告+重启标注）
        const cfg = { disabledModules: HARNESS_CONFIG.disabledModules, thresholds: v.thresholds };
        writeTextAtomic(harnessFile(), JSON.stringify(cfg, null, 2) + "\n");
        initConfig(cfg); // 热应用唯一出口（哨兵锁定）：全部消费点 live binding 见新值
        r.json(200, { ok: true, config: cfg, effective: resolveThresholds(cfg.thresholds) });
      },
    });
  },
};
