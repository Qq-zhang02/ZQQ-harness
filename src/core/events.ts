/**
 * SSE 事件名单一出处：服务端 broadcast/send 与前端监听共同遵守的协议面。
 * core/contract.test.ts 用正则分别从 web/server.ts 与 index.html 提取实际使用的事件名，
 * 与本表双向比对——任何一端私增/私改/漏删事件名都会在测试期失败（防两端漂移）。
 * 协议约定（不变量，见重构文档 §6）：业务事件一律带 sessionId；delta/tool/toolResult 带 ml；
 * sessions 广播带单调递增 viewSeq。
 */
export const SSE_EVENTS = {
  /** 整体快照（连接建立/压缩后/切换装载）：{ sessionId, messages, state } */
  init: "init",
  /** 会话状态（busy/effort/工作区/模型/用量合计…）：currentState(rt) */
  state: "state",
  /** 流式增量：{ sessionId, ml, kind: "reasoning" | "content", text } */
  delta: "delta",
  /** 工具调用开始：{ sessionId, ml, name, preview, id? } */
  tool: "tool",
  /** 工具结果：{ sessionId, ml, output, meta, id? } */
  toolResult: "toolResult",
  /** 单次调用用量与累计：{ sessionId, call, totals, context } */
  usage: "usage",
  /** 系统提示行：{ sessionId, message } */
  info: "info",
  /** 压缩完成（前端渲染压缩卡片）：{ sessionId, ...CompactionRecord } */
  compaction: "compaction",
  /** 运行错误：{ sessionId, message } */
  error: "error",
  /** 审批卡：{ sessionId, ...ApprovalRequest } */
  approval: "approval",
  /** 一轮结束（前端收尾清扫运行中的工具块）：{ sessionId } */
  turnEnd: "turnEnd",
  /** 会话列表/视图变化：{ current, viewSeq, running, groups, recycled } */
  sessions: "sessions",
  /** 子代理生命周期与过程流（docs/5 SA4 + docs/6 P3 + docs/7 W2-S + docs/9 + docs/10 R1 + docs/28 P2）：
   *  { sessionId, subId, name, phase, summary?, rounds?, usage?, error?, transcript?, toolName?, preview?, args?, output?, id?,
   *    kind?, text?, ml?, reusable?, tasks?, ok?, contextPct? }
   *  phase: "spawned"（配额通过已启动）/ "delta"（docs/28 P2-1：思考/文字增量——kind
   *  "reasoning"|"content" + text，120ms 合并批；带 ml 锚点=worker 历史长度，切回重放经
   *  filterByMl 去重，与主对话 delta 同款语义）/ "tool" | "toolResult"（方案 B 实时过程流：
   *  工具调用与结果，带 toolName/preview 或截断 output，id=callId 供配对回填；docs/28 P2-2 起
   *  tool 附 args=完整参数（截 TOOL_EVENT_ARGS_MAX_CHARS）供前端展开体渲染；不带 ml，缓冲重放不过滤）/
   *  "task"（followup 起跑，docs/9）/ "idle"（可复用任务结束转待命，docs/9）/
   *  "archived"（归档定格：手动归档或上下文超线强制归档，docs/9 + docs/10 R1）/
   *  "done"（一次性完成，带用量）/ "error"（失败/中止/超时/打断，docs/18 起打断即终结）；
   *  contextPct（docs/10 R1）：任务收尾时的上下文占用百分比（idle/archived/done/error 携带）；
   *  transcript（docs/6 P3 方案 A）：过程存档相对路径，done/error 携带——前端据此显示「📄 过程」入口 */
  subagent: "subagent",
} as const;

export type SseEventName = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];

/** 自动送达消息前缀（docs/16 产生；docs/21 §2.4 协议解耦）：后端 subagents.ts 送达任务报告/
 *  状态通知以此开头，session-lifecycle.isAutoReport 与前端判别/剥前缀都比对这两个常量
 *  （经 /api/meta 下发为 autoReportPrefix/autoStatusPrefix）——文案调整不破协议。 */
export const AUTO_DELIVERY_PREFIXES = {
  report: "[子代理任务报告 · 自动送达]",
  status: "[子代理状态 · 自动送达]",
} as const;
