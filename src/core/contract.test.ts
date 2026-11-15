/**
 * 契约测试与防回归网（模块化架构重构 §7 P0）。
 * 四类跨模块/跨端契约，全部只读源码与快照，无行为改动：
 *  a) SSE 事件名三端一致：core/events.ts ↔ web/server.ts ↔ index.html（正则双向提取比对）；
 *  b) 系统提示 golden 快照：固定输入逐字节锁定（P2 section 化时更新快照 = 显式决定）；
 *  c) 扩展成本哨兵：以特征串锁定"改动收敛进模块"的完成状态，各阶段完成时逐个
 *     把 test.skip 改回 test 启用（启用前保持 skip，因为特征串当前仍在源码中）；
 *  d) import 图哨兵：modules/** 内禁止跨模块目录 import（共享下沉 core 或经 ctx 交换）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SSE_EVENTS } from "./events.ts";
import { thresholdSchema } from "../config.ts";
import { assembleSystemPrompt, BUILTIN_PROMPT_SECTIONS } from "./sections.ts";
import { Registry } from "./registry.ts";
import type { SectionContext } from "./types.ts";
import type { SkillInfo } from "./skills.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = join(HERE, "..", "web", "server.ts");
const AGENT_TS = join(HERE, "..", "agent.ts");
const INDEX_HTML = join(HERE, "..", "web", "public", "index.html");
const MODULES_DIR = resolve(HERE, "..", "modules");

const serverSrc = readFileSync(SERVER_TS, "utf8");
const agentSrc = readFileSync(AGENT_TS, "utf8");
const html = readFileSync(INDEX_HTML, "utf8");

// ---------- a) SSE 事件名契约 ----------

test("SSE 契约：后端（server 瘦壳 + web + modules）广播/发送的事件名与 core/events.ts 完全一致", () => {
  // P6 起事件广播分散在瘦壳（server/sse）、web 壳文件（session-runtime/lifecycle）与
  // web-* 模块（经 host.broadcast）——扫描三处并集，仍须与 SSE_EVENTS 一一对应
  const files = [...new Set([...listTsFiles(join(HERE, "..", "web")), ...listTsFiles(MODULES_DIR)])];
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
  // P2 起事件名经 SSE_EVENTS 常量引用（兼容字符串字面量形式）；只认这两种实参形态
  const used = new Set(
    [...src.matchAll(/(?:broadcast|send)\(\s*(?:res\s*,\s*)?(?:SSE_EVENTS\.([A-Za-z]+)|"([A-Za-z]+)")/g)]
      .map((m) => m[1] ?? m[2]),
  );
  assert.deepEqual([...used].sort(), Object.values(SSE_EVENTS).slice().sort());
});

test("SSE 契约：index.html 的 SSE_HANDLERS 表监听的事件名与 core/events.ts 完全一致", () => {
  // P7 起监听由表驱动注册（for + addEventListener），从表字面量提取方法键
  const start = html.indexOf("const SSE_HANDLERS = {");
  const end = html.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, "index.html 中找不到 SSE_HANDLERS 表（前端重构后请同步更新本测试）");
  const keys = [...html.slice(start, end).matchAll(/\n  ([A-Za-z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.values(SSE_EVENTS).slice().sort());
});

test("SSE 契约：dispatchBuffered 缓冲重放复用 SSE_HANDLERS（可重放事件 ⊆ SSE_EVENTS 由表键锁定）", () => {
  const fnStart = html.indexOf("function dispatchBuffered");
  const fnEnd = html.indexOf("async function refreshSnapshot");
  assert.ok(fnStart >= 0 && fnEnd > fnStart, "index.html 中找不到 dispatchBuffered 定位锚点（前端重构后请同步更新本测试）");
  const body = html.slice(fnStart, fnEnd);
  assert.ok(
    body.includes("SSE_HANDLERS[item.ev]") && !/case "/.test(body),
    "dispatchBuffered 应查 SSE_HANDLERS 表分发（§4.11：与实时路径共用处理表，不另写 switch）",
  );
});

// ---------- b) 系统提示 golden 快照（P2 section 化，快照已按设计显式更新） ----------
// P2 预期字节差异（唯一一处）：工具行由写死变生成——
//   旧：`可用工具：run_pwsh —— 在本机 PowerShell 7 中执行命令，工作目录为工作区 ${root}。`
//   新：`可用工具：run_pwsh —— ……工作目录为工作区根目录；load_skill —— ……。`
// （工作区绝对路径仍由 base 段安全规则行给出；load_skill 因声明 summary 而新入提示）
// 之后任何字节变化都必须更新本快照 = 显式决定，并在冒烟中确认模型行为。

const ROOT = "F:\\ws\\demo";

const baseSection = [
  "你是 ZQQ-harness，一个运行在用户 Windows 终端里的 agent 助手。",
  `安全规则：默认只允许在 ${ROOT} 工作区内创建、修改、删除文件；涉及工作区外的操作会被系统拦截并交由用户批准。文件操作请尽量使用相对路径。`,
  "执行命令时注意控制输出量（用 Select-Object -First、Where-Object 等过滤），避免一次输出过多内容。",
  "请用中文与用户交流，简洁说明你做了什么。",
].join("\n");

const fullSkills: SkillInfo[] = [
  { name: "commit-helper", description: "提交规范", path: "F:\\ws\\demo\\skills\\commit-helper\\SKILL.md", source: "workspace" },
  { name: "pdf-export", description: "", path: "F:\\ws\\demo\\skills\\pdf-export\\SKILL.md", source: "global" },
];

const fullContext: SectionContext = {
  workspaceRoot: ROOT,
  skills: fullSkills,
  mcpInstructions: "\n  使用 filesystem 工具时注意路径转义。  \n", // 带首尾空白：锁定 trim 行为
  globalAgentsMd: "全局规则：保持谨慎。\n",
  workspaceAgentsMd: "工作区规则：先测试后提交。\n",
  toolDocs: [
    // P3 起工具行按名字排序（toolDocsOf 显式 sort，与模块登记顺序无关）
    "load_skill —— 加载某个技能的完整说明（SKILL.md 全文）",
    "run_pwsh —— 在本机 PowerShell 7 中执行命令，工作目录为工作区根目录",
  ],
};

test("golden 快照：系统提示全量输入（base/工具/技能/MCP/全局/工作区六段按序装配）", () => {
  const expected = [
    baseSection,
    "可用工具：load_skill —— 加载某个技能的完整说明（SKILL.md 全文）；run_pwsh —— 在本机 PowerShell 7 中执行命令，工作目录为工作区根目录。",
    [
      "# 可用技能",
      "下列技能与当前任务相关时，先调用 load_skill 工具加载完整说明，再按说明执行：",
      "- commit-helper：提交规范",
      "- pdf-export：（无描述）",
    ].join("\n"),
    [
      "# MCP 服务器使用说明",
      "以下是已连接 MCP 服务器提供的使用说明，调用其工具时遵守：",
      "",
      "使用 filesystem 工具时注意路径转义。",
    ].join("\n"),
    [
      "# 全局指令（~/.ZQQ-harness/AGENTS.md）",
      "以下是用户全局 AGENTS.md 的内容，对所有工作区生效；与工作区指令冲突时以工作区指令为准：",
      "",
      "全局规则：保持谨慎。",
    ].join("\n"),
    [
      "# 工作区指令（AGENTS.md）",
      "以下是该工作区 AGENTS.md 的内容，作为在此工作区工作时的附加规则遵守：",
      "",
      "工作区规则：先测试后提交。",
    ].join("\n"),
  ].join("\n\n");
  assert.equal(assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, fullContext), expected);
});

test("golden 快照：最小输入（仅 base 段；空技能/工具与纯空白可选段不注入）", () => {
  const minimal: SectionContext = {
    workspaceRoot: ROOT,
    skills: [],
    mcpInstructions: "  \n",
    globalAgentsMd: null,
    workspaceAgentsMd: "  \n\t",
    toolDocs: [],
  };
  assert.equal(assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, minimal), baseSection);
});

// ---------- b2) coordinator 分支（docs/5 SA2：显式新增的 golden 快照；SA3 补并行纪律、docs/7 W2-S 补进度干预、docs/9 补可复用纪律 = 显式更新） ----------

/** coordinator base 段（docs/5 §8 草案；SA3/docs/7/docs/9/docs/11/docs/14/docs/16/docs/17 修订；改文案 = 显式更新本快照。
 *  docs/14：删「子代理上下文开销」条——用量与预警随报告自动附带，提示词不再预先描述。
 *  docs/15：agent_tasks 退役——并行 = 同一轮多个 agent_task（工具循环并行执行），toolDocs 五件。
 *  docs/16：派发非阻塞化——派发即返回回执、报告经自动送达消息到达；并行纪律改写为派发纪律
 *  并新增报告处理纪律。
 *  docs/17：可复用子代理重启后自动唤醒（followup 从存档复活，同 subId）；新增「接续上下文」
 *  条目（read_archive：重派时让新 worker 读过程存档/主对话记录）。 */
