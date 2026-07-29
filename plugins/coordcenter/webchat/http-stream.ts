/**
 * Gateway HTTP `/v1/chat/completions` SSE 代理
 *
 * 标准 OpenAI SSE 格式：stream:true → chat.completion.chunk
 * - 逐 token 真流式（非 RPC chat.history 轮询模拟）
 * - 多轮记忆靠 x-openclaw-session-key（canonical agent:main:<id>）
 * - 只发最新一条 user 消息（session-key 记忆是真相源）
 */

import { resolveGatewayUrl, resolveGatewayToken } from "../shared/paths";

/** 默认 agent ID，model 与 canonical key 前缀都由它派生（砍F：单源） */
export const DEFAULT_AGENT = "main";

/** 首包超时 ms（120s > 冷启动 60s 上限）；流中不设超时 */
export const FIRST_BYTE_MS = 120_000;

/**
 * 解析 SSE chunk 中的 delta 文本。
 * 跳过 [DONE]、role chunk、tool_calls chunk（V5/S6）。
 * @returns delta 文本，若无则 null
 */
export function parseSSEDelta(data: string): string | null {
  const lines = data.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const body = line.slice(6);
    if (body === "[DONE]") continue;
    try {
      const json = JSON.parse(body);
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      // 跳过 role / tool_calls chunk（仅取 content）
      if ("tool_calls" in delta && !delta.content) continue;
      if (Object.keys(delta).length === 1 && "role" in delta) continue;
      if (delta.content) return delta.content;
    } catch {
      // 非 JSON 行（如 "[DONE]") 正常跳过
    }
  }
  return null;
}

/**
 * POST Gateway /v1/chat/completions 并返回 response。
 * 调用方从 res.body 逐 chunk 读取并 parseSSEDelta。
 *
 * @throws {status: number} 非 2xx 响应（402/401/404/5xx...）
 */
export async function fetchGatewaySSE(
  text: string,
  sessionKey: string,
  signal: AbortSignal,
): Promise<Response> {
  const baseUrl = resolveGatewayUrl().replace(/\/$/, "");
  const url = `${baseUrl}/v1/chat/completions`;
  const token = resolveGatewayToken();

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: `openclaw/${DEFAULT_AGENT}`,
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!response.ok) {
    const err: any = new Error(`Gateway HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response;
}
