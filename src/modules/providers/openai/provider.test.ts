import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider, toSdkMessages } from "./provider.ts";
import type { ChatMessage, ChatResult, LLMProvider } from "../../../llm/provider.ts";

const toolMsg: ChatMessage = {
  role: "assistant",
  content: null,
  toolCalls: [{ id: "t1", name: "f", arguments: "{}" }],
  thinking: { text: "工具前思考" },
};

const asRecords = (msgs: unknown): Record<string, unknown>[] => msgs as Record<string, unknown>[];

test("toSdkMessages：passback=true 时带工具调用的助手消息回传 reasoning_content", () => {
  const [m] = asRecords(toSdkMessages([toolMsg], true));
  assert.equal(m.reasoning_content, "工具前思考");
  assert.deepEqual(
    m.tool_calls,
    toolMsg.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })),
  );
});

test("toSdkMessages：passback=false（默认）不回传，结构与旧版逐字段一致", () => {
  const [m] = asRecords(toSdkMessages([toolMsg], false));
  assert.equal(m.reasoning_content, undefined);
  assert.ok("tool_calls" in m);
});

test("toSdkMessages：无工具调用的最终回答轮即使残留 thinking 也丢弃", () => {
  const final: ChatMessage = { role: "assistant", content: "答", toolCalls: [], thinking: { text: "最终思考" } };
  const [m] = asRecords(toSdkMessages([final], true));
  assert.equal(m.reasoning_content, undefined);
});

test("toSdkMessages：无 thinking 的消息不受 passback 影响", () => {
  const plain: ChatMessage = { role: "assistant", content: "答", toolCalls: [] };
  const [m] = asRecords(toSdkMessages([plain], true));
  assert.equal(m.reasoning_content, undefined);
  assert.equal(m.content, "答");
});

// ---- provider.chat 级别：开关 × 思考档位的请求体矩阵（stub SDK client，无网络） ----