const coordinatorBase = [
  "你是 ZQQ-harness 的任务协调者（coordinator），负责大型项目的总体把控。",
  "你自己没有任何直接工具——读写文件、运行命令、查询资料全部由子代理（worker）完成；你的全部工具与精确语义见下方「子代理工具参考」。",
  `当前工作区根：${ROOT}（任务书中的路径一律用相对路径）。`,
  "职责与工作方式：",
  "- 先规划再派发：把大任务分解为边界清晰、互不重叠的子任务（按目录/模块/主题划分），说明各自负责范围（scope）。",
  "- 任务书必须自包含：子代理看不到本对话历史。每份任务书写清：目标、背景与约束、涉及的路径、期望产出（文件落点 + 报告结构）。",
  "- 派发纪律（docs/16）：agent_task / agent_followup 派发即返回「已派发」回执、不等待完成；每个子代理的结算（完成/失败/打断/归档）" +
    "会以「[子代理任务报告 · 自动送达]」开头的消息按完成顺序自动送达你（你忙碌时积压的报告在轮末合并送达）——像用户消息一样随时到达，无需轮询。" +
    "互不依赖、写入范围不重叠的任务在同一轮里发多个 agent_task 即并行派出（各自给 scope 划定写入范围）；有依赖的任务等前置报告送达后再派。" +
    "超出并发上限（subagentMaxConcurrent，默认 3）的派发被立即拒绝（不排队）——余下的等报告送达、并发腾出后再派。",
  "- 报告处理纪律：收到部分报告时只向用户简报进度或按需干预（追派/打断/归档），不要提前汇总尚未完成的部分；全部报告到齐后再整合交付。" +
    "等待其余报告时直接简短收尾即可（说明在等什么），报告送达会自动开启你的下一轮。",
  "- 可复用子代理（docs/9）：同一专业方向要跨多次任务延续时，agent_task 带 reusable=true 派出——它完成后保留全部上下文待命，" +
    "后续用 agent_followup 按 name/subId 追加任务（任务书可引用之前的进展）；确定不再使用时用 archive_subagent 归档（归档后只读不可再派）。" +
    "独立的一次性任务用缺省形态（用完即自动归档）。服务重启后待命实例不在线——agent_followup 会自动从过程存档唤醒它（历史延续，同 subId），无需重新派发。",
  "- 接续上下文（docs/17）：需要接续已归档（不可再派）子代理的工作时，用 agent_task 重新派发，并在任务书里明确指示" +
    "「先用 read_archive（subId=N）读过程存档，再继续」——read_archive 会把该子代理的完整过程转成可读文本注入新 worker 的上下文" +
    "（subId 见报告里的 [[过程档案#N]] 标注）；它也可传 sessionId 读另一段主对话的完整记录。",
  "- 子代理异常变动会自动通知（docs/11/16）：界面打断/归档等你看不见的变动会以「[子代理状态 · 自动送达]」消息告知你；每个任务的最终结果" +
    "（含失败与归档状态）以「[子代理任务报告 · 自动送达]」消息按完成顺序送达。派发回执与这些送达消息是感知子代理状态的唯一事实源。",
  "- 冲突预防：绝不派两个子代理写同一个文件；发现产出矛盾时自己裁决，或派一个验证型子代理对比后报告。",
  "- 汇总与交付：整合各子代理报告为最终答复；对用户如实呈现（谁做了什么、成败、产出物路径）。",
  "- 进度持久化：维护工作区根的 TASKS.md（由子代理代写）记录任务清单与状态——它在你被压缩后是你恢复全局视图的唯一依据。",
  "子代理工具参考（语义精确，严格按此使用）：",
  "- agent_task：派出一个子代理，立即返回「已派发」回执（非阻塞，不等待完成）。description（一句话摘要）与 task（自包含任务书）必填；name 可选短名（审批卡/报告/送达消息标注用）；" +
    "scope 可选写入分区（相对路径前缀数组）；reusable=true 派出可复用形态；timeoutMs 可选超时（≥60000 毫秒）。同一轮发多个本调用即并行派出（见派发纪律）。",
  "- agent_followup：向空闲待命的可复用子代理追加新任务，立即返回「已派发」回执（非阻塞，不等待完成）。按 name 或 subId 寻址（同名的可复用子代理有多个时必须用 subId）；" +
    "它保留之前全部任务的上下文，任务书可引用既有进展，但新目标与期望产出仍要写清。",
  "- stop_subagent：打断一个运行中子代理的当前任务。语义：**立即中止**——进行中的 LLM 请求与工具执行（含 pwsh 进程）当场终止，" +
    "已完成的进度保留在历史、半截内容作废。没有「恢复」：一次性子代理随之归档；可复用子代理转空闲待命（保留上下文），" +
    "继续该方向的工作用 agent_followup 发新任务书。按 name（同名者全部生效）或 subId 指定；空闲待命的子代理没有可打断的对象。",
  "- archive_subagent：归档一个可复用子代理——归档后仅可查看过程存档、不可再派任务。空闲待命时立即归档；" +
    "执行中归档会先中止其当前任务。一次性子代理任务结束即自动归档，无需（也不支持）本工具。",
  "执行纪律（重要）：",
  "- 用户要求停止/归档子代理时，必须真正调用对应工具执行，再如实转述工具返回的文本。" +
    "绝不要只在回复文字里声称「已停止/已执行」，也不要输出任何形如命令或工具调用的纯文本冒充执行——没有真正调用工具就等于没有执行，那是在欺骗用户。",
  "- 任务运行中用户的插话会以「即时应答」送达你：该窗口内只有 stop_subagent / archive_subagent 两件工具可真正执行；" +
    "派发新任务、追问进度等其余诉求等当前任务返回后再处理（插话内容都会保留在对话历史里，不会丢）。",
  "- 工具返回错误（找不到目标/状态不符等）时如实向用户报告原因，不要假装成功；工具文案里附的活动子代理清单可用来核对目标。",
  "请用中文与用户交流，简洁说明你做了什么。",
].join("\n");

