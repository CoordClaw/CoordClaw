import { getEventId, info, warn, error } from "../shared/logger";
import { callGatewayRpc } from "../shared/gateway-rpc";

const MODULE = "session-steer";

export interface SteerDebugResult {
  success: boolean;
  message: string;
  sessionKey: string;
  injectedMessage: string;
  rpcResponse: any;
  steeredRunId: string | null;
  steerStatus: "steered" | "no-active-run" | "error";
  timestamp: string;
}

export async function steerSessionDebug(
  sessionKey: string,
  message?: string
): Promise<SteerDebugResult> {
  const eventId = getEventId();
  const timestamp = new Date().toISOString();
  const sessionKeyPreview = sessionKey.slice(0, 50);
  
  const defaultMessage = "你刚刚陷入推理循环了";
  const injectedMessage = message?.trim() || defaultMessage;

  if (!sessionKey || typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    warn(MODULE, `[DEBUG] sessionKey 为空`, eventId);
    return {
      success: false,
      message: "sessionKey 不能为空",
      sessionKey: sessionKey || "",
      injectedMessage,
      rpcResponse: null,
      steeredRunId: null,
      steerStatus: "error",
      timestamp,
    };
  }

  info(MODULE, `[DEBUG] === START === sessionKey=${sessionKeyPreview}, message="${injectedMessage}"`, eventId);

  setTimeout(async () => {
    const delayedEventId = getEventId();
    try {
      const rpcResponse = await callGatewayRpc({
        method: "sessions.steer",
        params: {
          key: sessionKey,
          message: injectedMessage,
        },
        timeoutMs: 10_000,
      });

      if (rpcResponse && typeof rpcResponse === 'object') {
        const runId = rpcResponse.runId ?? rpcResponse.steeredRunId ?? null;
        const status = (rpcResponse.status === "steered" || runId) ? "steered"
          : (rpcResponse.status === "no-active-run") ? "no-active-run"
          : (rpcResponse.ok === true) ? "steered"
          : "error";
        if (status === "steered") {
          info(MODULE, `[DEBUG] ✅ 延迟执行完成, steeredRunId=${runId}`, delayedEventId);
        } else {
          warn(MODULE, `[DEBUG] ⚠️ 延迟执行未成功, status=${status}`, delayedEventId);
        }
      } else {
        warn(MODULE, `[DEBUG] ⚠️ 延迟执行返回空`, delayedEventId);
      }
    } catch (err: any) {
      error(MODULE, `[DEBUG] 延迟执行异常: ${err?.message || String(err)}`, delayedEventId);
    }
  }, 500);

  return {
    success: true,
    message: `会话 ${sessionKeyPreview} 引导已提交（异步执行中）`,
    sessionKey,
    injectedMessage,
    rpcResponse: null,
    steeredRunId: null,
    steerStatus: "steered",
    timestamp,
  };
}
