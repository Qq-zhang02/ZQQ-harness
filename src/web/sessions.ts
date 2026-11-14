/**
 * 会话持久化：每个对话一个 JSON 文件，存于 <用户目录>/sessions/。
 * 保存内容不含系统提示（按工作区重建）；标题取首条用户消息。
 * 另有会话手动排序（order.json，拖动后才写入，未拖动的会话按时间排在后面）
 * 与回收站（recycled 标记：工作区被删除时对话整体转入回收站，可恢复/彻底删除）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, EffortSetting, UsageBreakdown } from "../llm/provider.ts";
import type { AuditEvent, AskMode } from "../approval/types.ts";
import type { SandboxMode } from "../sandbox/types.ts";
import type { CompactionRecord } from "../compaction.ts";
import { sameDir } from "./workspaces.ts";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string; // ISO 时间
  workspace: string;
  messageCount: number;
  /** 会话形态（侧边栏 🎯 徽标用）：coordinator=协调者；subagent=子代理过程存档（spill 盘上，
   *  不进 sessions/ 目录，与主对话同构以便同一读取/恢复口径，docs/17）；缺省/旧档 = 普通会话 */
  kind?: "coordinator" | "subagent";
  /** 回收站标记（list/listWorkspace/listRecycled 输出用） */
  recycled?: boolean;
  recycledAt?: string;
}

/** 已完成 worker 的审计记录（docs/5 SA4，SessionData.subagents 的元素）：
 *  只记结果元数据不含 worker 全程 messages——那是两层架构的意义（上下文留在 worker）。
 *  从档恢复时以记录条数续期 rt.subagentTotal（配额累计闸，C7/偏差 15）。
 *  可复用子代理（docs/9）在存活期间按 subId upsert 本记录（state="idle"，每任务结束更新），
 *  归档时定格为 state="archived"；一次性子代理任务结束 append 一条 state="archived"。 */
export interface SubagentRecord {
  /** 服务实例内的派发序号（与审批标注/私有目录标签同源） */
  subId: number;
  name: string;
  description?: string;
  ok: boolean;
  rounds?: number;
  error?: string;
  usage?: { prompt: number; completion: number; reasoning?: number; cacheHit?: number };
  /** 全程过程存档（docs/6 P3 方案 A）：相对 spill/<sessionId>/ 的路径（<dirTag>/transcript.json）。
   *  只在用户点开时经 /api/subagent-transcript 读取渲染，不进前台历史/上下文（两层架构不破）；
   *  旧档无此字段＝该 worker 无存档（向后兼容）。 */
  transcript?: string;
  /** 可复用子代理标记（docs/9）：一次性子代理/旧档不写。 */
  reusable?: boolean;
  /** 可复用子代理已完成的任务数（docs/9；rounds/usage 为全部任务累计值，ok/error 为最近一次任务） */
  tasks?: number;
  /** 最近一次任务收尾时的上下文占用百分比（docs/10 R1；协调者判断是否继续使用该实例的
   *  依据——空不写，旧档缺省 = 无记录） */
  contextPct?: number;
  /** 累计运行毫秒（可复用=跨任务累计；一次性=单任务用时；空不写，旧档缺省=无记录） */
  elapsedMs?: number;
  /** 生命周期（docs/9；docs/17 修订重启语义）：idle=可复用待命（运行实例在内存；重启后
   *  实例不在线，agent_followup 自动从过程存档唤醒）；archived=已归档只读（不可再派，
   *  接续用 read_archive）；旧档缺省＝一次性已完成（=archived 语义）。 */
  state?: "idle" | "archived";
  /** 完成时间（ISO；可复用子代理为最近一次任务结束/归档时间） */
  at: string;
}

/** 子代理过程存档的元数据块（docs/17；SessionData.subagent，仅 kind:"subagent" 的存档文件携带）：
 *  与 SubagentRecord 同口径的累计统计 + 复活/重建所需的 Agent 构造期参数（scope/effort/system
 *  固定于首次派发——重启后 followup 唤醒时照此重装 Agent）。 */
export interface SubagentArchiveMeta {
  subId: number;
  name: string;
  description?: string;
  reusable: boolean;
  /** 已完成任务数（累计） */
  tasks: number;
  rounds?: number;
  usage?: { prompt: number; completion: number; reasoning?: number; cacheHit?: number };
  elapsedMs?: number;
  contextPct?: number;
  /** 落盘时的生命周期快照（idle=待命中；archived=已归档） */
  state: "idle" | "archived";
  /** Agent 构造期参数（复活重装用；缺省 = 继承会话当前值 / 无限制 / 无角色段） */
  effort?: EffortSetting;
  scope?: string[];
  system?: string;
}

