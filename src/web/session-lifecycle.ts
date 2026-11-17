/**
 * 会话生命周期（模块化架构重构 §4.10，自 server.ts 迁出；web 壳的一部分，非模块）：
 * 绑定工作区、切换视图、建新会话、存档、空占位清扫、运行轮的启动与收尾。
 * 共享单例经 SessionShell 显式传递；createRuntime/视图状态等来自 session-runtime.ts。
 */
import { COMPACTION_PRESSURE } from "../config.ts";
import type { CompactOutcome } from "../compaction.ts";
import type { ChatImage, ChatMessage } from "../llm/provider.ts";
import { createWorkspace, readAgentsMd } from "../workspace.ts";
import { normalizeAskMode } from "../approval/types.ts";
import { normalizeSandboxMode } from "../sandbox/types.ts";
import { rememberWorkspace } from "./workspaces.ts";
import { AUTO_DELIVERY_PREFIXES, SSE_EVENTS } from "../core/events.ts";
import type { SessionData } from "./sessions.ts";
import type { SessionHost, SessionsPayload, SessionRuntime } from "../core/host.ts";
import {
  applyMcpInBackground,
  busyIds,
  cfgOf,
  createRuntime,
  currentState,
  rescanSkillsFor,
  type SessionShell,
} from "./session-runtime.ts";
import { workerMcpToolsOf } from "./subagents.ts";
import type { AttachmentStore } from "./attachments.ts";
import { toStoredMessages } from "./attachments.ts";

/** 会话标题截断（首条用户消息前 N 字符；docs/21 §2.4 低优先提名）。 */
export const SESSION_TITLE_MAX = 24;

/** 会话存档字段装配的单一出处（原三份重复字面量收敛）。title/messages 由调用方给定：
 *  创建即存档的空占位传 "" 与 []，persistSession 传首条用户消息标题与实际历史。
 *  docs/33：attachments 给定时消息里的图片转 {mime,ref} 引用（字节落附件库、档不嵌 base64；
 *  幂等去重）——缺省原样透传（旧形态兼容）。 */
export function toSessionData(rt: SessionRuntime, title: string, messages: ChatMessage[], attachments?: AttachmentStore): SessionData {
  return {
    id: rt.id,
    title,
    updatedAt: new Date().toISOString(),
    workspace: rt.workspace!.root,
    messageCount: messages.length,
    messages: toStoredMessages(attachments, messages),
    ...(rt.kind === "coordinator" ? { kind: "coordinator" as const } : {}),
    // worker 审计记录（SA4）：空时不写字段（旧档形状不变，向后兼容）；条数用于恢复配额续期
    ...(rt.subagents.length > 0 ? { subagents: rt.subagents } : {}),
    providerId: rt.providerId,
    effort: rt.settings.effort,
    askMode: rt.settings.askMode,
    sandboxMode: rt.settings.sandboxMode,
    events: rt.auditEvents,
    compactions: rt.compactions,
    totals: { ...rt.totals },
    // 累计运行毫秒（只计已结束的轮；>0 才写字段，旧档缺省=0 向后兼容）
    ...(rt.runMs > 0 ? { runMs: rt.runMs } : {}),
  };
}

/** 把某会话写入磁盘（无用户消息的空会话不落盘；未选工作区不可能有对话） */
export function persistSession(sh: SessionShell, rt: SessionRuntime | undefined): void {
  if (!rt || !rt.workspace) return;
  const msgs = rt.agent.messages.filter((m) => m.role !== "system");
  const firstUser = msgs.find((m) => m.role === "user");
  if (!firstUser || !firstUser.content) return;
  sh.sessions.save(toSessionData(rt, firstUser.content.slice(0, SESSION_TITLE_MAX), msgs, sh.attachments)); // docs/33：图片转附件库引用
  sh.broadcast(SSE_EVENTS.sessions, sessionsPayload(sh));
}

/**
 * 权限三键补丁的唯一应用口（docs/30）：审批卡「允许并不再询问 / 解除沙箱并放行」的
 * apply 补丁与 /api/settings 的权限键共用。白名单 askMode / alwaysConfirm / sandboxMode，
 * 值逐键归一化（野值忽略该键，不整包拒绝——审批卡流不因脏键失败）；沙箱键随
 * rt.agent.setSandboxMode 热更（pwsh/文件工具 live 读 deps，下一命令即生效，同轮内也算）。
 * busy 时跳过落盘：轮结束的自动存档会带上（运行中落盘可能捕到悬空 tool_calls 的半截
 * 历史）；空闲时立即落盘。收尾广播 state——顶栏下拉与审批卡按钮显隐随新值同步。
 */
