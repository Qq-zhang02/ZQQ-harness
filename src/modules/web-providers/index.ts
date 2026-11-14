/**
 * web.providers 模块（模块化架构重构 §4.10）：/api/providers/* 六个端点。
 * 路由注册进 ctx.routes；格式白名单查 ctx.providerFormats（P4 注册制），
 * 会话切换提供方经 ctx.sessionHost.applyProvider。提供方文件本体由壳持有
 * （session 装配也要读它），模块经 host.providerFile() 读写。
 */
import {
  createProvider,
  newProviderId,
  normalizeEffort,
  saveProviderFile,
  type ProviderConfig,
} from "../../providers/store.ts";
import { DEFAULT_CONTEXT_LENGTH, PROVIDER_TEST_TIMEOUT_MS } from "../../config.ts";
import type { HarnessModule } from "../../core/module.ts";

export const webProviders: HarnessModule = {
  name: "web.providers",
  setup(ctx) {
    const host = ctx.sessionHost!;

    ctx.routes.register({
      method: "GET",
      path: "/api/providers",
      handler(r) {
        const pf = host.providerFile();
        // 提供方列表（含 apiKey，供编辑；本地单用户服务）+ 视觉模型设置（docs/10 R3）
        r.json(200, {
          active: pf.data.active,
          providers: pf.data.providers,
          ...(pf.data.visionProvider !== undefined ? { visionProvider: pf.data.visionProvider } : {}),
        });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/providers/save",
      async handler(r) {
        const body = await r.body();
        const p = body.provider as Partial<ProviderConfig> | undefined;
        const format = p?.format as string | undefined;
        const contextLength = Number(p?.contextLength);
        const maxTokens = p?.maxTokens === null || p?.maxTokens === undefined ? null : Number(p.maxTokens);
        const effortRaw = String(p?.effort ?? "");
        if (
          !p ||
          !String(p.name ?? "").trim() ||
          !String(p.baseUrl ?? "").trim() ||
          !String(p.model ?? "").trim() ||
          !format ||
          ctx.providerFormats.get(format) === undefined
        ) {
          r.json(400, { error: "名称、接口格式、地址、模型均为必填" });
          return;
        }
        if (!(Number.isFinite(contextLength) && contextLength > 0)) {
          r.json(400, { error: "上下文长度必须为正数" });
          return;
        }
        if (maxTokens !== null && !(Number.isFinite(maxTokens) && maxTokens > 0)) {
          r.json(400, { error: "输出上限必须为正数或留空" });
          return;
        }
        const pf = host.providerFile();
        const existingId = String(p.id ?? "");
        const knownId = existingId && pf.data.providers.some((x) => x.id === existingId);
        const id = knownId ? existingId : newProviderId(String(p.name), pf.data.providers.map((x) => x.id));
        // 档位缺省回退与文件加载一致：deepseek 保持 high，其他 default（不添加思考参数）
        const effort = normalizeEffort(effortRaw) ?? (id === "deepseek" ? "high" : "default");
        const cfg: ProviderConfig = {
          id,
          name: String(p.name).trim(),
          format,
          baseUrl: String(p.baseUrl).trim(),
          apiKey: String(p.apiKey ?? "").trim(),
          model: String(p.model).trim(),
          effort,
          contextLength: Math.round(contextLength),
          maxTokens,
          ...(p.vision === true ? { vision: true } : {}), // docs/10 R3：仅显式勾选才带（空不写）
        };
        const idx = pf.data.providers.findIndex((x) => x.id === id);
        if (idx >= 0) pf.data.providers[idx] = cfg;
        else pf.data.providers.push(cfg);
        // 编辑的是某会话正在用的提供方 → 空闲会话立即生效；运行中的会话下一轮生效
        for (const rt of host.runtimes().values()) {
          if (rt.providerId === id && !rt.busy) host.applyProvider(rt, cfg);
        }
        saveProviderFile(pf);
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, { active: pf.data.active, providers: pf.data.providers });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/providers/activate",
      async handler(r) {
        const body = await r.body();
        const rt = host.viewRt();
        if (rt.busy) {
          r.json(409, { error: "该对话任务运行中无法切换提供方" });
          return;
        }
        const pf = host.providerFile();
        const cfg = pf.data.providers.find((x) => x.id === String(body.id ?? ""));
        if (!cfg) {
          r.json(404, { error: "提供方不存在" });
          return;
        }
        // 「使用」只切换当前查看对话的模型（按对话记录）；不改新对话的默认值
        rt.providerId = cfg.id;
        host.applyProvider(rt, cfg);
        host.persistSession(rt); // 立刻记录到当前对话
        host.broadcast("state", host.currentState(rt));
        host.broadcast("sessions", host.sessionsPayload());
        r.json(200, { active: pf.data.active, providers: pf.data.providers });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/providers/set-default",
      async handler(r) {
        const body = await r.body();
        const pf = host.providerFile();
        const cfg = pf.data.providers.find((x) => x.id === String(body.id ?? ""));
        if (!cfg) {
          r.json(404, { error: "提供方不存在" });
          return;
        }
        // 「设为默认」只影响新对话；不改变各对话正在用的模型
        pf.data.active = cfg.id;
        saveProviderFile(pf);
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, { active: pf.data.active, providers: pf.data.providers });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/providers/delete",
      async handler(r) {
        const body = await r.body();
        const pf = host.providerFile();
        const id = String(body.id ?? "");
        const idx = pf.data.providers.findIndex((x) => x.id === id);
        if (idx < 0) {
          r.json(404, { error: "提供方不存在" });
          return;
        }
        if (pf.data.providers.length <= 1) {
          r.json(400, { error: "至少保留一个提供方" });
          return;
        }
        const busyUser = [...host.runtimes().values()].find((rt) => rt.providerId === id && rt.busy);
        if (busyUser) {
          r.json(409, { error: "有正在运行的对话正在使用该提供方，无法删除" });
          return;
        }
        pf.data.providers.splice(idx, 1);
        // 删除的是某空闲会话正在用的提供方 → 该会话回退到默认。
        // 默认值先修好再回退：保证 rt.providerId 一定指向存活的提供方
        //（原实现先回退后修默认，删除 active 时会短暂留下指向已删 id 的 providerId）
        if (pf.data.active === id) pf.data.active = pf.data.providers[0].id;
        for (const rt of host.runtimes().values()) {
          if (rt.providerId === id) {
            rt.providerId = pf.data.active;
            host.applyProvider(rt, pf.data.providers.find((x) => x.id === pf.data.active)!);
            host.persistSession(rt);
          }
        }
        saveProviderFile(pf);
        host.broadcast("state", host.currentState(host.viewRt()));
        r.json(200, { active: pf.data.active, providers: pf.data.providers });
      },
    });

    ctx.routes.register({
      method: "POST",
      path: "/api/providers/test",
      async handler(r) {
        const body = await r.body();
        const p = body.provider as Partial<ProviderConfig> | undefined;
        let cfg: ProviderConfig | undefined;
        if (p && String(p.baseUrl ?? "").trim() && String(p.model ?? "").trim()) {
          // 格式查注册表：未注册 = 校验失败（不再静默回退 openai）
          const fmtDef = ctx.providerFormats.get(String(p.format ?? ""));
          if (!fmtDef) {
            r.json(400, { error: "不支持的接口格式" });
            return;
          }
          const effortRaw = String(p.effort ?? "");
          cfg = {
            id: String(p.id ?? "test"),
            name: String(p.name ?? "test"),
            format: fmtDef.format,
            baseUrl: String(p.baseUrl).trim(),
            apiKey: String(p.apiKey ?? "").trim(),
            model: String(p.model).trim(),
            effort: normalizeEffort(effortRaw) ?? fmtDef.defaultEffort(),
            // docs/21 §2.2-②：缺省经 config.ts 单一出处（harness.json 可覆盖），不再重复写死 1M
            contextLength: Number(p.contextLength) > 0 ? Number(p.contextLength) : DEFAULT_CONTEXT_LENGTH,
            maxTokens: null,
          };
        } else {
          cfg = host.providerFile().data.providers.find((x) => x.id === String(body.id ?? ""));
        }
        if (!cfg) {
          r.json(400, { error: "缺少可测试的提供方配置" });
          return;
        }
        try {
          const prov = createProvider(cfg, ctx.providerFormats);
          // 按提供方自己的思考档位测试（default=不添加思考参数），验证的就是真实配置
          const res = await prov.chat({
            messages: [{ role: "user", content: "请只回复两个字：收到" }],
            signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS), // 阈值键 providerTestTimeoutMs（热重绑）
          });
          r.json(200, { ok: res.finishReason !== null || res.content.trim().length > 0, sample: res.content.trim().slice(0, 60) });
        } catch (e) {
          r.json(200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
    });
    // docs/10 R3：设置/清空视觉模型（view_image 工具用的提供方）。body.id 为空/显式 null
    // = 清空；id 必须指向存在且勾选了视觉能力的提供方。
    ctx.routes.register({
      method: "POST",
      path: "/api/providers/vision-provider",
      async handler(r) {
        const body = await r.body();
        const pf = host.providerFile();
        const raw = body.id;
        if (raw === null || raw === undefined || String(raw).trim() === "") {
          delete pf.data.visionProvider;
          saveProviderFile(pf);
          r.json(200, { ok: true, visionProvider: null });
          return;
        }
        const cfg = pf.data.providers.find((x) => x.id === String(raw));
        if (!cfg) {
          r.json(404, { error: "提供方不存在" });
          return;
        }
        if (cfg.vision !== true) {
          r.json(400, { error: "该提供方未勾选「视觉能力」——先在表单里勾选保存" });
          return;
        }
        pf.data.visionProvider = cfg.id;
        saveProviderFile(pf);
        r.json(200, { ok: true, visionProvider: cfg.id });
      },
    });
  },
};