test("golden 快照：coordinator 输入（base 分支新文案；skills/mcp 段不注入；AGENTS.md 两段 docs/20 起不注入——移入 web 层「子代理系统提示词说明」段）", () => {
  // 协调者 registry 四件（docs/18 起 pause/resume 由 stop_subagent 一件取代），toolDocs 即其 summary 行（toolDocsOf 按名排序）
  const sc: SectionContext = {
    ...fullContext,
    sessionKind: "coordinator",
    toolDocs: [
      "agent_followup —— 向一个空闲待命的可复用子代理追加新任务，立即返回派发回执（非阻塞；它保留之前任务的全部上下文，按 name 或 subId 寻址）",
      "agent_task —— 派出一个子代理独立完成一项任务，立即返回派发回执（非阻塞；报告完成后自动送达。reusable=true 可复用；同一轮发多个本调用即并行派发，协调者核心派发工具）",
      "archive_subagent —— 归档一个可复用子代理（归档后仅可查看存档，不可再派任务；执行中归档会中止当前任务）",
      "stop_subagent —— 打断一个运行中子代理的当前任务（立即中止请求/工具执行；一次性随之归档、可复用转空闲待命，无恢复机制；按 name 或 subId 匹配）",
    ],
  };
  const expected = [
    coordinatorBase,
    "可用工具：agent_followup —— 向一个空闲待命的可复用子代理追加新任务，立即返回派发回执（非阻塞；它保留之前任务的全部上下文，按 name 或 subId 寻址）；" +
      "agent_task —— 派出一个子代理独立完成一项任务，立即返回派发回执（非阻塞；报告完成后自动送达。reusable=true 可复用；同一轮发多个本调用即并行派发，协调者核心派发工具）；" +
      "archive_subagent —— 归档一个可复用子代理（归档后仅可查看存档，不可再派任务；执行中归档会中止当前任务）；" +
      "stop_subagent —— 打断一个运行中子代理的当前任务（立即中止请求/工具执行；一次性随之归档、可复用转空闲待命，无恢复机制；按 name 或 subId 匹配）。",
  ].join("\n\n");
  assert.equal(assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, sc), expected);
});