export function applyPermissionPatch(host: SessionHost, rt: SessionRuntime, patch: unknown): void {
  const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  if (p.askMode === "ask" || p.askMode === "auto" || p.askMode === "never") {
    rt.settings.askMode = normalizeAskMode(p.askMode);
  }
  if (typeof p.alwaysConfirm === "boolean") rt.settings.alwaysConfirm = p.alwaysConfirm;
  const sandboxMode = normalizeSandboxMode(p.sandboxMode);
  if (sandboxMode === p.sandboxMode) {
    rt.settings.sandboxMode = sandboxMode;
    rt.agent.setSandboxMode(sandboxMode);
  }
  if (!rt.busy) host.persistSession(rt);
  host.broadcast(SSE_EVENTS.state, host.currentState(rt));
}

export function sessionsPayload(sh: SessionShell): SessionsPayload {
  return {
    current: sh.viewId,
    viewSeq: sh.viewSeq,
    running: busyIds(sh),
    groups: sh.sessions.listAllGrouped(sh.recentWorkspaces),
    recycled: sh.sessions.listRecycled(),
  };
}

/** 切换"正在查看"的会话 id（视图序号随每次切换递增，前端据此丢弃过期视图事件）。 */
function setView(sh: SessionShell, id: string): void {
  sh.viewId = id;
  sh.viewSeq++;
  sh.sessions.currentId = id;
}

/** 就地把引导会话绑定到工作区（仅当当前查看会话还是空引导态时使用，避免堆积空白会话）。
 *  协调者会话不装配 MCP（docs/5 D3）：apply 会往 registry 注册 mcp__ 工具，破坏「仅 agent_task」。
 *  docs/28 P1-3：MCP 连接改后台装配（applyMcpInBackground）——绑定立即返回，说明书在
 *  连接完成后热更进系统提示（startTurn 开跑前 await mcpReady 收口，工具可见性等价）。 */
export async function bindWorkspace(sh: SessionShell, rt: SessionRuntime, p: string): Promise<void> {
  rt.workspace = createWorkspace(p);
  if (rt.kind !== "coordinator") {
    applyMcpInBackground(sh, rt, rt.workspace.root);
  } else if (!rt.workerMcp) {
    // docs/20 修订：协调者绑工作区后预热 worker MCP（「子代理系统提示词说明」段需要
    // 说明书；createRuntime 对未绑工作区的引导会话不预热，避免把全局-only 连接缓存住、
    // 绑定后工作区级配置丢失）。docs/32 起升级为首轮闸门——挂 rt.mcpReady，startTurn
    // await 收口（绑定后的首条消息必见工作区级 MCP 说明，含失败重试后的最终状态）。
    rt.mcpReady = workerMcpToolsOf(sh, rt).then((): void => {}).catch(() => {});
  }
  // 系统提示立即装配（MCP 未连完时 instructions 为空——连接完成后 applyMcpInBackground 热更）
  rt.agent.setWorkspace(
    rt.workspace,
    readAgentsMd(rt.workspace.root),
    rescanSkillsFor(sh, rt),
    rt.kind === "coordinator" ? null : rt.mcp.instructionsText(),
    readAgentsMd(sh.userDir),
  );
  sh.recentWorkspaces = rememberWorkspace(sh.workspacesFile, sh.recentWorkspaces, rt.workspace.root);
  sh.sessions.removeFromOrder([rt.id]); // P1-4：换绑前清掉旧工作区 order 键（该 id 已不属于旧工作区）
  sh.sessions.prependOrder(rt.workspace.root, rt.id);
  // 与 newSessionForView 一致：创建即存档（空占位），当前会话立刻在侧边栏可见
  sh.sessions.save(toSessionData(rt, "", [], sh.attachments));
  sweepEmptySessions(sh);
}

