/**
 * 内置系统提示 sections（模块化架构重构 §4.4）：它们是"装配规则"本身，属 core。
 * 顺序与原 agent.ts systemPrompt() 的字节布局一致；唯一预期差异是"可用工具"行由
 * 各工具的 summary 生成（新工具自动出现在系统提示，run_pwsh 行中的工作区绝对路径
 * 改为通用表述——路径仍由 base 段安全规则行给出）。
 * assembleSystemPrompt 为纯函数：同输入同输出（逐字节确定，prompt 缓存友好）。
 */
import { skillListText } from "./skills.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PromptSection, SectionContext } from "./types.ts";
// docs/21 §2.2-③：提示词里的阈值一律插值生效常量，不写死缺省数字（harness.json 覆盖后文案不失真）。
// core → config.ts 是显式接受的例外：config 是全项目运行参数唯一出处（非 modules，不受模块禁令约束）。
import { SUBAGENT_MAX_CONCURRENT, SUBAGENT_TIMEOUT_MIN_MS } from "../config.ts";
// docs/21 §2.4 协议解耦：送达前缀常量插值（渲染文本不变，golden 零改动）
import { AUTO_DELIVERY_PREFIXES } from "./events.ts";

/** 工具 → 一句话文档；只收声明了 summary 的系统工具（mcp__ 工具走 MCP 说明段，不入列）。
 *  显式按名排序：系统提示字节与模块登记顺序无关（P3 起与 §4.4 "由 ctx.tools.all() 生成"一致）。 */
export function toolDocsOf(registry: ToolRegistry): string[] {
  return registry
    .list()
    .filter((t) => t.summary)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `${t.name} —— ${t.summary}`);
}

/** 按 order 升序（同序号按名字稳定）渲染全部 section，null 跳过，\n\n 连接。 */
export function assembleSystemPrompt(sections: PromptSection[], sc: SectionContext): string {
  const ordered = [...sections].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return ordered
    .map((s) => s.render(sc))
    .filter((x): x is string => x !== null)
    .join("\n\n");
}

/** coordinator（协调者前台）的 base 段（docs/5 §8 草案；SA3 已补并行纪律与 scope 用法；
 *  docs/7 W2-S 修订：派发工具两件 + 暂停/恢复两件，并补运行中对话与进度干预纪律；
 *  docs/9 修订：可复用子代理纪律——reusable 派发 / agent_followup 追加 / archive_subagent 归档；
 *  本轮修订：子代理工具参考精确化 + 执行纪律（必须真正调用工具，禁止文字冒充执行——
 *  修复协调者在运行中插话里“装模作样输出命令”的问题）；
 *  docs/11 W1 修订：子代理异常变动自动报告纪律——暂停即解除阻塞、最终结果按顺序送达。
 *  docs/14 修订：删除「子代理上下文开销」条——用量/预警/拒收/归档说明随报告文本自动附带
 *  （formatWorkerResult），提示词不再预先描述；防协调者据此向子代理索要其上下文用量
 *  （占用是宿主侧计算的，子代理模型并不知道，被问只会编造）。
 *  docs/15 修订：agent_tasks 批量工具退役——并行派发 = 同一轮多个 agent_task 调用
 *  （工具循环并行执行），并行纪律与工具参考同步改写。
 *  docs/16 修订：派发非阻塞化——agent_task/agent_followup 立即返回「已派发」回执；每份
 *  报告完成后以自动送达消息按完成顺序逐条到达（协调者随时处于收信状态），并行纪律改写为
 *  派发纪律并新增报告处理纪律。
 *  docs/17 修订：可复用子代理服务重启后不再失效——agent_followup 自动从过程存档唤醒
 *  （历史延续）；新增「接续上下文」条目（read_archive 用法：重新派发时让新 worker 读存档）。
 *  docs/18 修订：暂停/恢复机制退役——pause/resume_subagent 由 stop_subagent（打断即终结）
 *  取代；打断后可复用子代理转待命、只能发新任务书接续，工具参考与纪律行同步改写。 */
