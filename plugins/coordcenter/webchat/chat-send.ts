import crypto from "node:crypto";

/**
 * 构造 chat.send 的 params —— 单一可信来源（DRY）。
 *
 * 升级版 openclaw 网关强制要求 idempotencyKey（缺则 INVALID_REQUEST 立即拒绝）；
 * 旧版 openclaw 对 schema 中不存在的字段采用"忽略/剥离"语义（additionalProperties:false
 * 全 dist 0 次），多传无副作用。此处统一构造，根除"一处带一处漏"的结构性缺陷。
 */
export function buildChatSendParams(sessionKey: string, message: string) {
  return { sessionKey, message, idempotencyKey: crypto.randomUUID() };
}