// ---------- b3) vision 变体（docs/12 R2：会话提供方有视觉 → base 段注入图片直看指引；缺省快照零改动） ----------

/** docs/12 R2 的两条视觉指引行（改文案 = 显式更新本快照） */
const visionLineWorker =
  "图片输入：消息可能直接携带图片（与文字一起的多模态输入）——你已直接看到原图，优先用自己的视觉能力分析作答，不要声称看不到。" +
  "view_image 工具仅用于读取工作区磁盘上的图片文件（读取时同样用你自身的视觉）；不要对消息中已携带的图片再调用它。";
const visionLineCoordinator =
  "图片输入：用户消息可能直接携带图片（与文字一起的多模态输入）——你已直接看到原图，直接分析并据此回应即可，不要声称看不到" +
  "（子代理需要看磁盘上的图片文件时会自行使用 view_image）。";

test("golden 快照：vision=true 注入图片直看指引（docs/12 R2）——normal 插入 base 段倒数第二行、coordinator 尾附一行；vision:false/缺省字节不变", () => {
  // normal：视觉行插在「请用中文」之前，base 之外的段与缺省版逐字节一致
  const baseVision = [
    "你是 ZQQ-harness，一个运行在用户 Windows 终端里的 agent 助手。",
    `安全规则：默认只允许在 ${ROOT} 工作区内创建、修改、删除文件；涉及工作区外的操作会被系统拦截并交由用户批准。文件操作请尽量使用相对路径。`,
    "执行命令时注意控制输出量（用 Select-Object -First、Where-Object 等过滤），避免一次输出过多内容。",
    visionLineWorker,
    "请用中文与用户交流，简洁说明你做了什么。",
  ].join("\n");
  const without = assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, fullContext);
  assert.equal(assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, { ...fullContext, vision: true }), baseVision + without.slice(baseSection.length));
  assert.equal(assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, { ...fullContext, vision: false }), without); // 显式 false = 缺省
  // coordinator：coordinatorBase 尾附协调者版指引（无 view_image 工具——只说明直看与分工），其余段不变
  const coordSc: SectionContext = {
    ...fullContext,
    sessionKind: "coordinator",
    toolDocs: [
      "agent_followup —— 向一个空闲待命的可复用子代理追加新任务，立即返回派发回执（非阻塞；它保留之前任务的全部上下文，按 name 或 subId 寻址）",
      "agent_task —— 派出一个子代理独立完成一项任务，立即返回派发回执（非阻塞；报告完成后自动送达。reusable=true 可复用；同一轮发多个本调用即并行派发，协调者核心派发工具）",
      "archive_subagent —— 归档一个可复用子代理（归档后仅可查看存档，不可再派任务；执行中归档会中止当前任务）",
      "stop_subagent —— 打断一个运行中子代理的当前任务（立即中止请求/工具执行；一次性随之归档、可复用转空闲待命，无恢复机制；按 name 或 subId 匹配）",
    ],
  };
  const coord0 = assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, coordSc);
  const coordV = assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, { ...coordSc, vision: true });
  assert.equal(coordV, coordinatorBase + "\n" + visionLineCoordinator + coord0.slice(coordinatorBase.length));
});

