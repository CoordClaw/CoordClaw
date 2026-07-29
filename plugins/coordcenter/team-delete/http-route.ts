import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { deleteTeam } from "./handler";

const MODULE = "team-delete";

/**
 * POST /coordclaw-plugin/coordclawcenter/team-delete
 *
 * 删除团队：校验团队注册 → 提取成员 → 从 openclaw.json 移除 agents → 从 coordclaw.json 移除团队
 *
 * 请求体:
 *   { teamId: "DataAnalysisTeam" }
 *
 * 返回:
 *   { success, message, teamId, teamName, agentsRemoved, totalAgents, details: [...] }
 */
async function handleTeamDelete(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const teamId = (body?.teamId || body?.team_id || "") as string;

  if (!teamId) {
    warn(MODULE, `[HTTP] 请求缺少 teamId 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 teamId",
    });
    return;
  }

  info(MODULE, `[HTTP] 收到删除团队请求 teamId=${teamId}`, eventId);

  try {
    const result = await deleteTeam({ teamId });
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] 删除团队异常: ${err.message}`, eventId);
    sendJson(res, 500, {
      success: false,
      message: `服务器内部错误: ${err.message}`,
    });
  }
}

export function registerTeamDeleteRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.TEAM_DELETE,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleTeamDelete(req, res);
      },
    },
    MODULE
  );
}
