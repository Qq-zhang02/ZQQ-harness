/**
 * 契约测试与防回归网（模块化架构重构 §7 P0）。
 * 四类跨模块/跨端契约，全部只读源码与快照，无行为改动：
 *  a) SSE 事件名三端一致：core/events.ts ↔ web/server.ts ↔ app/main.js（F4 起 SSE 表在入口模块；正则双向提取比对）；
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
const APP_DIR = join(HERE, "..", "web", "public", "app");
const MODULES_DIR = resolve(HERE, "..", "modules");

const serverSrc = readFileSync(SERVER_TS, "utf8");
const agentSrc = readFileSync(AGENT_TS, "utf8");
const html = readFileSync(INDEX_HTML, "utf8");
// F4（docs/26 §6）后视图代码全部在 app/ 模块：main.js 持 SSE 表，modals.js 持设置模态；
// frontSrc = index.html 骨架 + 全部非测试模块拼接——面向"前端整体"的哨兵断言一律用它。
const mainSrc = readFileSync(join(APP_DIR, "main.js"), "utf8");
const modalsSrc = readFileSync(join(APP_DIR, "modals.js"), "utf8");
const frontSrc =
  html + "\n" +
  readdirSync(APP_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => readFileSync(join(APP_DIR, f), "utf8")).join("\n");

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

test("SSE 契约：main.js 的 SSE_HANDLERS 表监听的事件名与 core/events.ts 完全一致", () => {
  // P7 起监听由表驱动注册（for + addEventListener），从表字面量提取方法键；
  // F4 起 SSE 表从 index.html 内联迁至入口模块 app/main.js（表体逐字未动）
  const start = mainSrc.indexOf("const SSE_HANDLERS = {");
  const end = mainSrc.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, "app/main.js 中找不到 SSE_HANDLERS 表（前端重构后请同步更新本测试）");
  const keys = [...mainSrc.slice(start, end).matchAll(/\n  ([A-Za-z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.values(SSE_EVENTS).slice().sort());
});

test("SSE 契约：dispatchBuffered 缓冲重放复用 SSE_HANDLERS（可重放事件 ⊆ SSE_EVENTS 由表键锁定）", () => {
  const fnStart = mainSrc.indexOf("function dispatchBuffered");
  const fnEnd = mainSrc.indexOf("// ---------- 斜杠命令表", fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, "app/main.js 中找不到 dispatchBuffered 定位锚点（前端重构后请同步更新本测试）");
  const body = mainSrc.slice(fnStart, fnEnd);
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
  "文件操作优先使用专用工具，不要用 run_pwsh 代替：读取文件用 read_file、新建或整体写入用 write_file、局部修改用 edit_file——" +
    "它们带行号显示、精确替换与先读后写保护，比 PowerShell 的 Get-Content/Set-Content 等命令更安全可靠；" +
    "run_pwsh 只用于文件工具覆盖不了的场景（目录与批量操作、二进制或超大文件、进程管理等）。",
  "执行命令时注意控制输出量（用 Select-Object -First、Where-Object 等过滤），避免一次输出过多内容。",
  // docs/32：ask_user（front 受众，普通会话可用）的使用纪律——方向性分歧才问选择题
  "方向性不确定（需求歧义、方案取舍、破坏性操作确认）且无法从上下文合理推断时，用 ask_user 向用户发起选择题（2~4 个简短互斥的选项，用户也可自行输入其它答案）；能合理推断的就直接做，不要滥用提问。",
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
 *  条目（read_archive：重派时让新 worker 读过程存档/主对话记录）。
 *  真机待办轮：删「进度持久化 TASKS.md」条——强制维护记录文档生硬且让子代理额外多一项
 *  写入任务；协调者上下文治理靠压缩与报告送达已足够，不需要外部记录文档。
 *  docs/32：协调者获得三件直用工具（subagent_status 状态表 / list_files 只读目录清单 /
 *  ask_user 向用户提问）——身份句改写、新增「直用工具参考」块、报告处理与汇总交付两条
 *  纪律补「追问进度查询」「交付前抽查产出物」、异常变动条改「事实源 + 主动核对」、
 *  interim 纪律改三件口径；toolDocs 六件。 */
