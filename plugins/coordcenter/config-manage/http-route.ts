/**
 * config-manage http-route — openclaw.json 热更新接口
 *
 * POST /coordclaw-plugin/coordclawcenter/config-patch → config.patch（部分更新）
 * POST /coordclaw-plugin/coordclawcenter/config-apply → config.apply（完整替换）
 */

import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { patchConfig, applyConfig, getConfig } from "./handler";

const MODULE = "config-manage";

// ==================== POST /config-patch ====================

async function handleConfigPatch(req: any, res: any) {
  const eventId = getEventId();
  const { body, rawBody } = await parseRequestBody(req);

  // 优先使用 raw 字段（JSON5 字符串），否则用整个 body 序列化
  let raw: string = body?.raw as string;
  if (!raw && rawBody) raw = rawBody;

  if (!raw) {
    warn(MODULE, `[HTTP] missing raw`, eventId);
    sendJson(res, 400, { success: false, message: "raw is required (JSON5 string)" });
    return;
  }

  info(MODULE, `[HTTP] POST config-patch`, eventId);
  try {
    const result = await patchConfig(raw);
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] config-patch exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, message: err.message });
  }
}

export function registerConfigPatchRoute(api: any): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.CONFIG_PATCH,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleConfigPatch(req, res);
    },
  }, MODULE);
}

// ==================== POST /config-apply ====================

async function handleConfigApply(req: any, res: any) {
  const eventId = getEventId();
  const { body } = await parseRequestBody(req);

  if (!body || typeof body !== "object") {
    warn(MODULE, `[HTTP] invalid body`, eventId);
    sendJson(res, 400, { success: false, message: "body must be a valid JSON object" });
    return;
  }

  // 去掉内部字段，只传纯配置
  const { raw, ...config } = body;

  info(MODULE, `[HTTP] POST config-apply`, eventId);
  try {
    const result = await applyConfig(config);
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] config-apply exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, message: err.message });
  }
}

export function registerConfigApplyRoute(api: any): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.CONFIG_APPLY,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleConfigApply(req, res);
    },
  }, MODULE);
}

// ==================== GET /config-get ====================

async function handleConfigGet(req: any, res: any) {
  const eventId = getEventId();
  info(MODULE, `[HTTP] GET config-get`, eventId);
  try {
    const result = await getConfig();
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] config-get exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, message: err.message });
  }
}

export function registerConfigGetRoute(api: any): void {
  registerPluginRoute(api, {
    method: "GET",
    path: ROUTES.CONFIG_GET,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleConfigGet(req, res);
    },
  }, MODULE);
}
