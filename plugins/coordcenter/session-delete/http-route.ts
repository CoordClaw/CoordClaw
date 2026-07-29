/**
 * 删除会话 - HTTP 路由注册
 *
 * POST /coordclaw-plugin/coordclawcenter/session-delete
 * auth: plugin（无需 Token，PowerShell/curl 可直接调用）
 *
 * 请求体: { "sessionKey": "agent:xxx:xxx" }
 */

import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { deleteSessionByKey } from "./handler";

const MODULE = "session-delete";

async function handleSessionDelete(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const sessionKey = (body?.sessionKey || body?.session_key || "") as string;

  if (!sessionKey) {
    warn(MODULE, `[HTTP] 请求缺少 sessionKey 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 sessionKey",
    });
    return;
  }

  info(MODULE, `[HTTP] 收到删除会话请求 sessionKey=${sessionKey}`, eventId);

  try {
    const result = await deleteSessionByKey({ sessionKey });
    sendJson(res, result.success ? 200 : 500, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] 删除会话异常: ${err.message}`, eventId);
    sendJson(res, 500, {
      success: false,
      message: `服务器内部错误: ${err.message}`,
    });
  }
}

/**
 * 注册删除会话路由
 */
export function registerSessionDeleteRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.SESSION_DELETE,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleSessionDelete(req, res);
      },
    },
    MODULE
  );

  info("plugin", `[INIT] session-delete 路由注册成功`, getEventId());
}
