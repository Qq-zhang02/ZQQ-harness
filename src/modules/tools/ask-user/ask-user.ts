/**
 * ask_user 工具实现（docs/32）：前台会话（普通+协调者）向用户发起选择题询问并阻塞等待
 * 回答。用于存在会改变做法的方向性不确定（需求歧义/方案取舍/破坏性操作确认）且无法从
 * 上下文合理推断时——问题+2~4 个互斥选项弹卡给用户点选，「其它」自由输入兜底。
 * 用户停止会话/请求中止 → cancelled 收场（模型不得假设答案）。
 * 子代理不可用（audience=front 不进 worker registry，workerDeps 也不注入接缝——双层防线）：
 * 子代理不确定时写进报告的「未决问题」，由协调者裁决或转询用户。
 */
import type { Tool } from "../../../tools/registry.ts";
import type { AskUserAnswer, SystemToolDeps } from "../../../core/types.ts";

/** 参数校验（ask_user）：question 必填；options 必须是 2~4 个非空短选项。非法返回错误文案。 */
export function parseAskUserArgs(args: Record<string, unknown>): { error: string } | { question: string; options: string[] } {
  const question = String(args.question ?? "").trim();
  if (!question) return { error: "错误：question 不能为空——把要确认的问题写清楚（它会原样展示给用户）。" };
  if (question.length > 2000) return { error: "错误：question 过长（≤2000 字符）——问题要具体、可直接回答；背景说明精炼成几句。" };
  const raw = args.options;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) {
    return { error: "错误：options 必须是 2~4 个选项的数组——少于 2 个构不成选择题，多于 4 个用户难以比较。" };
  }
  const options = raw.map((o) => String(o ?? "").trim());
  if (options.some((o) => !o)) return { error: "错误：options 里不能有空选项——每个选项写一句可点选的完整表述。" };
  if (options.some((o) => o.length > 200)) return { error: "错误：单个选项过长（≤200 字符）——选项要简短互斥；补充说明放进问题里。" };
  return { question, options };
}

/** 用户回答 → 面向模型的文案（工具结果）。 */
export function formatAskUserAnswer(a: AskUserAnswer, options: string[]): string {
  if (a.cancelled) {
    return "用户没有回答（会话已停止/请求已中止）——不要假设答案；按已知信息继续，或在合适时机再问。";
  }
  if (typeof a.text === "string" && a.text.trim()) {
    return `用户没有选给定选项，自行输入：${a.text.trim()}`;
  }
  if (typeof a.choice === "number" && Number.isInteger(a.choice) && a.choice >= 0 && a.choice < options.length) {
    return `用户选择了：${options[a.choice]}`;
  }
  return "用户没有给出有效回答——不要假设答案，按已知信息继续。";
}

/** ask_user：弹卡询问用户（docs/32）。接缝缺失时的文案即子代理防线（结构性不可达——
 *  worker registry 不注册本工具，此文案仅防装配异常）。 */
export function createAskUserTool(deps: SystemToolDeps): Tool {
  return {
    name: "ask_user",
    description:
      "向用户发起选择题询问并阻塞等待回答：存在会改变做法的方向性不确定（需求歧义、方案取舍、破坏性操作确认）且无法从上下文合理推断时使用。" +
      "问题要具体自包含（用户看不到你的思考过程）；给 2~4 个简短互斥的选项；用户也可以不选而自行输入其它答案。" +
      "能从任务上下文合理推断的就直接做，不要滥用提问；一个问题上把关键分歧问清，不要连环追问琐碎细节。" +
      "用户停止会话时本工具返回未回答提示——不要假设答案。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要向用户确认的问题（具体、自包含、可直接回答）" },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4,
          description: "2~4 个简短互斥的选项（每项一句完整表述；用户还可自行输入其它答案）",
        },
      },
      required: ["question", "options"],
    },
    async execute(args, ctx) {
      const parsed = parseAskUserArgs(args);
      if ("error" in parsed) return parsed.error;
      if (!deps.askUser) {
        return "错误：询问用户不可用（子代理不能直接向用户提问——把不确定之处写进报告的「未决问题」，由协调者裁决或转询用户）。";
      }
      const answer = await deps.askUser({ ...parsed, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      return formatAskUserAnswer(answer, parsed.options);
    },
  };
}