const coordinatorBase = [
  "你是 ZQQ-harness 的任务协调者（coordinator），负责大型项目的总体把控。",
  "实质工作——读写文件、运行命令、查询资料——全部由子代理（worker）完成；你自己只有三件直用工具：两件只读查询（subagent_status / list_files）与一件向用户提问（ask_user），精确语义见下方「直用工具参考」；派出与控制子代理的工具见「子代理工具参考」。",
  `当前工作区根：${ROOT}（任务书中的路径一律用相对路径）。`,
  "职责与工作方式：",
  "- 先规划再派发：把大任务分解为边界清晰、互不重叠的子任务（按目录/模块/主题划分），说明各自负责范围（scope）。",
  "- 任务书必须自包含：子代理看不到本对话历史。每份任务书写清：目标、背景与约束、涉及的路径、期望产出（文件落点 + 报告结构）。",
  "- 派发纪律（docs/16）：agent_task / agent_followup 派发即返回「已派发」回执、不等待完成；每个子代理的结算（完成/失败/打断/归档）" +
    "会以「[子代理任务报告 · 自动送达]」开头的消息按完成顺序自动送达你（你忙碌时积压的报告在轮末合并送达）——像用户消息一样随时到达，无需轮询。" +
    "互不依赖、写入范围不重叠的任务在同一轮里发多个 agent_task 即并行派出（各自给 scope 划定写入范围）；有依赖的任务等前置报告送达后再派。" +
    "超出并发上限（subagentMaxConcurrent，默认 3）的派发被立即拒绝（不排队）——余下的等报告送达、并发腾出后再派。",
  "- 报告处理纪律：收到部分报告时只向用户简报进度或按需干预（追派/打断/归档），不要提前汇总尚未完成的部分；全部报告到齐后再整合交付。" +
    "等待其余报告时直接简短收尾即可（说明在等什么），报告送达会自动开启你的下一轮。" +
    "用户追问进度时，用 subagent_status 查询当前状态表后如实转述（不要凭印象编造各子代理的进展）。",
  "- 可复用子代理（docs/9）：同一专业方向要跨多次任务延续时，agent_task 带 reusable=true 派出——它完成后保留全部上下文待命，" +
    "后续用 agent_followup 按 name/subId 追加任务（任务书可引用之前的进展）；确定不再使用时用 archive_subagent 归档（归档可随时用 agent_followup 从存档唤醒复活）。" +
    "独立的一次性任务用缺省形态（用完即自动归档）。服务重启后待命实例不在线——agent_followup 会自动从过程存档唤醒它（历史延续，同 subId），无需重新派发。",
  "- 接续上下文（docs/17/41）：子代理超时/打断做了一半的任务优先复活而非重派——用 agent_followup（按 subId 寻址）对它追加新任务，自动从存档唤醒（同 subId、上下文无缝延续；一次性子代理复活后转正为可复用）。失败报告里的「死前进展」速览与 [[过程档案#N]] 标注指出它做到了哪；也可 agent_task 重派并让新实例「先用 read_archive（subId=N）读过程存档，再继续」——read_archive 也可传 sessionId 读另一段主对话的完整记录。",
  "- 子代理异常变动会自动通知（docs/11/16）：界面打断/归档等你看不见的变动会以「[子代理状态 · 自动送达]」消息告知你；每个任务的最终结果" +
    "（含失败与归档状态）以「[子代理任务报告 · 自动送达]」消息按完成顺序送达。派发回执与这些送达消息是感知子代理状态的事实源；" +
    "需要主动核对时用 subagent_status 查询当前状态表（只读快照，不打扰子代理）。",
  "- 冲突预防：绝不派两个子代理写同一个文件；发现产出矛盾时自己裁决，或派一个验证型子代理对比后报告。",
  "- 汇总与交付：整合各子代理报告为最终答复；对用户如实呈现（谁做了什么、成败、产出物路径）。" +
    "整合交付前可用 list_files 抽查关键产出物是否真实落盘（只看文件名），发现缺失如实说明并让对应子代理补交。",
  "子代理工具参考（语义精确，严格按此使用）：",
  "- agent_task：派出一个子代理，立即返回「已派发」回执（非阻塞，不等待完成）。description（一句话摘要）与 task（自包含任务书）必填；name 可选短名（审批卡/报告/送达消息标注用）；" +
    "scope 可选写入分区（相对路径前缀数组）；reusable=true 派出可复用形态；timeoutMs 可选超时（≥60000 毫秒）。同一轮发多个本调用即并行派出（见派发纪律）。",
  "- agent_followup：向空闲待命或已归档（留有过程存档）的子代理追加新任务，立即返回「已派发」回执（非阻塞，不等待完成）。已归档的自动从存档唤醒复活（同 subId；一次性转正为可复用）。按 name 或 subId 寻址（同名多个时必须用 subId）；" +
    "它保留之前全部任务的上下文，任务书可引用既有进展，但新目标与期望产出仍要写清。",
  "- stop_subagent：打断一个运行中子代理的当前任务。语义：**立即中止**——进行中的 LLM 请求与工具执行（含 pwsh 进程）当场终止，" +
    "已完成的进度保留在历史、半截内容作废。打断结算：一次性子代理随之归档（过程存档保留，可用 agent_followup 从存档唤醒复活继续）；可复用子代理转空闲待命（保留上下文），" +
    "继续该方向的工作用 agent_followup 发新任务书。按 name（同名者全部生效）或 subId 指定；空闲待命的子代理没有可打断的对象。",
  "- archive_subagent：归档一个可复用子代理——归档不是终结，需要继续时用 agent_followup 从存档唤醒复活（一次性转正为可复用）。空闲待命时立即归档；" +
    "执行中归档会先中止其当前任务。一次性子代理任务结束即自动归档，无需（也不支持）本工具。",
  "直用工具参考（只读查询与提问，严格按此使用）：",
  "- subagent_status：查看当前子代理状态表——活动子代理（运行中/空闲待命）的 subId/name/实时用时/上下文占用/任务摘要，all=true 附最近 20 条历史记录摘要。" +
    "只读快照、立即返回、不打扰子代理；用户追问进度、控制工具寻址前核对 name/subId 时用。任务的最终结果仍以送达消息为准，本表不能代替报告。",
  "- list_files：列出工作区内某个目录的文件与子目录名（只读，不含内容，不递归）。用于了解工作区/模块结构、验收前核对产出文件是否真实落盘；要看某个子目录就对它再调用一次。",
  "- ask_user：向用户发起选择题询问并阻塞等待回答。仅用于会改变做法的方向性不确定（需求歧义/方案取舍/破坏性操作确认）且无法从上下文合理推断时：" +
    "问题写具体自包含，给 2~4 个简短互斥的选项，用户也可自行输入其它答案；能从任务上下文合理推断的就直接做，不要滥用提问。",
  "执行纪律（重要）：",
  "- 用户要求停止/归档子代理时，必须真正调用对应工具执行，再如实转述工具返回的文本。" +
    "绝不要只在回复文字里声称「已停止/已执行」，也不要输出任何形如命令或工具调用的纯文本冒充执行——没有真正调用工具就等于没有执行，那是在欺骗用户。",
  "- 任务运行中用户的插话会以「即时应答」送达你：该窗口内只有 stop_subagent / archive_subagent / subagent_status 三件工具可真正执行（打断/归档/查进度）；" +
    "派发新任务、向用户发起提问等其余诉求等当前任务返回后再处理（插话内容都会保留在对话历史里，不会丢）。",
  "- 工具返回错误（找不到目标/状态不符等）时如实向用户报告原因，不要假装成功；工具文案里附的活动子代理清单可用来核对目标。",
  "请用中文与用户交流，简洁说明你做了什么。",
].join("\n");