/** 切换正在查看的会话（后台会话保持运行；运行中切换正是由此解锁）。 */
export async function switchView(sh: SessionShell, id: string): Promise<SessionRuntime | null> {
  const cached = sh.runtimes.get(id);
  let target: SessionRuntime;
  if (cached) {
    target = cached;
  } else {
    const data = sh.sessions.load(id);
    if (!data || data.recycled) return null; // 回收站中的会话需先恢复
    target = await createRuntime(sh, { id, fromDisk: data });
  }
  // 先切视图再归档旧视图：归档附带的 sessions 广播必须携带"新"current，
  // 否则客户端跟随逻辑会看到旧值又切回去，与服务端互相触发形成乒乓循环（表现为页面闪烁）
  const old = sh.runtimes.get(sh.viewId);
  setView(sh, id);
  if (old && old.id !== id) persistSession(sh, old);
  return target;
}

/** 在某工作区开一个新会话并切换视图（归档动作由调用方/切换时机负责）。
 *  kind="coordinator" 建协调者会话（仅 agent_task 工具，docs/5 D9）；缺省 normal。 */
export async function newSessionForView(
  sh: SessionShell,
  workspaceRoot: string | null,
  kind: "normal" | "coordinator" = "normal",
): Promise<SessionRuntime | null> {
  if (!workspaceRoot) return null;
  const rt = await createRuntime(sh, { workspaceRoot, ...(kind !== "normal" ? { kind } : {}) });
  setView(sh, rt.id);
  sh.sessions.prependOrder(workspaceRoot, rt.id); // 新对话默认在最上方
  // 创建即存档（空消息、暂无标题）：新对话立刻出现在侧边栏，而不是等首轮结束才可见；
  // 首轮结束后 persistSession 会用首条用户消息覆写标题
  sh.sessions.save(toSessionData(rt, "", [], sh.attachments));
  sweepEmptySessions(sh); // 及时创建的另一面：被切走的空占位不留垃圾
  return rt;
}

/** 退出当前工作区时切到全新引导会话（其他会话运行态不受影响）。 */
export async function switchToBlankRuntime(sh: SessionShell): Promise<SessionRuntime> {
  const blank = await createRuntime(sh, { workspaceRoot: null });
  setView(sh, blank.id);
  return blank;
}

/**
 * 清扫空会话存档：创建即存档保证了"点击即见"，但被切走的空占位（无任何用户消息）
 * 留着只会堆积。规则：messageCount=0、非当前视图、运行时不在后台跑轮（运行中的存档
 * 马上就会有内容）→ 删除；回收站里的空占位（删除工作区时产生）一并彻底清除。
 * 时机：每次新建会话后 + 服务启动时（顺带清理历史积累）。
 */
export function sweepEmptySessions(sh: SessionShell): void {
  const stubs = sh.sessions.list().filter((s) => s.messageCount === 0 && s.id !== sh.viewId);
  const dead = stubs.filter((s) => !sh.runtimes.get(s.id)?.busy);
  if (dead.length === 0) return;
  for (const s of dead) {
    if (s.recycled) sh.sessions.purge(s.id);
    else sh.sessions.delete(s.id);
  }
  sh.sessions.removeFromOrder(dead.map((s) => s.id));
  sh.broadcast(SSE_EVENTS.sessions, sessionsPayload(sh));
}

/** 执行某会话的一次压缩：成功则记账落盘，失败则提示且会话未改动。
 *  opts.keepTokens 透传 agent.compact（手动 /compact 传小预算，立即显著变小）。 */
export async function doCompact(sh: SessionShell, rt: SessionRuntime, opts?: { keepTokens?: number }): Promise<CompactOutcome> {
  const outcome = await rt.agent.compact(opts);
  if (outcome.ok) {
    rt.compactions.push(outcome.record);
    persistSession(sh, rt); // 替换后的 messages + compactions 记录同步落盘
  } else {
    sh.broadcast(SSE_EVENTS.info, { sessionId: rt.id, message: "压缩失败，会话未改动：" + outcome.reason });
  }
  return outcome;
}

/** 自动送达消息识别（docs/16）：子代理任务报告/状态通知的前缀——deliverToCoordinator 送达
 *  的两类消息（subagents.ts reportMessage 与 pause/archive 状态通知）都以此开头。 */
export function isAutoReport(text: string): boolean {
  return text.startsWith(AUTO_DELIVERY_PREFIXES.report) || text.startsWith(AUTO_DELIVERY_PREFIXES.status);
}