export interface SessionData extends SessionMeta {
  messages: ChatMessage[];
  /** 会话形态：coordinator=协调者（仅 agent_task 工具，docs/5）；subagent=子代理过程存档
   *  （docs/17，落 spill 盘不进 sessions/ 列表）；缺省/旧档 = 普通会话 */
  kind?: "coordinator" | "subagent";
  /** 子代理存档元数据（docs/17；仅 kind:"subagent" 的存档文件携带，主会话档不写） */
  subagent?: SubagentArchiveMeta;
  /** 本会话派出的全部 worker 审计记录（空时不写字段，旧档兼容）；条数 = 恢复的 subagentTotal */
  subagents?: SubagentRecord[];
  /** 本对话使用的提供方 id（每个对话各自记录自己的模型） */
  providerId?: string;
  /** 本对话的思考档位（每个对话各自记录；default=不添加思考参数） */
  effort?: EffortSetting;
  /** 本对话的审批策略（ask=正常弹卡；never=无人值守，连审批卡都不弹） */
  askMode?: AskMode;
  /** 本对话的沙箱模式（三档，随会话存档/恢复） */
  sandboxMode?: SandboxMode;
  /** 审计事件（审批 asked/decided），log-only，绝不混进 messages */
  events?: AuditEvent[];
  /** 压缩记录（不可逆操作的台账；压缩前的完整备份在 <id>.precompact-<n>.json） */
  compactions?: CompactionRecord[];
  totals: {
    prompt: number;
    completion: number;
    cacheHit?: number;
    reasoning?: number;
    breakdown?: UsageBreakdown;
  };
  /** 累计运行毫秒（只计已结束的轮；旧档缺省 = 0） */
  runMs?: number;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionStore {
  currentId: string = randomUUID();
  private dir: string;
  /** 超长工具输出落盘根目录（<用户目录>/spill/<sessionId>/），随会话删除连带清理 */
  readonly spillRoot: string;
  private orderPath: string;
  private orderCache: Record<string, string[]> | null = null;

  constructor(baseDir: string) {
    this.dir = join(baseDir, "sessions");
    this.spillRoot = join(baseDir, "spill");
    mkdirSync(this.dir, { recursive: true });
    this.orderPath = join(this.dir, "order.json");
  }

  /** id 严格校验为 UUID，防路径穿越 */
  private file(id: string): string | null {
    return ID_RE.test(id) ? join(this.dir, `${id}.json`) : null;
  }

  /** 某会话的 spill 目录（id 须合法）。 */
  spillDir(id: string): string | null {
    return ID_RE.test(id) ? join(this.spillRoot, id) : null;
  }

  /** 连带删除某会话的 spill 目录（best-effort，不存在时静默）。 */
  private cleanSpill(id: string): void {
    const d = this.spillDir(id);
    if (d) rmSync(d, { recursive: true, force: true });
  }

  list(): SessionMeta[] {
    const out: SessionMeta[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f === "order.json") continue;
      if (/\.precompact-\d+\.json$/.test(f)) continue; // 压缩备份不是会话，不进列表也不解析
      try {
        const d = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as SessionData;
        if (d && typeof d.id === "string") {
          out.push({
            id: d.id,
            title: String(d.title ?? "(无标题)"),
            updatedAt: String(d.updatedAt ?? ""),
            workspace: String(d.workspace ?? ""),
            messageCount: Number(d.messageCount ?? 0),
            ...(d.kind === "coordinator" ? { kind: "coordinator" as const } : {}),
            recycled: d.recycled === true,
            recycledAt: d.recycledAt,
          } as SessionMeta);
        }
      } catch {
        // 跳过损坏文件
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  load(id: string): SessionData | null {
    const f = this.file(id);
    if (!f || !existsSync(f)) return null;
    try {
      const d = JSON.parse(readFileSync(f, "utf8")) as SessionData;
      return Array.isArray(d.messages) ? d : null;
    } catch {
      return null;
    }
  }

  save(data: SessionData): void {
    const f = this.file(data.id);
    if (f) writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
  }

  delete(id: string): void {
    const f = this.file(id);
    if (f && existsSync(f)) {
      rmSync(f);
      this.cleanSpill(id); // 会话已删，超长输出存档一并清理
    }
  }

  newCurrent(): string {
    this.currentId = randomUUID();
    return this.currentId;
  }

  // ---- 手动排序（拖动后写入 order.json；未拖动的会话不进排序列表，按时间排在后面） ----

  private loadOrder(): Record<string, string[]> {
    if (!this.orderCache) {
      try {
        const parsed = JSON.parse(readFileSync(this.orderPath, "utf8")) as unknown;
        this.orderCache =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, string[]>)
            : {};
      } catch {
        this.orderCache = {};
      }
    }
    return this.orderCache;
  }

  private saveOrder(): void {
    writeFileSync(this.orderPath, JSON.stringify(this.orderCache ?? {}, null, 2), "utf8");
  }

  /** 某工作区的会话列表：手动顺序优先，其余（旧会话/未排序）按时间倒序补充在后；不含回收站。 */
  listWorkspace(workspace: string): SessionMeta[] {
    const mine = this.list().filter((s) => !s.recycled && sameDir(s.workspace, workspace));
    const byId = new Map(mine.map((s) => [s.id, s] as const));
    const out: SessionMeta[] = [];
    for (const id of this.loadOrder()[workspace] ?? []) {
      const s = byId.get(id);
      if (s) {
        out.push(s);
        byId.delete(id);
      }
    }
    out.push(...[...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
    return out;
  }

  /** 所有工作区的会话分组（工作区树用）：顺序同入参；有会话但不在入参中的工作区按时间倒序补在后。 */
  listAllGrouped(workspaces: string[]): { workspace: string; items: SessionMeta[] }[] {
    const out = workspaces.map((w) => ({ workspace: w, items: this.listWorkspace(w) }));
    const known = (ws: string) => workspaces.some((k) => sameDir(k, ws));
    const orphans = new Map<string, SessionMeta[]>();
    for (const s of this.list()) {
      if (s.recycled || known(s.workspace)) continue;
      if (!orphans.has(s.workspace)) orphans.set(s.workspace, []);
      orphans.get(s.workspace)!.push(s);
    }
    for (const [workspace, items] of orphans) {
      items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      out.push({ workspace, items });
    }
    return out;
  }

  listRecycled(): SessionMeta[] {
    return this.list()
      .filter((s) => s.recycled)
      .sort((a, b) => ((a.recycledAt ?? a.updatedAt) < (b.recycledAt ?? b.updatedAt) ? 1 : -1));
  }

  /** 覆盖某工作区的手动顺序（UI 拖动后调用）。 */
  setOrder(workspace: string, ids: string[]): void {
    this.loadOrder()[workspace] = ids.filter((x) => typeof x === "string" && x);
    this.saveOrder();
  }

  /** 新会话置顶。 */
  prependOrder(workspace: string, id: string): void {
    const o = this.loadOrder();
    o[workspace] = [id, ...(o[workspace] ?? []).filter((x) => x !== id)];
    this.saveOrder();
  }

  /** 从所有工作区的手动排序中移除指定会话（会话已删除时调用，防 order.json 积累死 id）。 */
  removeFromOrder(ids: string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    const o = this.loadOrder();
    for (const k of Object.keys(o)) {
      if (o[k].some((x) => drop.has(x))) o[k] = o[k].filter((x) => !drop.has(x));
    }
    this.saveOrder();
  }

  // ---- 回收站 ----

  /** 删除工作区：其中未回收的会话全部标记进回收站，返回移动数量。手动排序一并失效。
   *  空占位档（创建即存档、尚无任何消息）没有可回收的内容，直接删除、不进回收站。 */
  recycleWorkspace(workspace: string): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f === "order.json") continue;
      const p = join(this.dir, f);
      try {
        const d = JSON.parse(readFileSync(p, "utf8")) as SessionData;
        if (!d || typeof d.workspace !== "string" || d.recycled) continue;
        if (!sameDir(d.workspace, workspace)) continue;
        if (d.messageCount === 0 && (!Array.isArray(d.messages) || d.messages.length === 0)) {
          this.delete(d.id); // 空占位：连带清理 spill，直接删
          continue;
        }
        d.recycled = true;
        d.recycledAt = now;
        writeFileSync(p, JSON.stringify(d, null, 2), "utf8");
        n++;
      } catch {
        // 跳过损坏文件
      }
    }
    const o = this.loadOrder();
    for (const k of Object.keys(o)) {
      if (sameDir(k, workspace)) delete o[k];
    }
    this.saveOrder();
    return n;
  }

  /** 从回收站恢复（清除标记），返回会话数据；不存在返回 null。 */
  restore(id: string): SessionData | null {
    const f = this.file(id);
    if (!f || !existsSync(f)) return null;
    try {
      const d = JSON.parse(readFileSync(f, "utf8")) as SessionData;
      if (d.recycled) {
        delete d.recycled;
        delete d.recycledAt;
        writeFileSync(f, JSON.stringify(d, null, 2), "utf8");
      }
      return d;
    } catch {
      return null;
    }
  }

  /** 彻底删除（回收站内），返回是否删除了文件；超长输出 spill 目录连带删除。 */
  purge(id: string): boolean {
    const f = this.file(id);
    if (!f || !existsSync(f)) return false;
    rmSync(f);
    this.cleanSpill(id);
    // 压缩备份一并清理（会话已不存在，备份失去意义）
    for (const f2 of readdirSync(this.dir)) {
      if (f2.startsWith(`${id}.precompact-`) && f2.endsWith(".json")) rmSync(join(this.dir, f2), { force: true });
    }
    return true;
  }

  /**
   * 压缩前备份：把原 history 写到 <id>.precompact-<n>.json（重启后手动可救）。
   * best-effort：写盘失败不抛错（压缩照常进行，只是少了退路）。
   */
  backupBeforeCompact(id: string, history: ChatMessage[]): void {
    try {
      const f = this.file(id);
      if (!f) return;
      let n = 0;
      for (const f2 of readdirSync(this.dir)) {
        const m = new RegExp(`^${id}\\.precompact-(\\d+)\\.json$`).exec(f2);
        if (m) n = Math.max(n, Number(m[1]));
      }
      writeFileSync(
        join(this.dir, `${id}.precompact-${n + 1}.json`),
        JSON.stringify({ id, backedUpAt: new Date().toISOString(), messages: history }, null, 2),
        "utf8",
      );
    } catch {
      // best-effort
    }
  }
}