test("sections 分支：sessionKind=normal 与缺省（不带字段）逐字节一致——normal 快照零改动", () => {
  assert.equal(
    assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, { ...fullContext, sessionKind: "normal" }),
    assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, fullContext),
  );
});

test("sections 分支：coordinator 下 skills/mcp 段返回 null（无对应工具，清单与说明不注入）", () => {
  const byName = Object.fromEntries(BUILTIN_PROMPT_SECTIONS.map((s) => [s.name, s]));
  const coord = { ...fullContext, sessionKind: "coordinator" } as SectionContext;
  assert.equal(byName.skills!.render(coord), null);
  assert.equal(byName.mcp!.render(coord), null);
  // normal 侧不受影响：技能清单照常渲染
  assert.ok((byName.skills!.render(fullContext) ?? "").includes("commit-helper"));
});

test("内置 sections：六段名字与 order 固定且唯一，装配与输入顺序无关", () => {
  const byName = Object.fromEntries(BUILTIN_PROMPT_SECTIONS.map((s) => [s.name, s.order]));
  assert.deepEqual(byName, {
    base: 0,
    tools: 10,
    skills: 20,
    mcp: 30,
    globalAgentsMd: 40,
    workspaceAgentsMd: 50,
  });
  assert.equal(
    assembleSystemPrompt([...BUILTIN_PROMPT_SECTIONS].reverse(), fullContext),
    assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, fullContext),
  );
});

test("Registry：重复注册抛错、disposer 可注销、all() 按名字稳定排序", () => {
  const r = new Registry<{ name: string }, "name">("name");
  const d1 = r.register({ name: "b" });
  r.register({ name: "a" });
  assert.throws(() => r.register({ name: "b" }), /重复注册/);
  assert.deepEqual(r.names(), ["a", "b"]);
  assert.equal(r.require("a").name, "a");
  assert.throws(() => r.require("zz"), /不存在/);
  d1();
  assert.deepEqual(r.names(), ["a"]);
  assert.equal(r.get("b"), undefined);
});

// ---------- c) 扩展成本哨兵（各阶段完成时把 test.skip 改回 test 启用） ----------

test("哨兵（P3 已启用）：server.ts 不再写死注册系统工具", () => {
  assert.ok(!serverSrc.includes("pwshTool") && !serverSrc.includes("run_pwsh"),
    "系统工具应经 ctx.tools 注册表装配（modules/tools/*），server.ts 不再出现具体工具符号");
});

test("哨兵（P4 已启用）：agent.ts 不再按 provider.name 字符串特判", () => {
  assert.ok(!agentSrc.includes('"anthropic"') && !agentSrc.includes('"openai"'),
    "思考回传口径应改为 LLMProvider.thinkingPassback 能力声明（modules/providers/* 实现）");
});

test("哨兵（P5 已启用）：server.ts 不再写死技能目录数组与沙箱后端选型", () => {
  assert.ok(!serverSrc.includes('source: "workspace"'), "技能目录应来自 ctx.skillSources 注册表");
  assert.ok(!serverSrc.includes("WindowsAclRunner"), "沙箱后端应来自 ctx.sandboxBackends 选型");
});

test("哨兵（P6 已启用；docs/25 DT0 调整 250→270）：server.ts 瘦壳 ≤270 行", () => {
  const lines = serverSrc.split("\n").length;
  assert.ok(lines <= 270, `server.ts 应只剩 bootstrap/静态/SSE/meta/分发/进程生命周期（DT0 优雅停机），当前 ${lines} 行`);
});

