/**
 * tools.write-file 模块：write_file 系统工具的注册入口。
 * 创建新文件（含中间目录）或整体覆写已有文件；覆写前要求本会话已 read_file 过该文件
 * （台账凭据）——防止模型凭想象整文件重写毁掉用户数据。写前另有 hash 乐观锁校验
 * （docs/5 §5.3）：读取之后文件被并行子代理/外部进程改过即拒（lost update 防线），
 * 审批等待窗口内的修改由落盘前终检兜住。沙箱裁决（区外/read-only 弹审批、scope 分区
 * 硬拒）复用 core/file-tools.ts 的 adjudicateWrite。
 */
import type { HarnessModule } from "../../../core/module.ts";
import type { SystemToolDef } from "../../../core/types.ts";
import { adjudicateWrite, ledgerKey, resolveTarget, staleWriteCheck, stampOfText, writeTextAtomic } from "../../../core/file-tools.ts";

const def: SystemToolDef = {
  name: "write_file",
  summary: "创建新文件或整体覆写文件（覆写已有文件前需先 read_file）",
  create(deps) {
    return {
      name: "write_file",
      description:
        "把完整内容写入文件：新文件直接创建（自动建父目录）；覆写已存在的文件必须先用 read_file 读过，" +
        "否则会被拒绝（防止误毁已有内容）。只支持文本（UTF-8）；局部修改请改用 edit_file 而不是整文件重写。" +
        "区外路径或 read-only 沙箱模式下会弹审批。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径（相对工作区根，或绝对路径）" },
          content: { type: "string", description: "要写入的完整内容（整体覆写，不做合并）" },
          description: { type: "string", description: "可选，一句话说明这次写入的目的（审批卡展示用）" },
        },
        required: ["path", "content"],
      },
      async execute(args, ctx) {
        const content = String(args.content ?? "");
        let abs: string;
        let inside: boolean;
        try {
          const t = resolveTarget(ctx.workspace.root, String(args.path ?? ""));
          abs = t.abs;
          inside = t.inside;
        } catch (e) {
          return `错误：${e instanceof Error ? e.message : String(e)}`;
        }

        // 写前校验（docs/5 §5.3）：先读后写凭据 + hash 乐观锁合一（并行 worker 的 lost update 防线）
        const key = ledgerKey(abs);
        const stale = staleWriteCheck(abs, key, deps.ledger, "写入");
        if (!stale.ok) return stale.message;

        const gate = await adjudicateWrite({
          toolName: "write_file",
          verb: "写入",
          abs,
          inside,
          workspaceRoot: ctx.workspace.root,
          ...(ctx.writeScope ? { writeScope: ctx.writeScope } : {}),
          sandboxMode: ctx.sandboxMode,
          alwaysConfirm: ctx.alwaysConfirm,
          description: String(args.description ?? "") || undefined,
          requestApproval: ctx.requestApproval,
        });
        if (!gate.proceed) return gate.text;

        // 终检：等卡期间文件可能又被并行 worker/外部进程修改——同一 expected 再校验一次才落盘
        const recheck = staleWriteCheck(abs, key, deps.ledger, "写入");
        if (!recheck.ok) return recheck.message;

        writeTextAtomic(abs, content);
        deps.ledger.noteRead(key, stampOfText(content)); // 写后更新指纹：允许本 reader 连续写
        const lines = content === "" ? 0 : content.split("\n").length;
        return `已写入 ${abs}（${lines} 行，${content.length} 字符${stale.exists ? "，覆写" : "，新建"}）`;
      },
    };
  },
};

export const toolWriteFile: HarnessModule = {
  name: "tools.write-file",
  setup(ctx) {
    ctx.tools.register(def);
  },
};
