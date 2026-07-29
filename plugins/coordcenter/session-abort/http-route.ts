import { getEventId, info, warn, error, debug } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { HttpRouteConfig } from "../shared/types-http";
import { abortSession, abortAllTeamSessions, abortSessionDebug } from "./handler";

const MODULE = "session-abort";

async function handleSessionAbort(config: HttpRouteConfig, req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  debug(MODULE, debugInfo, eventId);

  const sessionKey = (body?.sessionKey || body?.session_key || "") as string;

  if (!sessionKey) {
    info(MODULE, `[HTTP] 未指定 sessionKey，中止全部团队成员`, eventId);
    const result = await abortAllTeamSessions(config.jsonPath, config.cacheTtl);
    sendJson(res, result.success ? 200 : 500, result);
    return;
  }

  info(MODULE, `[HTTP] 收到停止请求 sessionKey=${sessionKey.slice(0, 50)}`, eventId);
  const result = await abortSession(sessionKey);
  sendJson(res, result.success ? 200 : 500, result);
}

async function handleSessionAbortDebug(config: HttpRouteConfig, req: any, res: any) {
  const eventId = getEventId();
  const { body, rawBody, debugInfo } = await parseRequestBody(req);
  debug(MODULE, `[DEBUG] ${debugInfo}`, eventId);
  debug(MODULE, `[DEBUG] body.keys=${Object.keys(body).join(',')}`, eventId);
  debug(MODULE, `[DEBUG] body.sessionKey=${body?.sessionKey}`, eventId);
  debug(MODULE, `[DEBUG] body.session_key=${body?.session_key}`, eventId);

  const sessionKey = (body?.sessionKey || body?.session_key || "") as string;

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

  debug(MODULE, `[HTTP-DEBUG] ✅ 收到调试请求 sessionKey=${sessionKey.slice(0, 50)}`, eventId);
  const result = await abortSessionDebug(sessionKey);
  sendJson(res, result.success ? 200 : 500, result);
}

export function registerSessionAbortRoute(api: any, config: HttpRouteConfig): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SESSION_ABORT,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleSessionAbort(config, req, res);
    },
  }, MODULE);

  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SESSION_ABORT_DEBUG,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleSessionAbortDebug(config, req, res);
    },
  }, MODULE);
}