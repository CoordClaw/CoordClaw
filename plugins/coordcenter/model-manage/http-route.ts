/**
 * model-manage http-route — 模型管理 HTTP 接口
 *
 * GET  /coordclaw-plugin/coordclawcenter/model-list  → 获取可用模型列表
 * POST /coordclaw-plugin/coordclawcenter/model-set   → 设置 session 模型
 */

import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { getModelList, setSessionModel } from "./handler";

const MODULE = "model-manage";

// ==================== GET /model-list ====================

async function handleModelList(_req: any, res: any) {
  const eventId = getEventId();
  info(MODULE, `[HTTP] GET model-list`, eventId);
  try {
    const result = await getModelList();
    sendJson(res, result.success ? 200 : 500, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] model-list exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, models: [], message: err.message });
  }
}

export function registerModelListRoute(api: any): void {
  registerPluginRoute(api, {
    method: "GET",
    path: ROUTES.MODEL_LIST,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleModelList(req, res);
    },
  }, MODULE);
}

// ==================== POST /model-set ====================

async function handleModelSet(req: any, res: any) {
  const eventId = getEventId();
  const { body } = await parseRequestBody(req);

  const sessionKey = (body?.sessionKey || body?.session_key || undefined) as string | undefined;
  const agentId = (body?.agentId || body?.agent_id || undefined) as string | undefined;
  const model = body?.model;

  if (!sessionKey && !agentId && model === undefined) {
    sendJson(res, 400, { success: false, message: "model is required" });
    return;
  }

  const label = sessionKey ? `session=${sessionKey.slice(-32)}` : agentId ? `agent=${agentId}` : "global";
  info(MODULE, `[HTTP] POST model-set ${label} model=${model ?? "reset"}`, eventId);
  try {
    const result = await setSessionModel({ sessionKey, agentId, model });
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] model-set exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, sessionKey, message: err.message });
  }
}

export function registerModelSetRoute(api: any): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.MODEL_SET,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleModelSet(req, res);
    },
  }, MODULE);
}
