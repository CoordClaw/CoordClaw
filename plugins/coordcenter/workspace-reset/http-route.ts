/**
 * 功能模块：团队重置 - HTTP 路由注册
 *
 * HTTP 端点：
 * POST /coordclaw-plugin/coordclawcenter/workspace-reset
 * auth: plugin（无需 Token，PowerShell/curl 可直接调用）
 *
 * 功能：原子化执行 session-reset + workspace-delete，
 *       清除所有团队成员的对话历史和工作区文件。
 */

import { getEventId, debug } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, readRawBody } from "../shared/http-helpers";
import { HttpRouteConfig } from "../shared/types-http";
import { resetProjectWorkspaces } from "./handler";

const MODULE = "workspace-reset";

async function handleWorkspaceReset(config: HttpRouteConfig, req: any, res: any) {
  const eventId = getEventId();
  debug(MODULE, `[HTTP-DEBUG] STEP-A handleWorkspaceReset CALLED, url=${req?.url}, method=${req?.method}`, eventId);

  let body: any = {};
  let rawBody = "";
  try {
    debug(MODULE, `[HTTP-DEBUG] STEP-B reading raw body...`, eventId);
    rawBody = await readRawBody(req);
    debug(MODULE, `[HTTP-DEBUG] STEP-C rawBody.length=${rawBody.length}`, eventId);
    if (rawBody && rawBody.trim()) {
      body = JSON.parse(rawBody);
      debug(MODULE, `[HTTP-DEBUG] STEP-D JSON parsed, keys=[${Object.keys(body).join(",")}]`, eventId);
    } else {
      debug(MODULE, `[HTTP-DEBUG] STEP-D empty body`, eventId);
    }
  } catch (err: any) {
    debug(MODULE, `[HTTP-DEBUG] STEP-CATCH body parse error: ${err.message}`, eventId);
    body = {};
  }

  const reason = (body?.reason as string) || "manual";
  debug(MODULE, `[HTTP-DEBUG] STEP-E reason=${reason}`, eventId);

  debug(MODULE, `[HTTP-DEBUG] STEP-F calling resetProjectWorkspaces...`, eventId);
  const result = await resetProjectWorkspaces(config.jsonPath, config.cacheTtl, reason);
  debug(MODULE, `[HTTP-DEBUG] STEP-G resetProjectWorkspaces returned, success=${result.success}`, eventId);

  debug(MODULE, `[HTTP-DEBUG] STEP-H calling sendJson with status=${result.success ? 200 : 500}`, eventId);
  sendJson(res, result.success ? 200 : 500, result);
  debug(MODULE, `[HTTP-DEBUG] STEP-I sendJson done`, eventId);
}

export function registerWorkspaceResetRoute(api: any, config: HttpRouteConfig): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.WORKSPACE_RESET,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleWorkspaceReset(config, req, res);
    },
  }, MODULE);
}
