/**
 * tools.edit-file 模块：edit_file 系统工具的注册入口。
 * 精确字符串替换编辑：old_string 须唯一命中；多次命中时可用 occurrence 指定第几处
 * （1 起始）或 replace_all 全部替换。前置要求本会话已 read_file（台账凭据）；写前
 * 有 hash 乐观锁校验（docs/5 §5.3，读取之后被并行子代理/外部进程改过即拒），匹配与
 * 替换在 LF 世界进行、写回时还原文件既有换行风格——机制在 core/file-tools.ts。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { adjudicateWrite, applyEdit, ledgerKey, readTextFile, resolveTarget, staleWriteCheck, stampOfText, writeTextAtomic } from "../../../core/file-tools.ts";

const def: SystemToolDef = {
  name: "edit_file",
  summary: "对文件做精确字符串替换（需先 read_file；多次命中可用 occurrence 指定第几处）",
  create(deps) {
    return {
      name: "edit_file",
      description:
        "编辑文本文件：每次调用必须同时提供 path（目标文件路径）、old_string 与 new_string 三个必填参数。" +
        "old_string 必须与文件内容逐字符一致；编辑前必须先 read_file 该文件。" +
        "old_string 在文件中多次出现时会报错——优先纳入更多上下文使其唯一，" +
        "内容相同只是位置不同时用 occurrence 指定第几处（1 起始），或设 replace_all=true 全部替换。" +
        "区外路径或 read-only 沙箱模式下会弹审批。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "必填，目标文件路径（相对工作区根，或绝对路径）——每次调用都不能省略" },
          old_string: { type: "string", description: "必填，要被替换的原文（逐字符精确匹配；不可为空）" },
          new_string: { type: "string", description: "必填，替换后的新文本（与 old_string 相同则无意义，会报错）" },
          occurrence: {
            type: "integer",
            description:
              "可选。old_string 在文件中出现多次时，指定要替换第几处（1 起始；按文档顺序数，" +
              "可配合 read_file 的行号输出定位）。超过实际出现次数会报错；与 replace_all 互斥",
          },
          replace_all: { type: "boolean", description: "可选，old_string 出现多次时是否全部替换（默认 false=报错）" },
          description: { type: "string", description: "可选，一句话说明这次编辑的目的（审批卡展示用）" },
        },
        required: ["path", "old_string", "new_string"],
      },
      async execute(args, ctx) {
        if (!String(args.path ?? "").trim()) {
          return "错误：缺少必填参数 path（要编辑的目标文件路径，相对工作区根或绝对路径）——把它与 old_string/new_string 一起提供后重新调用。";
        }
        let abs: string;
        let inside: boolean;
        try {
          const t = resolveTarget(ctx.workspace.root, String(args.path ?? ""));
          abs = t.abs;
          inside = t.inside;
        } catch (e) {
          return `错误：${e instanceof Error ? e.message : String(e)}`;
        }
        const key = ledgerKey(abs);
        // 写前校验（docs/5 §5.3）：先读后写凭据 + hash 乐观锁（不在这里刷新台账——
        // edit 的基底必须是 reader 上次见过的版本，被改过就拒绝并引导重读）
        const stale = staleWriteCheck(abs, key, deps.ledger, "编辑");
        if (!stale.ok) return stale.message;
        if (!stale.exists) return `错误：文件不存在：${abs}（编辑前先确认路径，或用 write_file 新建）`;

        const r = readTextFile(abs);
        if (!r.ok) return `错误：${r.message}`;
        const occRaw = args.occurrence;
        const occurrence = occRaw === undefined || occRaw === null || occRaw === "" ? undefined : Number(occRaw);
        const edit = applyEdit(
          r.text,
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
          args.replace_all === true,
          occurrence,
        );
        if (!edit.ok) return `错误：${edit.message}`;

        const gate = await adjudicateWrite({
          toolName: "edit_file",
          verb: "编辑",
          abs,
          inside,
          workspaceRoot: ctx.workspace.root,
          ...(ctx.writeScope ? { writeScope: ctx.writeScope } : {}),
          sandboxMode: deps.sandboxMode(), // docs/30：live 读——运行中改沙箱模式，本次裁决即用新值
          alwaysConfirm: deps.alwaysConfirm(),
          description: String(args.description ?? "") || undefined,
          requestApproval: ctx.requestApproval,
        });
        if (!gate.proceed) return gate.text;

        // 终检：等卡期间基底可能又被并行 worker/外部进程修改——过了才落盘
        const recheck = staleWriteCheck(abs, key, deps.ledger, "编辑");
        if (!recheck.ok) return recheck.message;

        writeTextAtomic(abs, edit.content);
        deps.ledger.noteRead(key, stampOfText(edit.content)); // 编辑后的最新内容视为已读（指纹同步）
        const totalLines = edit.content === "" ? 0 : edit.content.split("\n").length;
        return `已编辑 ${abs}（替换 ${edit.count} 处；文件现为 ${totalLines} 行）`;
      },
    };
  },
};

export const toolEditFile: HarnessModule = {
  name: "tools.edit-file",
  setup(ctx) {
    ctx.tools.register(def);
  },
};
