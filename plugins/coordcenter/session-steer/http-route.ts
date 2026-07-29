import { getEventId, info, warn, error, debug } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { HttpRouteConfig } from "../shared/types-http";
import { steerSessionDebug } from "./handler";

const MODULE = "session-steer";

async function handleSessionSteerDebug(config: HttpRouteConfig, req: any, res: any) {
  const eventId = getEventId();
  const { body, rawBody, debugInfo } = await parseRequestBody(req);
  debug(MODULE, `[DEBUG] ${debugInfo}`, eventId);
  warn(MODULE, `[DEBUG] body.keys=${Object.keys(body).join(',')}`, eventId);
  warn(MODULE, `[DEBUG] body.sessionKey=${body?.sessionKey}`, eventId);
  warn(MODULE, `[DEBUG] body.message=${body?.message || '(使用默认消息)'}`, eventId);

  const sessionKey = (body?.sessionKey || body?.session_key || "") as string;
  const message = (body?.message || body?.msg || "") as string;

  if (!sessionKey) {
    error(MODULE, `[DEBUG] ❌ sessionKey 为空! 返回400错误`, eventId);
    sendJson(res, 400, { 
      success: false, 
      message: "缺少 sessionKey 参数", 
      timestamp: new Date().toISOString(),
      debug: {
        rawBodyLength: rawBody.length,
        rawBodyPreview: rawBody.slice(0, 300),
        parsedKeys: Object.keys(body),
      }
    });
    return;
  }

  debug(MODULE, `[HTTP-DEBUG] ✅ 收到引导请求 sessionKey=${sessionKey.slice(0, 50)}, message="${message || '默认: 你刚刚陷入推理循环了'}"`, eventId);
  
  const result = await steerSessionDebug(sessionKey, message || undefined);
  sendJson(res, result.success ? 200 : 500, result);
}

export function registerSessionSteerRoute(api: any, config: HttpRouteConfig): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SESSION_STEER_DEBUG,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleSessionSteerDebug(config, req, res);
    },
  }, MODULE);
}