/** 协调者 registry 六件的 summary 行（docs/32 起：四件派发/控制 + subagent_status/list_files
 *  两件直用只读；ask_user 受众 front 装在普通与协调者会话——但本测试的 toolDocs 是手工给定的
 *  快照输入，六件口径对应协调者四件+两件只读；ask_user 的 summary 行如需体现可再加）。
 *  供 coordinator golden 与 vision 变体两个测试共用（改 summary = 同步改这里）。 */
const coordinatorToolDocs = [
  "agent_followup —— 向一个空闲待命的可复用子代理追加新任务，立即返回派发回执（非阻塞；它保留之前任务的全部上下文，按 name 或 subId 寻址）",
  "agent_task —— 派出一个子代理独立完成一项任务，立即返回派发回执（非阻塞；报告完成后自动送达。reusable=true 可复用；同一轮发多个本调用即并行派发，协调者核心派发工具）",
  "archive_subagent —— 归档一个可复用子代理（归档不是终结：可随时用 agent_followup 从存档唤醒复活；执行中归档会中止当前任务）",
  "list_files —— 列出工作区内某个目录的文件与子目录名（只读、不含内容、不递归；核对结构与验收产出落点用，深入子目录再对它调用）",
  "stop_subagent —— 打断一个运行中子代理的当前任务（立即中止请求/工具执行；一次性随之归档、可复用转空闲待命，无恢复机制；按 name 或 subId 匹配）",
  "subagent_status —— 查看当前子代理状态表（活动子代理运行中/空闲待命的实时用时/上下文占用/摘要，all=true 附历史记录；只读快照不打扰子代理，用户追问进度或寻址前核对用）",
];

test("golden 快照：coordinator 输入（base 分支新文案；skills/mcp 段不注入；AGENTS.md 两段 docs/20 起不注入——移入 web 层「子代理系统提示词说明」段）", () => {
  // 协调者 registry 六件（docs/32 起），toolDocs 即其 summary 行（toolDocsOf 按名排序）
  const sc: SectionContext = {
    ...fullContext,
    sessionKind: "coordinator",
    toolDocs: coordinatorToolDocs,
  };
  const expected = [
    coordinatorBase,
    "可用工具：" + coordinatorToolDocs.join("；") + "。",
  ].join("\n\n");
  assert.equal(assembleSystemPrompt(BUILTIN_PROMPT_SECTIONS, sc), expected);
});