async function* fakeStream(): AsyncGenerator<unknown> {
  yield { choices: [{ delta: { content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

/** 替换 provider 内部的 OpenAI client，捕获请求体并回放固定流。 */
function stubClient(p: OpenAICompatProvider): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  (p as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return fakeStream();
        },
      },
    },
  };
  return { bodies };
}

function makeProvider(effort?: "off" | "high" | "default"): OpenAICompatProvider {
  return new OpenAICompatProvider({ apiKey: "k", baseUrl: "https://example.invalid", model: "deepseek-x", ...(effort ? { effort } : {}) });
}

async function chatWithHistory(p: LLMProvider, messages: ChatMessage[]): Promise<ChatResult> {
  // 不传 params.effort：让 provider 配置档位生效（会话档位优先级更高，此处测的是提供方级开关）
  return p.chat({ messages });
}

const envBackup = (): { restore: () => void } => {
  const prev = process.env.REASONING_PASSBACK;
  return {
    restore: () => {
      if (prev === undefined) delete process.env.REASONING_PASSBACK;
      else process.env.REASONING_PASSBACK = prev;
    },
  };
};

test("chat：REASONING_PASSBACK=1 且思考模式 → 请求体带 reasoning_content；默认关不带回传", async () => {
  const env = envBackup();
  try {
    const on = makeProvider("high");
    const onStub = stubClient(on);
    process.env.REASONING_PASSBACK = "1";
    await chatWithHistory(on, [toolMsg]);
    const [mOn] = asRecords(onStub.bodies[0]!.messages);
    assert.equal(mOn.reasoning_content, "工具前思考");

    // 默认（env 未设）：即使思考模式也不回传（现状行为逐字节保留）
    delete process.env.REASONING_PASSBACK;
    const off = makeProvider("high");
    const offStub = stubClient(off);
    await chatWithHistory(off, [toolMsg]);
    const [mOff] = asRecords(offStub.bodies[0]!.messages);
    assert.equal(mOff.reasoning_content, undefined);
  } finally {
    env.restore();
  }
});

test("chat：开关开着但非思考档位（off/default）也不回传", async () => {
  const env = envBackup();
  process.env.REASONING_PASSBACK = "1";
  try {
    for (const effort of ["off", "default"] as const) {
      const p = makeProvider(effort);
      const stub = stubClient(p);
      await chatWithHistory(p, [toolMsg]);
      const [m] = asRecords(stub.bodies[0]!.messages);
      assert.equal(m.reasoning_content, undefined, effort);
      if (effort === "off") assert.deepEqual(stub.bodies[0]!.thinking, { type: "disabled" });
      if (effort === "default") assert.equal(stub.bodies[0]!.thinking, undefined);
    }
  } finally {
    env.restore();
  }
});

test("chat：流中 abort（SDK 流式迭代器吞 AbortError 优雅结束流的真机形态）→ 抛中止错误，不带空/半截累积正常返回", async () => {
  const p = makeProvider();
  const ctl = new AbortController();
  (p as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () =>
          // SDK Stream 形态：迭代器捕到流中 AbortError 后静默 return——流优雅结束，
          // 终止 chunk（finish_reason/usage）从未到达，累积器里只有半截 reasoning
          (async function* () {
            yield { choices: [{ delta: { reasoning_content: "半截思考" } }] };
            await new Promise<void>((resolve) => {
              if (ctl.signal.aborted) return resolve();
              ctl.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
      },
    },
  };
  const promise = p.chat({ messages: [{ role: "user", content: "hi" }], signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10)); // 让迭代器产出半截后挂住
  ctl.abort();
  // 修复前：chat 带空 content/无 toolCalls 正常返回 → 上层按「空回复」结算任务
  // （子代理手动暂停一次却给协调者送达两条消息的根因）；修复后必须抛错
  await assert.rejects(promise, /中止/);
});

test("专项：thinkingPassback 与 toSdkMessages 实际回传同源（token 计数口径对齐，§4.6）", () => {
  const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: "http://x", model: "m" });
  const withThink: ChatMessage = {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "t1", name: "f", arguments: "{}" }],
    thinking: { text: "工具前思考" },
  };
  const finalThink: ChatMessage = { role: "assistant", content: "完", toolCalls: [], thinking: { text: "最终轮思考" } };
  const plain: ChatMessage = { role: "user", content: "问" };
  const prev = process.env.REASONING_PASSBACK;
  try {
    for (const on of [false, true]) {
      process.env.REASONING_PASSBACK = on ? "1" : undefined;
      for (const effort of ["high", "low", "max", "off", "default"] as const) {
        const roundMsgs: ChatMessage[] = [withThink, finalThink, plain];
        for (const m of roundMsgs) {
          const pb: boolean = provider.thinkingPassback?.(m, effort) ?? false;
          // 以判定结果驱动实际映射：回传与否必须与判定一一对应（同源）
          const mapped = asRecords(toSdkMessages([m], pb))[0];
          const actual = "reasoning_content" in mapped;
          assert.equal(actual, pb, `env=${on} effort=${effort} role=${m.role}`);
          // 开关打开 + 思考模式 + 带工具调用：判定为真且 reasoning_content 内容一致
          if (pb) assert.equal(mapped.reasoning_content, m.role === "assistant" ? m.thinking?.text : undefined);
        }
      }
    }
    // 开关关闭（默认）：永不回传
    process.env.REASONING_PASSBACK = undefined;
    assert.equal(provider.thinkingPassback?.(withThink, "high"), false);
  } finally {
    if (prev === undefined) delete process.env.REASONING_PASSBACK;
    else process.env.REASONING_PASSBACK = prev;
  }
});

// ---------- docs/10 R3：图片消息 → OpenAI 多模态 content 数组 ----------

test("toSdkMessages：user 带 images 转 [text, image_url(data URI)]；无图消息保持纯字符串", () => {
  const img: ChatMessage = {
    role: "user",
    content: "这张图是什么",
    images: [
      { mime: "image/png", data: "QUJD" },
      { mime: "image/jpeg", data: "REVG" },
    ],
  };
  const mapped = toSdkMessages([img], false)[0] as unknown as { content: Array<{ type: string; text?: string; image_url?: { url: string } }> };
  assert.ok(Array.isArray(mapped.content), "带图消息 content 必须是数组");
  assert.equal(mapped.content[0]!.type, "text");
  assert.equal(mapped.content[0]!.text, "这张图是什么");
  assert.equal(mapped.content[1]!.type, "image_url");
  assert.equal(mapped.content[1]!.image_url!.url, "data:image/png;base64,QUJD");
  assert.equal(mapped.content[2]!.image_url!.url, "data:image/jpeg;base64,REVG");
  // 无图消息字节不变（纯字符串）
  const plain = toSdkMessages([{ role: "user", content: "问" }], false)[0] as unknown as { content: unknown };
  assert.equal(plain.content, "问");
});
