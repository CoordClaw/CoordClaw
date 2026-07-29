import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { createTeam, repairTeamAgents } from "./handler";

const MODULE = "team-create";

/**
 * POST /coordclaw-plugin/coordclawcenter/team-create
 *
 * 新建团队：两阶段流程
 *   Phase 1: 校验目录结构 → 补充模板文件
 *   Phase 2: 解析 teamsoul.md → 扩展 openclaw.json + coordclaw.json → 创建 workspace
 *
 * 请求体:
 *   { teamId: "team-c" }
 *
 * 返回:
 *   { success, message, phase1: {...}, phase2: {...} }
 */
async function handleTeamCreate(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const teamId = (body?.teamId || body?.team_id || "") as string;

  if (!teamId) {
    warn(MODULE, `[HTTP] 请求缺少 teamId 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 teamId",
      phase1: null,
      phase2: null,
    });
    return;
  }

  info(MODULE, `[HTTP] 收到创建团队请求 teamId=${teamId}`, eventId);

  try {
    const result = await createTeam({ teamId });
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] 创建团队异常: ${err.message}`, eventId);
    sendJson(res, 500, {
      success: false,
      message: `服务器内部错误: ${err.message}`,
      phase1: null,
      phase2: null,
    });
  }
}

async function handleTeamRepair(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const teamIds = (Array.isArray(body?.teamIds) && body.teamIds.length > 0) ? body.teamIds : undefined;

  info(MODULE, `[HTTP] 收到 Agent 修复请求 teamIds=${teamIds?.join(",") || "ALL"}`, eventId);

  try {
    const result = await repairTeamAgents(teamIds);
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] Agent 修复异常: ${err.message}`, eventId);
    sendJson(res, 500, { success: false, teamsProcessed: 0, agentsMissing: 0, agentsRepaired: 0, agentsFailed: 0, details: [] });
  }
}

export function registerTeamCreateRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.TEAM_CREATE,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleTeamCreate(req, res);
      },
    },
    MODULE
  );
}

export function registerTeamRepairRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.TEAM_REPAIR,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleTeamRepair(req, res);
      },
    },
    MODULE
  );
}