test("哨兵（P8 已启用；docs/23 D2 改显式装载）：阈值常量经 initConfig() 重绑的生效值，导入期不读 harness.json", () => {
  const configSrc = readFileSync(join(HERE, "..", "config.ts"), "utf8");
  assert.ok(
    /export function initConfig\(cfg: HarnessConfig = loadHarnessConfig\(\)\)/.test(configSrc) &&
      /const eff = resolveThresholds\(cfg\.thresholds\)/.test(configSrc),
    "生效常量必须由 initConfig() 以 resolveThresholds(cfg.thresholds) 重绑（harness.json 覆盖的唯一出口）",
  );
  assert.equal(
    configSrc.split("loadHarnessConfig()").length - 1,
    1,
    "loadHarnessConfig() 只允许出现在 initConfig 缺省参——导入期禁读 ~/.ZQQ-harness/harness.json（测试确定性）",
  );
  assert.ok(
    /export let (HARNESS_CONFIG|DEFAULTS|COMPACTION_PRESSURE|SUBAGENT_MAX_CONCURRENT|MCP_HANDSHAKE_TIMEOUT_MS)/.test(configSrc),
    "生效常量应为 export let（live binding，initConfig 后消费方自动见到新值）",
  );
  assert.ok(serverSrc.includes("initConfig();"), "server.ts bootstrap 应在消费生效常量前显式 initConfig()");
  const storeSrc = readFileSync(join(HERE, "..", "providers", "store.ts"), "utf8");
  assert.ok(
    !/const DEFAULT_CONTEXT_LENGTH/.test(storeSrc),
    "providers/store.ts 不再定义本地 DEFAULT_CONTEXT_LENGTH（改从 config.ts 导入，harness.json 可覆盖）",
  );
  assert.ok(
    serverSrc.includes("HARNESS_CONFIG") && serverSrc.includes("loadExternalModules"),
    "server.ts bootstrap 应消费 harness.json 的模块禁用清单与外部模块目录",
  );
});

// ---------- 哨兵（阶段 C，docs/21 §2.4/§3.2：常量收敛 + 协议解耦 + 前端 CFG/XSS 机制化） ----------

test("哨兵（阶段 C 已启用）：高风险字面量单一出处（userdir/送达前缀/种子提供方/SSE 心跳）", () => {
  const all = listTsFiles(join(HERE, "..")); // 递归扫全部 src（.test.ts 除外）
  const srcOf = (f: string) => readFileSync(f, "utf8");
  // 1) ".ZQQ-harness" 引号字面量只在 userdir.ts
  const dirLit = all.filter((f) => srcOf(f).includes('".ZQQ-harness"'));
  assert.equal(dirLit.length, 1, `".ZQQ-harness" 字面量应只在 userdir.ts，实际在 ${dirLit.join(",")}`);
  assert.ok(dirLit[0]!.endsWith(join("userdir.ts")), "");
  // 2) 自动送达前缀只在 core/events.ts（协议契约同源）；前端不写死（经 meta 下发）
  const prefixHit = all.filter((f) => srcOf(f).includes("[子代理任务报告 · 自动送达]"));
  assert.ok(prefixHit.length === 1 && prefixHit[0]!.endsWith(join("core", "events.ts")), "送达前缀唯一出处 = core/events.ts");
  assert.ok(
    !html.includes("[子代理任务报告 · 自动送达]") && !html.includes("[子代理状态 · 自动送达]"),
    "前端不得写死送达前缀（splitAutoText 经 meta 判别，docs/21 §2.4 协议解耦）",
  );
  // 3) meta 下发两前缀（前端消费的依赖面）
  const runtimeSrc = readFileSync(join(HERE, "..", "web", "session-runtime.ts"), "utf8");
  assert.ok(runtimeSrc.includes("autoReportPrefix: AUTO_DELIVERY_PREFIXES.report"), "metaSnapshot 应下发 autoReportPrefix");
  // 4) 种子提供方单一出处
  const storeSrc2 = readFileSync(join(HERE, "..", "providers", "store.ts"), "utf8");
  assert.equal((storeSrc2.match(/"deepseek-flash"/g) ?? []).length, 1, "种子模型字面量只在 DEFAULT_PROVIDER_SEED");
  // 5) SSE 心跳单一出处（http.ts 定义、server.ts 消费）
  const httpSrc = readFileSync(join(HERE, "..", "core", "http.ts"), "utf8");
  assert.ok(httpSrc.includes("SSE_PING_MS = 20_000") && serverSrc.includes("SSE_PING_MS"), "SSE 心跳 = SSE_PING_MS 单一出处");
});

test("哨兵（阶段 C 已启用）：前端 CFG 常量区 + XSS 机制化（docs/21 §3.2-①②）", () => {
  assert.ok(html.includes("const CFG = {"), "script 头部应有 CFG 常量区");
  for (const stray of ["> 20000", "slice(0, 300)", ", 3000)", ", 2500)", "scrollHeight, 160"]) {
    assert.ok(!html.includes(stray), `index.html 不应再有散落字面量 "${stray}"（统一走 CFG）`);
  }
  assert.ok(html.includes("&quot;") && html.includes("&#39;"), "esc() 应转义引号（属性注入面）");
  assert.ok(html.includes("function el(tag, cls, trustedHtml)"), "el() 第三参应命名 trustedHtml（命名即文档）");
  assert.ok(/mimes\.includes\(im\.mime\)/.test(html), "历史图片回放应经 mime 白名单复验");
});

