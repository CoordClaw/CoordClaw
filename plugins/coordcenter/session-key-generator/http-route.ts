/**
 * 功能模块：批量创建SessionKey - HTTP 路由注册
 *
 * HTTP 端点：
 * POST /coordclaw-plugin/coordclawcenter/session-key-generate - 批量创建sessionkey
 * POST /coordclaw-plugin/coordclawcenter/session-key-show - 显示当前状态
 * auth: plugin（无需 Token，PowerShell/curl 可直接调用）
 */

import { getEventId, info, warn } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { HttpRouteConfig } from "../shared/types-http";
import { batchCreateSessionKeys, showTeamSessionKeys, BatchCreateSessionKeysRequest } from "./handler";

export { HttpRouteConfig };

const MODULE = "session-key-generator";

async function handleBatchCreate(
  config: HttpRouteConfig,
  req: any,
  res: any
): Promise<void> {
  const eventId = getEventId();
  info(MODULE, `[HTTP] 收到 batch-create 请求`, eventId);

  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, `[HTTP] ${debugInfo}`, eventId);

  const request: BatchCreateSessionKeysRequest = {
    agentIds: body.agentIds,
    force: body.force === true,
    show: false,
  };

  const result = await batchCreateSessionKeys(config, request);
  sendJson(res, result.success ? 200 : 500, result);
}

async function handleShow(
  config: HttpRouteConfig,
  req: any,
  res: any
): Promise<void> {
  const eventId = getEventId();
  info(MODULE, `[HTTP] 收到 session-key-show 请求`, eventId);

  const result = await showTeamSessionKeys(config, MODULE);
  sendJson(res, result.success ? 200 : 500, result);
}

export function registerSessionKeyGeneratorRoutes(api: any, config: HttpRouteConfig): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SESSION_KEY_GENERATE,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleBatchCreate(config, req, res);
    },
  }, MODULE);

  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SESSION_KEY_SHOW,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleShow(config, req, res);
    },
  }, MODULE);

  info(MODULE, `[HTTP] 已注册 2 个路由`, getEventId());
}
