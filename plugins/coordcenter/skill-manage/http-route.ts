/**
 * skill-manage http-route — Skill 管理 HTTP 接口
 *
 * GET  /coordclaw-plugin/coordclawcenter/skill-list → 获取 Skill 列表
 * POST /coordclaw-plugin/coordclawcenter/skill-set  → 开关 Skill
 */

import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { getSkillList, setSkill } from "./handler";

const MODULE = "skill-manage";

// ==================== GET /skill-list ====================

async function handleSkillList(req: any, res: any) {
  const eventId = getEventId();
  const url = new URL(req.url || "/", "http://localhost");
  const agentId = url.searchParams.get("agentId") || url.searchParams.get("agent_id") || undefined;
  info(MODULE, `[HTTP] GET skill-list${agentId ? ` agent=${agentId}` : ""}`, eventId);
  try {
    const result = await getSkillList(agentId);
    sendJson(res, result.success ? 200 : 500, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] skill-list exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, skills: [], message: err.message });
  }
}

export function registerSkillListRoute(api: any): void {
  registerPluginRoute(api, {
    method: "GET",
    path: ROUTES.SKILL_LIST,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleSkillList(req, res);
    },
  }, MODULE);
}

// ==================== POST /skill-set ====================

async function handleSkillSet(req: any, res: any) {
  const eventId = getEventId();
  const { body } = await parseRequestBody(req);

  const skillName = (body?.skillName || body?.skill_name || "") as string;
  const enabled = body?.enabled !== false;
  const agentId = (body?.agentId || body?.agent_id || undefined) as string | undefined;

  if (!skillName) {
    warn(MODULE, `[HTTP] missing skillName`, eventId);
    sendJson(res, 400, { success: false, skillName: "", enabled: false, message: "skillName is required" });
    return;
  }

  info(MODULE, `[HTTP] POST skill-set ${skillName} → ${enabled ? "enabled" : "disabled"}${agentId ? ` agent=${agentId}` : " (global)"}`, eventId);
  try {
    const result = await setSkill({ skillName, enabled, agentId });
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] skill-set exception: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, skillName, enabled: false, message: err.message });
  }
}

export function registerSkillSetRoute(api: any): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.SKILL_SET,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      await handleSkillSet(req, res);
    },
  }, MODULE);
}