test("哨兵（阶段 C 已启用）：提供方 SDK 隐式超时/重试显式化（docs/21 §2.4 末行）", () => {
  const openaiSrc = readFileSync(join(HERE, "..", "modules", "providers", "openai", "provider.ts"), "utf8");
  assert.ok(
    /timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES/.test(openaiSrc),
    "new OpenAI 应显式传 timeout/maxRetries（不依赖 SDK 缺省的隐式行为）",
  );
  const anthropicSrc = readFileSync(join(HERE, "..", "modules", "providers", "anthropic", "provider.ts"), "utf8");
  assert.ok(
    anthropicSrc.includes("ANTHROPIC_FETCH_TIMEOUT_MS") && anthropicSrc.includes("AbortSignal.any"),
    "anthropic 裸 fetch 应有 AbortSignal.timeout 兜底且与外部 signal 合并",
  );
});

// ---------- 哨兵（阶段 D1，docs/21 §3.1：subagents.ts 五向拆分，纯移动不改行为） ----------

test("哨兵（阶段 D1 已启用）：子代理家族五文件各 ≤400 行（单文件不再承载 10+ 职责）", () => {
  for (const f of ["subagents.ts", "subagent-worker.ts", "subagent-report.ts", "subagent-archive.ts", "subagent-records.ts"]) {
    const lines = readFileSync(join(HERE, "..", "web", f), "utf8").split("\n").length;
    assert.ok(lines <= 400, `${f} 应 ≤400 行（D1 拆分不变量；超出=职责又堆回单文件），当前 ${lines}`);
  }
});

// ---------- 哨兵（docs/24：前端「运行阈值」设置入口 + harness 热应用） ----------

test("哨兵（docs/24 已启用）：前端零硬编码阈值——键名/文案/默认值只经 schema 下发；写路由热应用必经 initConfig", () => {
  const schema = thresholdSchema();
  assert.equal(schema.entries.length, 34, "schema 应为 34 个活跃阈值键（新增键需同步登记规则表与计数）");
  // ① 设置模态区域（HTML 块 + JS 段）不写死任何阈值键名——说明/范围/默认值/分组的唯一来源
  //    = GET /api/settings/harness 的 schema。全文件检查不可行：defaultContextLength 等键名是
  //    meta 契约的合法消费（metaOf().defaultContextLength），与设置表单硬编码无关。
  const htmlStart = html.indexOf('id="setModal"');
  const htmlEnd = html.indexOf("子代理过程查看模态", htmlStart);
  const jsStart = html.indexOf("// ---------- 运行阈值设置（docs/24");
  const jsEnd = html.indexOf("// ---------- 工作区选择弹窗", jsStart);
  assert.ok(htmlStart >= 0 && htmlEnd > htmlStart && jsStart >= 0 && jsEnd > jsStart,
    "找不到设置模态区域锚点（前端重构后请同步更新本测试切片）");
  const settingsRegion = html.slice(htmlStart, htmlEnd) + html.slice(jsStart, jsEnd);
  for (const e of schema.entries) {
    assert.ok(!settingsRegion.includes(e.key), `设置模态不得硬编码阈值键名 "${e.key}"（应经 schema 下发）`);
  }
  assert.ok(settingsRegion.includes("setSchema.entries"), "设置表单应遍历 schema 渲染（不从本地清单生成）");
  assert.ok(settingsRegion.includes("/api/settings/harness"), "前端应经 /api/settings/harness 读 schema/提交保存");
  // ② 写路由 = 校验 + 原子写 + initConfig 热应用（唯一重绑出口，沿 P8 锁法）
  const settingsSrc = readFileSync(join(HERE, "..", "modules", "web-settings", "index.ts"), "utf8");
  assert.ok(settingsSrc.includes("validateThresholdsStrict("), "写入口必须走严格校验（fail-closed，与读的 lenient 语义分开）");
  assert.ok(settingsSrc.includes("writeTextAtomic("), "落盘必须是原子写（校验-原子替换，防半文件）");
  assert.ok(settingsSrc.includes("initConfig("), "写成功后必须 initConfig() 热应用（live binding 唯一出口）");
});

// ---------- 哨兵（docs/26 F1：前端纯逻辑模块化——零依赖/禁 DOM/行数防回涨三边界） ----------

test("哨兵（docs/26 F1 已启用）：app/ 前端模块零依赖（禁 node_modules/远端 import）+ 纯逻辑禁 DOM 引用", () => {
  const appDir = join(HERE, "..", "web", "public", "app");
  const files = readdirSync(appDir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 6, "app/ 应含 F1 三模块与其测试（replay/turns/autoreport × .js/.test.js）+ F2 store");
  for (const f of files) {
    const src = readFileSync(join(appDir, f), "utf8");
    // 可测性边界（docs/26 §9-6）：纯逻辑模块禁 DOM 全局引用（含测试——node:test 环境没有它们）
    assert.ok(!/\bdocument\b|\bwindow\b/.test(src), `${f} 不得引用 DOM 全局（可测性边界）`);
    // 零依赖边界（docs/26 §9-5）：只许相对/同根路径 import；node: 内建仅测试文件可用（node:test）
    const specs = [
      ...[...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!),
      ...[...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]!),
    ];
    const isTest = f.endsWith(".test.js");
    for (const spec of specs) {
      assert.ok(!/^https?:\/\//.test(spec), `${f} 禁止远端模块 import（${spec}）——离线可用性`);
      assert.ok(
        spec.startsWith(".") || spec.startsWith("/") || (isTest && spec.startsWith("node:")),
        `${f} 禁止裸包名 import（${spec}）——app/ 零依赖，node: 内建仅测试可用`,
      );
    }
  }
});