/** 从协调者收件箱取下一条待处理消息（docs/16）：队头 + 紧随其后的**连续**自动送达报告合并
 *  为一条（分隔线连接、只开一轮——协调者忙碌期间积压的多份完成报告一次消化，省轮次）；
 *  队头是用户消息时不合并（一次一条，W2-L1 FIFO 不变）。空收件箱返回空串（防御）。 */
export function takeCoordinatorTurnText(rt: SessionRuntime): string {
  const inbox = rt.inbox;
  if (!inbox?.length) return "";
  const head = inbox.shift()!;
  if (!isAutoReport(head)) return head;
  const parts = [head];
  while (inbox.length > 0 && isAutoReport(inbox[0])) parts.push(inbox.shift()!);
  return parts.length === 1 ? head : parts.join("\n\n――――\n\n");
}

export function startTurn(sh: SessionShell, rt: SessionRuntime, text: string, images?: ChatImage[]): void {
  rt.busy = true;
  rt.abortCtl = new AbortController();
  rt.turnStartedAt = Date.now(); // 本次运行计时（前端本地滴答；结束时并入 runMs 累计）
  rt.turnInfo = { ml: rt.agent.messages.length, userText: text }; // 轮锚点：切走再切回时前端据此补齐全部过程
  rescanSkillsFor(sh, rt); // 技能热重载：每轮开始重扫目录
  rt.agent.setSkills(rt.skills);
  // AGENTS.md 热重载：每轮开始重读全局与工作区文件，改动下一条消息即生效（setWorkspace 原地重建系统提示、保留历史）
  if (rt.workspace) {
    rt.agent.setWorkspace(rt.workspace, readAgentsMd(rt.workspace.root), undefined, undefined, readAgentsMd(sh.userDir));
  }
  sh.broadcast(SSE_EVENTS.state, currentState(sh, rt));
  void (async () => {
    try {
      await rt.mcpReady; // P1-3（docs/28）：MCP 后台装配收口——首条消息发出时 mcp__ 工具/说明书必已就位（永不 reject）
      // 压缩触发一（pressure 自动）：请求派生前压力 ≥ 阈值 → 先压缩再跑轮
      if (rt.agent.contextPressure(cfgOf(sh, rt).contextLength) >= COMPACTION_PRESSURE) {
        sh.broadcast(SSE_EVENTS.info, {
          sessionId: rt.id,
          message: `上下文占用已达阈值（${Math.round(COMPACTION_PRESSURE * 100)}%），自动压缩历史…`,
        });
        await doCompact(sh, rt);
      }
      await rt.agent.run(text, rt.abortCtl!.signal, images);
    } catch (e) {
      sh.broadcast(SSE_EVENTS.error, { sessionId: rt.id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      // 本次轮耗时并入累计（runMs 只含已结束的轮——busy 期间快照下发的 runMs 不含在飞部分，
      // 前端累计显示 = runMs + 进行中轮的本地滴答，无双算）
      if (rt.turnStartedAt !== null) rt.runMs += Date.now() - rt.turnStartedAt;
      rt.turnStartedAt = null;
      rt.busy = false;
      rt.abortCtl = null;
      rt.turnInfo = null;
      if (rt.pendingApproval) rt.pendingApproval("cancelled"); // 中断/异常路径下关闭挂起的审批（决议记 cancelled）
      persistSession(sh, rt); // 每轮结束自动存档
      sh.broadcast(SSE_EVENTS.turnEnd, { sessionId: rt.id });
      sh.broadcast(SSE_EVENTS.state, currentState(sh, rt));
      // W2-L1（docs/7 §2.3）：协调者会话轮末排空收件箱——按 FIFO 消费（下一条由新一轮的
      // finally 续上，不递归压栈）；被中止的轮同样续排（用户排队的消息仍要送达）。
      // docs/16：队头及其后连续的自动送达报告合并为一条只开一轮（用户消息仍一次一条）。
      // 上面的 busy 清零与本段在同一同步块内，无窗口被并发 /api/chat 插队。
      if (rt.kind === "coordinator" && rt.inbox?.length && sh.runtimes.get(rt.id) === rt) {
        startTurn(sh, rt, takeCoordinatorTurnText(rt));
      }
    }
  })();
}
