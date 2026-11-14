/**
 * Web 基础设施（模块化架构重构 §4.10，自 server.ts 迁入）：
 * readBody/json 是路由 handler 的公共助手；ServerRequest 把 req/res/url/body/json
 * 封装成一个实参传给 RouteDef.handler，web-* 模块不直接触碰 node:http。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** 请求体上限（docs/21 §2.2-①）：32MB——覆盖 /api/chat 图片消息的合法上限
 *  （4 张 × 5MB 解码后 base64 膨胀 ≈ 27.3MB）+ 余量；单张图片的 5MB 闸在
 *  web-sessions 的 parseChatImages（那才是生效的业务校验）。此前 1MB 会先于
 *  图片校验拦截，原图 ≳700KB 即被拒，"每张 ≤5MB"实际不可达。 */
export const HTTP_BODY_MAX_BYTES = 32 * 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > HTTP_BODY_MAX_BYTES) throw new Error("请求体过大");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 路由 handler 的请求实参：body() 只解析一次（缓存），json() 为应答快捷方式。 */
export interface ServerRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body(): Promise<Record<string, unknown>>;
  json(status: number, data: unknown): void;
}

export function toServerRequest(req: IncomingMessage, res: ServerResponse, url: URL): ServerRequest {
  let parsed: Promise<Record<string, unknown>> | null = null;
  return {
    req,
    res,
    url,
    body() {
      parsed ??= readBody(req);
      return parsed;
    },
    json(status, data) {
      json(res, status, data);
    },
  };
}
