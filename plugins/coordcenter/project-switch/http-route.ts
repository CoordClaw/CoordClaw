import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { switchProject } from "./handler";
import { fullReset } from "../shared/cache-coordinator";
import { pushSnapshotEvent } from "../session-snapshot/snapshot-events";

const MODULE = "project-switch";

/**
 * POST /coordclaw-plugin/coordclawcenter/project-switch
 *
 * 切换激活项目：将指定项目设为 active，其余全部置为 inactive，并更新 team.json 中的网关配置
 *
 * 请求体:
 *   { teamId: "team-c", projectId: "CoordClawTeam_0001" }
 *
 * 返回:
 *   { success, message, teamId, projectId, projectName, deactivatedCount, gatewayUrl, ... }
 */
async function handleProjectSwitch(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const teamId = (body?.teamId || body?.team_id || "") as string;
  const projectId = (body?.projectId || body?.project_id || "") as string;

  if (!teamId || !projectId) {
    warn(MODULE, `[HTTP] 请求缺少必填参数 teamId 或 projectId`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数: teamId 和 projectId",
    });
    return;
  }

  info(MODULE, `[HTTP] 收到切换项目请求 teamId=${teamId} projectId=${projectId}`, eventId);

  try {
    const result = await switchProject({ teamId, projectId });
    if (result.success) {
      // 全量重建缓存（六层协调），清空旧项目残留数据
      try {
        await fullReset();
        info(MODULE, `[HTTP] 全量缓存重建完成`, eventId);
      } catch (resetErr: any) {
        warn(MODULE, `[HTTP] 缓存重建失败(非致命): ${resetErr.message}`, eventId);
      }
      // 推送全量 SSE 快照，前端即时更新项目成员状态
      try {
        pushSnapshotEvent();
        info(MODULE, `[HTTP] SSE 全量快照已推送`, eventId);
      } catch (_) { /* SSE 推送非致命 */ }
    }
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] 切换项目异常: ${err.message}`, eventId);
    sendJson(res, 500, {
      success: false,
      message: `服务器内部错误: ${err.message}`,
    });
  }
}

export function registerProjectSwitchRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.PROJECT_SWITCH,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleProjectSwitch(req, res);
      },
    },
    MODULE
  );
}
