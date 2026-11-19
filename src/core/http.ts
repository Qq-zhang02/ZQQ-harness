/**
 * Web 基础设施（模块化架构重构 §4.10，自 server.ts 迁入）：
 * readBody/json 是路由 handler 的公共助手；ServerRequest 把 req/res/url/body/json
 * 封装成一个实参传给 RouteDef.handler，web-* 模块不直接触碰 node:http。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** 请求体上限（docs/21 §2.2-① → 阶段 B 第二批阈值键 httpBodyMaxBytes）：缺省 32MB——覆盖
 *  /api/chat 图片消息的合法上限（4 张 × 5MB 解码后 base64 膨胀 ≈ 27.3MB）+ 余量；**校验强制
 *  ≥ HTTP_BODY_FLOOR_BYTES（config.ts 由 IMAGE_RULES 派生的地板值）**——此前 1MB 会先于图片
 *  校验拦截，原图 ≳700KB 即被拒。单张图片的 5MB 闸在 web-sessions 的 parseChatImages（那才是
 *  生效的业务校验）。config.ts 单一出处（initConfig 热重绑），此处 re-export 供既有 import 不变。 */
import { THRESHOLDS } from "../config.ts";

/** SSE 心跳间隔（docs/21 §2.4 提名；与 MCP 握手超时同量级，不配置化）：server.ts 每 20s 写 :ping
 *  注释行保活连接。 */
export const SSE_PING_MS = 20_000;

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > THRESHOLDS.httpBodyMaxBytes) throw new Error("请求体过大");
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