const coordinatorBase = (sc: SectionContext): string =>
  [
    "你是 ZQQ-harness 的任务协调者（coordinator），负责大型项目的总体把控。",
    "你自己没有任何直接工具——读写文件、运行命令、查询资料全部由子代理（worker）完成；你的全部工具与精确语义见下方「子代理工具参考」。",
    `当前工作区根：${sc.workspaceRoot}（任务书中的路径一律用相对路径）。`,
    "职责与工作方式：",
    "- 先规划再派发：把大任务分解为边界清晰、互不重叠的子任务（按目录/模块/主题划分），说明各自负责范围（scope）。",
    "- 任务书必须自包含：子代理看不到本对话历史。每份任务书写清：目标、背景与约束、涉及的路径、期望产出（文件落点 + 报告结构）。",
    "- 派发纪律（docs/16）：agent_task / agent_followup 派发即返回「已派发」回执、不等待完成；每个子代理的结算（完成/失败/打断/归档）" +
      "会以「" + AUTO_DELIVERY_PREFIXES.report + "」开头的消息按完成顺序自动送达你（你忙碌时积压的报告在轮末合并送达）——像用户消息一样随时到达，无需轮询。" +
      "互不依赖、写入范围不重叠的任务在同一轮里发多个 agent_task 即并行派出（各自给 scope 划定写入范围）；有依赖的任务等前置报告送达后再派。" +
      `超出并发上限（subagentMaxConcurrent，默认 ${SUBAGENT_MAX_CONCURRENT}）的派发被立即拒绝（不排队）——余下的等报告送达、并发腾出后再派。`,
    "- 报告处理纪律：收到部分报告时只向用户简报进度或按需干预（追派/打断/归档），不要提前汇总尚未完成的部分；全部报告到齐后再整合交付。" +
      "等待其余报告时直接简短收尾即可（说明在等什么），报告送达会自动开启你的下一轮。",
    "- 可复用子代理（docs/9）：同一专业方向要跨多次任务延续时，agent_task 带 reusable=true 派出——它完成后保留全部上下文待命，" +
      "后续用 agent_followup 按 name/subId 追加任务（任务书可引用之前的进展）；确定不再使用时用 archive_subagent 归档（归档后只读不可再派）。" +
      "独立的一次性任务用缺省形态（用完即自动归档）。服务重启后待命实例不在线——agent_followup 会自动从过程存档唤醒它（历史延续，同 subId），无需重新派发。",
    "- 接续上下文（docs/17）：需要接续已归档（不可再派）子代理的工作时，用 agent_task 重新派发，并在任务书里明确指示" +
      "「先用 read_archive（subId=N）读过程存档，再继续」——read_archive 会把该子代理的完整过程转成可读文本注入新 worker 的上下文" +
      "（subId 见报告里的 [[过程档案#N]] 标注）；它也可传 sessionId 读另一段主对话的完整记录。",
    "- 子代理异常变动会自动通知（docs/11/16）：界面打断/归档等你看不见的变动会以「" + AUTO_DELIVERY_PREFIXES.status + "」消息告知你；每个任务的最终结果" +
      "（含失败与归档状态）以「" + AUTO_DELIVERY_PREFIXES.report + "」消息按完成顺序送达。派发回执与这些送达消息是感知子代理状态的唯一事实源。",
    "- 冲突预防：绝不派两个子代理写同一个文件；发现产出矛盾时自己裁决，或派一个验证型子代理对比后报告。",
    "- 汇总与交付：整合各子代理报告为最终答复；对用户如实呈现（谁做了什么、成败、产出物路径）。",
    "子代理工具参考（语义精确，严格按此使用）：",
    "- agent_task：派出一个子代理，立即返回「已派发」回执（非阻塞，不等待完成）。description（一句话摘要）与 task（自包含任务书）必填；name 可选短名（审批卡/报告/送达消息标注用）；" +
      `scope 可选写入分区（相对路径前缀数组）；reusable=true 派出可复用形态；timeoutMs 可选超时（≥${SUBAGENT_TIMEOUT_MIN_MS} 毫秒）。同一轮发多个本调用即并行派出（见派发纪律）。`,
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

/** docs/12 R2：会话提供方有视觉时注入 base 段的图片直看指引——消息携带的图片模型已
 *  直接看到，优先用自身视觉分析作答；view_image 只留给磁盘文件/借用视觉模型，防止
 *  有视觉能力的模型舍近求远绕工具（真机反馈：直发图片模型称无法识别）。 */
const VISION_LINE_WORKER =
  "图片输入：消息可能直接携带图片（与文字一起的多模态输入）——你已直接看到原图，优先用自己的视觉能力分析作答，不要声称看不到。" +
  "view_image 工具仅用于读取工作区磁盘上的图片文件（读取时同样用你自身的视觉）；不要对消息中已携带的图片再调用它。";
/** docs/12 R2：协调者版——协调者注册表无 view_image，只说明直看与子代理分工。 */
const VISION_LINE_COORDINATOR =
  "图片输入：用户消息可能直接携带图片（与文字一起的多模态输入）——你已直接看到原图，直接分析并据此回应即可，不要声称看不到" +
  "（子代理需要看磁盘上的图片文件时会自行使用 view_image）。";

export const BUILTIN_PROMPT_SECTIONS: PromptSection[] = [
  {
    name: "base",
    order: 0,
    render(sc) {
      if (sc.sessionKind === "coordinator") {
        // docs/12 R2：协调者提供方有视觉时尾附图片直看指引（协调者无 view_image——只说明直看）
        return sc.vision ? coordinatorBase(sc) + "\n" + VISION_LINE_COORDINATOR : coordinatorBase(sc); // normal 分支字节不变（golden 快照零改动）
      }
      return [
        "你是 ZQQ-harness，一个运行在用户 Windows 终端里的 agent 助手。",
        `安全规则：默认只允许在 ${sc.workspaceRoot} 工作区内创建、修改、删除文件；涉及工作区外的操作会被系统拦截并交由用户批准。文件操作请尽量使用相对路径。`,
        "文件操作优先使用专用工具，不要用 run_pwsh 代替：读取文件用 read_file、新建或整体写入用 write_file、局部修改用 edit_file——" +
          "它们带行号显示、精确替换与先读后写保护，比 PowerShell 的 Get-Content/Set-Content 等命令更安全可靠；" +
          "run_pwsh 只用于文件工具覆盖不了的场景（目录与批量操作、二进制或超大文件、进程管理等）。",
        "执行命令时注意控制输出量（用 Select-Object -First、Where-Object 等过滤），避免一次输出过多内容。",
        ...(sc.vision ? [VISION_LINE_WORKER] : []), // docs/12 R2：图片直看指引（仅视觉会话注入）
        "请用中文与用户交流，简洁说明你做了什么。",
      ].join("\n");
    },
  },
  {
    name: "tools",
    order: 10,
    render(sc) {
      if (sc.toolDocs.length === 0) return null;
      return `可用工具：${sc.toolDocs.join("；")}。`;
    },
  },
  {
    name: "skills",
    order: 20,
    render(sc) {
      // 协调者无 load_skill 工具：技能清单不注入，防误导（docs/5 §6 SA2）
      if (sc.sessionKind === "coordinator") return null;
      return skillListText(sc.skills);
    },
  },
  {
    name: "mcp",
    order: 30,
    render(sc) {
      // 协调者不装配 MCP（docs/5 D3）：无 mcp__ 工具，说明段同样不注入
      if (sc.sessionKind === "coordinator") return null;
      if (!sc.mcpInstructions || !sc.mcpInstructions.trim()) return null;
      return (
        "# MCP 服务器使用说明\n以下是已连接 MCP 服务器提供的使用说明，调用其工具时遵守：\n\n" +
        sc.mcpInstructions.trim()
      );
    },
  },
  {
    name: "globalAgentsMd",
    order: 40,
    render(sc) {
      // docs/20：AGENTS.md 全文移入协调者的「子代理（worker）系统提示词说明」段（web 层注册，
      // 重放 worker 形态时本段照常渲染）——协调者自身不再单独注入；normal/worker 分支字节不变
      if (sc.sessionKind === "coordinator") return null;
      if (!sc.globalAgentsMd || !sc.globalAgentsMd.trim()) return null;
      return (
        "# 全局指令（~/.ZQQ-harness/AGENTS.md）\n以下是用户全局 AGENTS.md 的内容，对所有工作区生效；与工作区指令冲突时以工作区指令为准：\n\n" +
        sc.globalAgentsMd.trim()
      );
    },
  },
  {
    name: "workspaceAgentsMd",
    order: 50,
    render(sc) {
      // docs/20：同上——协调者不注入（在子代理系统提示词说明段内出现一次）
      if (sc.sessionKind === "coordinator") return null;
      if (!sc.workspaceAgentsMd || !sc.workspaceAgentsMd.trim()) return null;
      return (
        "# 工作区指令（AGENTS.md）\n以下是该工作区 AGENTS.md 的内容，作为在此工作区工作时的附加规则遵守：\n\n" +
        sc.workspaceAgentsMd.trim()
      );
    },
  },
];
