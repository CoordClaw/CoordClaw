/**
 * 功能模块：会话重置 - HTTP 路由注册
 *
 * HTTP 端点：
 * POST /coordclaw-plugin/coordclawcenter/session-reset
 * auth: plugin（无需 Token，PowerShell/curl 可直接调用）
 *
 * 实现：直接调用 OpenClaw 内部 performGatewaySessionReset 函数，
 * 清除所有团队成员的 AI 会话上下文（等同于 /reset 命令）。
 */

import { getEventId, info } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { HttpRouteConfig } from "../shared/types-http";
import { resetAllTeamSessions, resetSingleSession } from "./handler";

const MODULE = "session-reset";

async function handleSessionReset(config: HttpRouteConfig, req: any, res: any) {
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, `[HTTP] ${debugInfo}`, getEventId());

  const sessionKey = body.sessionKey;

  if (typeof sessionKey === 'string' && sessionKey) {
    info(MODULE, `[HTTP] 开始处理单会话重置请求: sessionKey=${sessionKey.slice(0, 50)}...`, getEventId());
    const result = await resetSingleSession(sessionKey);
    sendJson(res, result.success ? 200 : 500, result);
  } else {
    info(MODULE, `[HTTP] 开始处理全部会话重置请求`, getEventId());
    const result = await resetAllTeamSessions(config.jsonPath, config.cacheTtl);
    sendJson(res, result.success ? 200 : 500, result);
  }
}

export function registerSessionResetRoute(api: any, config: HttpRouteConfig): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SESSION_RESET,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleSessionReset(config, req, res);
    },
  }, MODULE);
}