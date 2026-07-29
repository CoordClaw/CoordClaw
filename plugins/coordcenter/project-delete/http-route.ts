/**
 * 功能19: 删除项目 - HTTP 路由注册
 *
 * POST /coordclaw-plugin/coordclawcenter/project-delete
 */

import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { deleteProject } from "./handler";

const MODULE = "project-delete";

/**
 * 处理删除项目请求
 */
async function handleProjectDelete(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const teamId = (body?.teamId || body?.team_id || "") as string;
  const projectId = (body?.projectId || body?.project_id || "") as string;

  // 参数校验
  if (!teamId) {
    warn(MODULE, `[HTTP] 请求缺少 teamId 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 teamId",
    });
    return;
  }
  if (!projectId) {
    warn(MODULE, `[HTTP] 请求缺少 projectId 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 projectId",
    });
    return;
  }

  info(MODULE, `[HTTP] 收到删除项目请求 teamId=${teamId} projectId=${projectId}`, eventId);

  try {
    const result = await deleteProject({ teamId, projectId });
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] 删除项目异常: ${err.message}`, eventId);
    sendJson(res, 500, {
      success: false,
      message: `服务器内部错误: ${err.message}`,
    });
  }
}

/**
 * 注册删除项目路由
 */
export function registerProjectDeleteRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.PROJECT_DELETE,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleProjectDelete(req, res);
      },
    },
    MODULE
  );

  info("plugin", `[INIT] STEP-R15 project-delete 路由注册成功`, getEventId());
}