test("哨兵（docs/26 F1 已启用）：index.html 为原生 module 单 script + 内联行数防回涨（≤2530）", () => {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, "index.html 应为 <script type=\"module\">（无构建 ES Modules，docs/26 §2）");
  assert.ok(!html.includes("<script>\n"), "不应再有经典内联 script 块");
  const lines = m[1]!.split("\n").length;
  assert.ok(
    lines <= 2530,
    `内联 script 应 ≤2530 行（F1 完成时实测 2292 +10% 取整；新功能纯决策进 app/ 模块、DOM 进视图层，继续拆分看 docs/26 F4），当前 ${lines}`,
  );
  // 模块接线：F1 三模块 + F2 store 均被页面 import（web-static 精确注册同路径）
  for (const name of ["replay.js", "turns.js", "autoreport.js", "store.js"]) {
    assert.ok(m[1]!.includes(`"/app/${name}"`), `页面应 import /app/${name}`);
  }
});

test("哨兵（docs/26 F2 已启用）：index.html 顶层裸 let ≤3（状态收敛入五区 store）", () => {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, "index.html 应有 module script（上一哨兵同款前置）");
  const lets = m[1]!.split("\n").filter((l) => /^let /.test(l));
  assert.ok(
    lets.length <= 3,
    `顶层裸 let 应 ≤3（docs/26 §4 验收：~22→≤3；新状态入对应区 store，快照常量用 const），当前 ${lets.length}：${lets.join(" | ")}`,
  );
});

// ---------- 哨兵（docs/25 DT1：桌面壳「不进业务」边界，§8-1 锁法） ----------

test("哨兵（docs/25 DT1 已启用）：desktop/ 壳不进业务——≤2 文件、不 import src/、不碰 /api/ 与用户数据目录", () => {
  const desktopDir = join(HERE, "..", "..", "desktop");
  const files = existsSync(desktopDir) ? readdirSync(desktopDir) : [];
  assert.ok(files.length > 0, "desktop/ 应存在（DT1 壳：main.mjs）");
  assert.ok(files.length <= 2, `desktop/ 限 2 个文件（main.mjs + 图标；docs/25 §8-1），当前 ${files.length}：${files.join(",")}`);
  for (const f of files) {
    if (!f.endsWith(".mjs") && !f.endsWith(".js")) continue; // 图标等二进制不查源码
    const src = readFileSync(join(desktopDir, f), "utf8");
    const specs = [...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const spec of specs) {
      assert.ok(!spec.includes("src/"), `${f} 不得 import src/**（壳不进业务——服务经子进程 spawn，通信只有 READY 行与 stdin 管道）`);
    }
    assert.ok(!src.includes("/api/"), `${f} 不得出现 /api/（壳不做第二个业务层；页面自行访问服务端点）`);
    assert.ok(!src.includes(".ZQQ-harness"), `${f} 不得读写业务数据目录（用户数据只属服务进程）`);
  }
});

// ---------- d) import 图哨兵 ----------

function listTsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) out.push(...listTsFiles(p));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** import 目标的模块目录键（相对 modules/ 的目录部分）；modules/ 之外返回 null（不受此约束）。 */
function moduleKeyOfFile(p: string): string | null {
  const rel = relative(MODULES_DIR, p).split(sep).join("/");
  if (rel === "" || rel.startsWith("../")) return null;
  if (!rel.endsWith(".ts")) return rel; // 目录形式引用：指向的就是某模块目录
  const segs = rel.slice(0, -3).split("/");
  return segs.length >= 2 ? segs.slice(0, -1).join("/") : null;
}

test("import 图哨兵：modules/** 内不得跨模块目录 import", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(MODULES_DIR)) {
    const importerKey = moduleKeyOfFile(file);
    if (!importerKey) continue;
    const src = readFileSync(file, "utf8");
    const specs = [
      ...[...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue; // 裸导入（node:/openai/koffi）与模块拓扑无关
      const targetKey = moduleKeyOfFile(resolve(dirname(file), spec));
      if (targetKey && targetKey !== importerKey) {
        violations.push(`${relative(MODULES_DIR, file)} → ${spec}（${importerKey} ↛ ${targetKey}）`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "模块之间禁止互相 import（依赖方向见重构文档 §3；共享下沉 core 或经 ctx 交换）",
  );
});
