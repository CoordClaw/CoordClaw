/**
 * 删除会话核心逻辑
 *
 * 前端传入 sessionKey → 调用 Gateway RPC sessions.delete → 返回结果
 * 缓存刷新由前端自行调用 /cache-refresh 接口
 *
 * 复用 project-delete 中的 Gateway RPC 调用方式：
 *   callGateway({ method: "sessions.delete", params: { key: sessionKey } })
 */

import { info, warn, error, getEventId } from "../shared/logger";
import type { DeleteSessionRequest, SessionDeleteResult } from "./types";

const MODULE = "session-delete";

/** 调用 Gateway RPC 删除单个 session */
async function deleteSession(
  sessionKey: string
): Promise<{ success: boolean; error?: string }> {
  const eventId = getEventId();
  try {
    const { callGatewayRpc } = await import("../shared/gateway-rpc");

    const result = await callGatewayRpc({
      method: "sessions.delete",
      params: { key: sessionKey },
      timeoutMs: 10_000,
    });

    if (result && typeof result === "object" && result.ok === true) {
      info(MODULE, `[RPC] session 删除成功`, eventId);
      return { success: true };
    }

    warn(
      MODULE,
      `[RPC] 响应无效: ${JSON.stringify(result).slice(0, 200)}`,
      eventId
    );
    return {
      success: false,
      error: `Invalid response from sessions.delete: ${JSON.stringify(result).slice(0, 200)}`,
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    error(MODULE, `[RPC] session 删除失败: ${errMsg}`, eventId);
    return { success: false, error: errMsg };
  }
}

// ==================== 主入口 ====================

export async function deleteSessionByKey(
  req: DeleteSessionRequest
): Promise<SessionDeleteResult> {
  const eventId = getEventId();
  const { sessionKey } = req;

  info(
    MODULE,
    `[DELETE] === SESSION-DELETE START === sessionKey=${sessionKey}`,
    eventId
  );

  // Step 1: 校验参数
  if (!sessionKey) {
    const errMsg = "缺少必填参数: sessionKey";
    warn(MODULE, `[Step1] ${errMsg}`, eventId);
    return {
      success: false,
      message: errMsg,
      sessionKey: "",
      deleted: false,
      error: errMsg,
    };
  }

  // Step 2: 调用 Gateway RPC 删除 session
  const result = await deleteSession(sessionKey);

  // Step 3: 返回结果
  const message = result.success
    ? `会话 ${sessionKey} 删除成功`
    : `会话 ${sessionKey} 删除失败: ${result.error}`;

  info(MODULE, `[DELETE] === DONE === ${message}`, eventId);

  return {
    success: result.success,
    message,
    sessionKey,
    deleted: result.success,
    error: result.error,
  };
}