// ---------- b3) vision 变体（docs/12 R2：会话提供方有视觉 → base 段注入图片直看指引；缺省快照零改动） ----------

/** docs/12 R2 的两条视觉指引行（改文案 = 显式更新本快照） */
const visionLineWorker =
  "图片输入：消息可能直接携带图片（与文字一起的多模态输入）——你已直接看到原图，优先用自己的视觉能力分析作答，不要声称看不到。" +
  "读取工作区磁盘上的图片文件用 read_image（docs/34：图片作为图像块进入对话，下一次请求你直接看到；同一张图勿重复读）——"
  "view_image 是给无视觉模型的借视觉通道（出文字描述），你不需要它；不要对消息中已携带的图片再调用任何读图工具。";
const visionLineCoordinator =
  "图片输入：用户消息可能直接携带图片（与文字一起的多模态输入）——你已直接看到原图，直接分析并据此回应即可，不要声称看不到" +
  "（子代理需要看磁盘上的图片文件时会自行使用读图工具：有视觉用 read_image 直读，无视觉用 view_image 借视觉模型）。";

test("golden 快照：vision=true 注入图片直看指引（docs/12 R2）——normal 插入 base 段倒数第二行、coordinator 尾附一行；vision:false/缺省字节不变", () => {
  // normal：视觉行插在「请用中文」之前，base 之外的段与缺省版逐字节一致
  const baseVision = [
    "你是 ZQQ-harness，一个运行在用户 Windows 终端里的 agent 助手。",
    `安全规则：默认只允许在 ${ROOT} 工作区内创建、修改、删除文件；涉及工作区外的操作会被系统拦截并交由用户批准。文件操作请尽量使用相对路径。`,
    "文件操作优先使用专用工具，不要用 run_pwsh 代替：读取文件用 read_file、新建或整体写入用 write_file、局部修改用 edit_file——" +
      "它们带行号显示、精确替换与先读后写保护，比 PowerShell 的 Get-Content/Set-Content 等命令更安全可靠；" +
      "run_pwsh 只用于文件工具覆盖不了的场景（目录与批量操作、二进制或超大文件、进程管理等）。",
    "执行命令时注意控制输出量（用 Select-Object -First、Where-Object 等过滤），避免一次输出过多内容。",
    // docs/32：ask_user（front 受众，普通会话可用）的使用纪律——方向性分歧才问选择题
    "方向性不确定（需求歧义、方案取舍、破坏性操作确认）且无法从上下文合理推断时，用 ask_user 向用户发起选择题（2~4 个简短互斥的选项，用户也可自行输入其它答案）；能合理推断的就直接做，不要滥用提问。",
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
    toolDocs: coordinatorToolDocs,
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

test("哨兵（P6 已启用；docs/25 DT0 调整 250→270；2026-11-16 真机回归再调 270→278；docs/33 附件库接线再调 278→282）：server.ts ≤282 行", () => {
  const lines = serverSrc.split("\n").length;
  assert.ok(lines <= 282, `server.ts 应只剩 bootstrap/静态/SSE/meta/分发/进程生命周期（DT0 优雅停机 + 端口绑定回退），当前 ${lines} 行`);
});

test("哨兵（P8 已启用；docs/40 阶段三改 THRESHOLDS 单对象）：生效阈值经 initConfig() 原地 Object.assign 重绑，导入期不读 harness.json", () => {
  const configSrc = readFileSync(join(HERE, "..", "config.ts"), "utf8");
  assert.ok(
    /export function initConfig\(cfg: HarnessConfig = loadHarnessConfig\(\)\)/.test(configSrc) &&
      /Object\.assign\(THRESHOLDS, resolveThresholds\(cfg\.thresholds\)\)/.test(configSrc),
    "生效阈值必须由 initConfig() 以 Object.assign(THRESHOLDS, resolveThresholds(cfg.thresholds)) 原地重绑（harness.json 覆盖的唯一出口）",
  );
  assert.equal(
    configSrc.split("loadHarnessConfig()").length - 1,
    1,
    "loadHarnessConfig() 只允许出现在 initConfig 缺省参——导入期禁读 ~/.ZQQ-harness/harness.json（测试确定性）",
  );
  assert.ok(
    /export const THRESHOLDS: EffectiveThresholds = resolveThresholds\(\{\}\)/.test(configSrc),
    "生效阈值应收敛为单一 const 对象 THRESHOLDS（对象身份恒定，docs/40 阶段三）",
  );
  assert.ok(!/export let DEFAULTS/.test(configSrc), "旧 DEFAULTS 快照应已删除（并入 THRESHOLDS 字段）");
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

test("哨兵（docs/40 阶段三已启用）：THRESHOLDS 单对象纪律——全库禁旧常量名 import、禁顶层解构字段（冻结原始值）", () => {
  const all = listTsFiles(join(HERE, "..")); // 递归扫全部 src（.test.ts 除外；scripts 同扫）
  const offenders: string[] = [];
  for (const f of all) {
    const src = readFileSync(f, "utf8");
    // ① 旧 SCREAMING 常量已删除：任何 import / 具名引用都应不存在（类型层面由 tsc 把关，此处防回潮）
    for (const name of [
      "COMPACTION_PRESSURE", "COMPACTION_KEEP_RATIO", "COMPACTION_MANUAL_KEEP_TOKENS", "COMPACTION_SUMMARY_MAX_CHARS",
      "DEFAULT_CONTEXT_LENGTH", "SUBAGENT_MAX_CONCURRENT", "SUBAGENT_MAX_TOTAL", "SUBAGENT_MAX_TOOL_ROUNDS",
      "SUBAGENT_RESULT_MAX_CHARS", "SUBAGENT_MAX_TASKS", "SUBAGENT_FOLLOWUP_CONTEXT_PCT", "SUBAGENT_WARN_CONTEXT_PCT",
      "SUBAGENT_ARCHIVE_CONTEXT_PCT", "SUBAGENT_TIMEOUT_MIN_MS", "SUBAGENT_STATUS_HISTORY_MAX", "ARCHIVE_RENDER_MAX_CHARS",
      "ESCALATION_MAX", "AGENTS_MD_MAX_CHARS", "PWSH_CAPTURE_MAX_BYTES", "PRECOMPACT_KEEP", "SPILL_MAX_AGE_HOURS",
      "SANDBOX_TMP_MAX_AGE_HOURS", "MCP_HANDSHAKE_TIMEOUT_MS", "MCP_CALL_TIMEOUT_MS", "VISION_TIMEOUT_MS",
      "PROVIDER_TEST_TIMEOUT_MS", "TEXT_FILE_MAX_BYTES", "READ_FILE_DEFAULT_LINES", "READ_FILE_MAX_CHARS",
      "READ_TOOL_RESULT_MAX_CHARS", "HTTP_BODY_MAX_BYTES", "IMAGE_TOKEN_EST",
    ]) {
      if (new RegExp(`\\b${name}\\b`).test(src)) offenders.push(`${f}: ${name}`);
    }
    // ② 顶层解构 THRESHOLDS 字段会冻结原始值（对象引用捕获不受影响——身份恒定）——禁止
    if (/const\s*\{[^}]*\}\s*=\s*THRESHOLDS/.test(src)) offenders.push(`${f}: 顶层解构 THRESHOLDS`);
    if (/\bDEFAULTS\b/.test(src)) offenders.push(`${f}: 残留 DEFAULTS 引用`);
  }
  assert.equal(offenders.length, 0, `THRESHOLDS 纪律违例：\n${offenders.join("\n")}`);
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
    !frontSrc.includes("[子代理任务报告 · 自动送达]") && !frontSrc.includes("[子代理状态 · 自动送达]"),
    "前端不得写死送达前缀（splitAutoText 经 meta 判别，docs/21 §2.4 协议解耦；F4 起扫 index.html+app/ 全量）",
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

test("哨兵（阶段 C 已启用；F4 起扫 index.html+app/ 全量）：前端 CFG 常量区 + XSS 机制化（docs/21 §3.2-①②）", () => {
  assert.ok(frontSrc.includes("const CFG = {"), "state.js 应有 CFG 常量区（F4 起随共享状态层）");
  for (const stray of ["> 20000", "slice(0, 300)", ", 3000)", ", 2500)", "scrollHeight, 160"]) {
    assert.ok(!frontSrc.includes(stray), `前端不应再有散落字面量 "${stray}"（统一走 CFG）`);
  }
  assert.ok(frontSrc.includes("&quot;") && frontSrc.includes("&#39;"), "esc() 应转义引号（属性注入面）");
  assert.ok(frontSrc.includes("function el(tag, cls, trustedHtml)"), "el() 第三参应命名 trustedHtml（命名即文档）");
  assert.ok(/mimes\.includes\(im\.mime\)/.test(frontSrc), "历史图片回放应经 mime 白名单复验");
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

test("哨兵（阶段 D1 已启用；docs/32 增至六文件）：子代理家族六文件各 ≤400 行（单文件不再承载 10+ 职责）", () => {
  for (const f of ["subagents.ts", "subagent-worker.ts", "subagent-report.ts", "subagent-archive.ts", "subagent-records.ts", "subagent-status.ts"]) {
    const lines = readFileSync(join(HERE, "..", "web", f), "utf8").split("\n").length;
    assert.ok(lines <= 400, `${f} 应 ≤400 行（D1 拆分不变量；超出=职责又堆回单文件），当前 ${lines}`);
  }
});

// ---------- 哨兵（docs/24：前端「运行阈值」设置入口 + harness 热应用） ----------

test("哨兵（docs/24 已启用）：前端零硬编码阈值——键名/文案/默认值只经 schema 下发；写路由热应用必经 initConfig", () => {
  const schema = thresholdSchema();
  assert.equal(schema.entries.length, 36, "schema 应为 36 个活跃阈值键（新增键需同步登记规则表与计数）");
  // ① 设置模态区域（HTML 块留 index.html + JS 段在 app/modals.js——F4 拆分后两处）不写死任何
  //    阈值键名——说明/范围/默认值/分组的唯一来源 = GET /api/settings/harness 的 schema。
  //    全文件检查不可行：defaultContextLength 等键名是 meta 契约的合法消费（metaOf().defaultContextLength），
  //    与设置表单硬编码无关。
  const htmlStart = html.indexOf('id="setModal"');
  const htmlEnd = html.indexOf("子代理过程查看模态", htmlStart);
  const jsStart = modalsSrc.indexOf("// ---------- 运行阈值设置（docs/24");
  const jsEnd = modalsSrc.indexOf("// ---------- 工作区选择弹窗", jsStart);
  assert.ok(htmlStart >= 0 && htmlEnd > htmlStart && jsStart >= 0 && jsEnd > jsStart,
    "找不到设置模态区域锚点（index.html 骨架块 / app/modals.js JS 段；前端重构后请同步更新本测试切片）");
  const settingsRegion = html.slice(htmlStart, htmlEnd) + modalsSrc.slice(jsStart, jsEnd);
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

test("哨兵（docs/26 F1/F4 已启用）：app/ 前端模块零依赖（禁 node_modules/远端 import）+ 纯逻辑禁 DOM 引用 + F4 视图分层存在", () => {
  const files = readdirSync(APP_DIR).filter((f) => f.endsWith(".js"));
  // F4 视图分层（§6 七模块；缺失=拆分被误并/误删）
  for (const v of ["dom.js", "state.js", "drawer.js", "sidebar.js", "chat.js", "modals.js", "main.js"]) {
    assert.ok(files.includes(v), `app/ 应含 F4 视图模块 ${v}（docs/26 §6 分层）`);
  }
  // 可测性边界只约束纯逻辑模块（docs/26 §9-6；docs/28 P2-3 增 toolinfo）：视图模块（dom/drawer/…）天然操作 DOM，不在其列
  const PURE = new Set(["replay.js", "turns.js", "autoreport.js", "store.js", "toolinfo.js"]);
  for (const f of files) {
    const src = readFileSync(join(APP_DIR, f), "utf8");
    if (PURE.has(f) || f.endsWith(".test.js")) {
      assert.ok(!/\bdocument\b|\bwindow\b/.test(src), `${f} 不得引用 DOM 全局（可测性边界——纯逻辑及其测试）`);
    }
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

test("哨兵（docs/26 F4 已启用；docs/32 上限 500→520：ask_user 询问卡的 CSS+骨架）：index.html 骨架化——单外链 /app/main.js + 总行数 ≤520 + 视图层 import 图覆盖", () => {
  assert.ok(
    /<script type="module" src="\/app\/main\.js"><\/script>/.test(html),
    "index.html 应只外链 /app/main.js（F4 大分区拆文件，docs/26 §6）",
  );
  assert.ok(!html.includes("<script>\n") && !/<script type="module">/.test(html), "不应再有内联 script（视图代码全部在 app/ 模块）");
  const lines = html.split("\n").length;
  assert.ok(lines <= 520, `index.html 应 ≤520 行（骨架+CSS，docs/26 §6 验收；docs/32 调整 500→520），当前 ${lines}`);
  // 分层接线（F4 无环图；docs/28 增 toolinfo）：五纯模块 + 六视图模块都被相对路径 import 覆盖（store 经 state.js、turns 经 chat.js）
  for (const need of ["replay.js", "turns.js", "autoreport.js", "store.js", "toolinfo.js", "dom.js", "state.js", "drawer.js", "sidebar.js", "chat.js", "modals.js"]) {
    assert.ok(frontSrc.includes(`"./${need}"`), `视图层 import 图应覆盖 ./${need}`);
  }
});

test("哨兵（docs/26 F2 已启用；F4 起扫描对象改 app/ 模块）：视图模块顶层裸 let ≤3（状态收敛入五区 store）", () => {
  const lets: string[] = [];
  for (const f of readdirSync(APP_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))) {
    for (const l of readFileSync(join(APP_DIR, f), "utf8").split("\n")) {
      if (/^let /.test(l)) lets.push(`${f}: ${l.trim()}`);
    }
  }
  assert.ok(
    lets.length <= 3,
    `视图模块顶层裸 let 应 ≤3（现役仅 modals 的 wsParent 与 sidebar 的切换回调槽；新状态入对应区 store，快照常量用 const），当前 ${lets.length}：${lets.join(" | ")}`,
  );
});

// ---------- 哨兵（真机回归 v0.2.0：视图模块自由标识符——F4 拆分后 import 断链的唯一机械闸门） ----------

/**
 * 视图模块「自由调用标识符」扫描（v0.2.0 真机回归催生）：drawer.js 用了 reconcileKeyed 却没从
 * dom.js import——checkJs:false 的视图层 typecheck 只查 import 语句可解析，不查函数体内的未定义
 * 名字；450 个测试不执行视图模块；冒烟 frontSrcAll() 把全部文件拼接后断言，跨模块缺 import 恰好
 * 被拼接掩盖。三道闸门全漏，装机后 renderDrawerList 每次抛 ReferenceError：抽屉列表永远空、
 * switchSession 在 resetDrawer 处被炸断（renderHistory 不再执行——切回会话文字消失/卡死）。
 * 本哨兵静态扫描每个视图模块（非测试）：剥离注释/字符串/模板/正则后，凡「调用形」标识符
 * （name( 且非 obj.name(、非关键字）必须可解析——本文件定义/参数/方法简写、import 绑定、或
 * 浏览器全局白名单（白名单按当前代码库实证收集，新全局请显式登记）。
 */
const VIEW_GLOBALS = new Set([
  // JS 内建
  "String", "Number", "Boolean", "Date", "JSON", "Math", "Map", "Set", "Promise", "Object",
  "Array", "Error", "RegExp", "Symbol", "encodeURIComponent", "isFinite", "queueMicrotask",
  // 浏览器 API（app/ 零依赖，无 node 全局）
  "document", "window", "console", "location", "fetch", "Notification", "EventSource",
  "FileReader", "localStorage", "URLSearchParams", "performance",
  "setInterval", "setTimeout", "clearInterval", "clearTimeout",
]);

/** 扫描排除词：关键字与控制流（正则判别也复用）。 */
const KEYWORD_OPS = [
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "instanceof",
  "delete", "void", "in", "of", "do", "else", "throw", "case", "yield", "await", "new",
  "async", "class", "const", "let", "var", "export", "import", "this", "super", "extends",
];

/** 剥离注释/字符串/模板/正则字面量（标识符扫描的预处理；正则 vs 除法按前一词判别——app/ 现无 return /re/ 形态）。 */
function stripLiteralsForScan(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let lastWord = "";
  const KW = new Set(KEYWORD_OPS);
  const regexAllowed = () =>
    lastWord === "" || KW.has(lastWord) || "(,=:[!&|?{};+-%<>^~".includes(lastWord[lastWord.length - 1] ?? "");
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; out += " "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += " "; lastWord = '"'; continue;
    }
    if (c === "/" && regexAllowed()) {
      i++; let inClass = false;
      while (i < n) {
        const r = src[i]!;
        if (r === "\\") { i += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        else if (r === "\n") break; // 跨行=误判成整段正则，宁可放弃该处
        i++;
      }
      i++; while (i < n && /[a-z]/.test(src[i]!)) i++; // flags
      out += " "; continue;
    }
    out += c;
    if (/\S/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) lastWord = /[A-Za-z0-9_$]/.test(src[i - 1] ?? "") ? lastWord + c : c;
      else lastWord = c;
    }
    i++;
  }
  return out;
}

/** 收集一个模块内「本地可解析」的名字：顶层定义 + import 绑定 + 函数/箭头参数 + 对象方法简写。 */
function collectLocalNames(raw: string, code: string): Set<string> {
  const names = new Set<string>();
  for (const m of raw.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of raw.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of raw.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1]!.split(",")) {
      const seg = part.split(/\bas\b/);
      const nm = (seg[seg.length - 1] || "").trim();
      if (nm) names.add(nm);
    }
  }
  const addParams = (list: string) => {
    for (const part of list.split(",")) {
      const pm = part.trim().match(/^([A-Za-z_$][\w$]*)(\s*=)?/);
      if (pm) names.add(pm[1]!);
      else for (const t of part.trim().split(/[^A-Za-z0-9_$]+/)) if (t && !KEYWORD_OPS.includes(t)) names.add(t);
    }
  };
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) addParams(m[1]!);
  for (const m of code.matchAll(/\(([^(){}]*)\)\s*=>/g)) addParams(m[1]!);
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) { names.add(m[1]!); addParams(m[2]!); }
  return names;
}

test("哨兵（真机回归 v0.2.0 已启用）：视图模块调用形自由标识符必须可解析——缺 import 的跨模块引用在静态扫描即拦（drawer.js/reconcileKeyed 同类）", () => {
  const problems: string[] = [];
  for (const f of readdirSync(APP_DIR).filter((x) => x.endsWith(".js") && !x.endsWith(".test.js"))) {
    const raw = readFileSync(join(APP_DIR, f), "utf8");
    const code = stripLiteralsForScan(raw);
    const local = collectLocalNames(raw, code);
    const seen = new Set<string>();
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      const prevChar = code[m.index! - 1] ?? "";
      if (prevChar === "." || prevChar === "$") continue; // 属性调用（含 obj?.fn）
      if (KEYWORD_OPS.includes(name) || local.has(name) || VIEW_GLOBALS.has(name)) continue;
      problems.push(`${f}: ${name}`);
    }
  }
  assert.ok(
    problems.length === 0,
    `视图模块存在无法解析的调用标识符（缺 import 或漏登记浏览器全局白名单 VIEW_GLOBALS）：${problems.join(" | ")}——v0.2.0 真机教训：这类断链 checkJs/冒烟全拦不住，运行期按条抛 ReferenceError`,
  );
});

// ---------- 哨兵（真机回归 v0.2.0 桌面端：沙箱宿主控制台保障——console-less 宿主 pwsh 全崩 0xC0000142） ----------

test("哨兵（真机回归 2026-11-16 已启用）：沙箱受限执行前必须保障宿主控制台（AllocConsole 兜底 + koffi 空指针判空）", () => {
  const src = readFileSync(join(HERE, "..", "modules", "sandbox", "windows-acl", "windows-acl.ts"), "utf8");
  // 桌面端宿主（ELECTRON_RUN_AS_NODE 的 Electron，GUI 子系统）无控制台——受限令牌 pwsh 只有
  // 「共享宿主控制台」一条活路（新建 conhost 崩 0xC0000142、DETACHED 假成功不执行命令，实验
  // 矩阵见 docs/1 2026-11-16 实施记录）。ensureHostConsole 必须存在且在 CreateProcessAsUserW 前调用。
  assert.ok(src.includes("ensureHostConsole"), "windows-acl.ts 应有 ensureHostConsole（console-less 宿主补隐藏控制台）");
  assert.ok(
    src.indexOf("this.ensureHostConsole()") < src.indexOf("F().CreateProcessAsUserW("),
    "ensureHostConsole() 必须在 CreateProcessAsUserW 之前调用（受限子进程创建时宿主须已有控制台）",
  );
  // koffi 空指针解码为 JS null 而非 0n——判空若只查 0n，null!==0n 恒真会让补偿被静默跳过
  // （首版修复正是栽在这里，"改了却没生效"）。锁住双查写法。
  assert.ok(
    /GetConsoleWindow\(\)[\s\S]{0,80}!==\s*null/.test(src) || /const \w+ = F\(\)\.GetConsoleWindow\(\)[\s\S]{0,200}!== null/.test(src),
    "GetConsoleWindow 判空必须同时查 null 与 0n（koffi void* 空指针解码为 null——只查 0n 会静默跳过补偿）",
  );
});

// ---------- 哨兵（docs/25 DT1：桌面壳「不进业务」边界，§8-1 锁法） ----------

test("哨兵（docs/25 DT1 已启用；DT3 放宽 desktop.json 例外）：desktop/ 壳不进业务——≤2 文件、不 import src/、不碰 /api/ 与用户数据目录", () => {
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
    // DT3（docs/25 §6/§8-1）：desktop.json 是 §8-1 声明的唯一例外——壳只读这一个业务文件。
    // 锁法：".ZQQ-harness" 字面量全文件至多一行，且该行必须同时是 desktop.json 路径常量行。
    const zqqHits = src.split("\n").filter((l) => l.includes(".ZQQ-harness"));
    assert.ok(zqqHits.length <= 1 && (zqqHits.length === 0 || zqqHits[0]!.includes("desktop.json")),
      `${f} 不得读写业务数据目录（唯一例外：desktop.json 路径常量行——壳对其只读；docs/25 §8-1）`);
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
