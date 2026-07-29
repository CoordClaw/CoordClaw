/**
 * 功能18 (v19.33): 新建项目 - HTTP 路由注册
 *
 * POST /coordclaw-plugin/coordclawcenter/project-create
 */

import { getEventId, info, warn, error } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute, parseRequestBody } from "../shared/http-helpers";
import { createProject } from "./handler";

const MODULE = "project-create";

/**
 * 处理新建项目请求
 */
async function handleProjectCreate(req: any, res: any) {
  const eventId = getEventId();
  const { body, debugInfo } = await parseRequestBody(req);
  info(MODULE, debugInfo, eventId);

  const teamId = (body?.teamId || body?.team_id || "") as string;
  const projectName = (body?.projectName || body?.project_name || "") as string;
  const projectPath = (body?.projectPath || body?.project_path || "") as string;

  // 参数校验
  if (!teamId) {
    warn(MODULE, `[HTTP] 请求缺少 teamId 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 teamId",
    });
    return;
  }
  if (!projectName) {
    warn(MODULE, `[HTTP] 请求缺少 projectName 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 projectName",
    });
    return;
  }
  if (!projectPath) {
    warn(MODULE, `[HTTP] 请求缺少 projectPath 参数`, eventId);
    sendJson(res, 400, {
      success: false,
      message: "缺少必填参数 projectPath",
    });
    return;
  }

  info(MODULE, `[HTTP] 收到创建项目请求 teamId=${teamId} projectName=${projectName} projectPath=${projectPath}`, eventId);

  try {
    const result = await createProject({ teamId, projectName, projectPath });
    sendJson(res, result.success ? 200 : 400, result);
  } catch (err: any) {
    error(MODULE, `[HTTP] 创建项目异常: ${err.message}`, eventId);
    sendJson(res, 500, {
      success: false,
      message: `服务器内部错误: ${err.message}`,
    });
  }
}

/**
 * 注册新建项目路由
 */
export function registerProjectCreateRoute(api: any): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.PROJECT_CREATE,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        await handleProjectCreate(req, res);
      },
    },
    MODULE
  );

  info('plugin', `[INIT] STEP-R14 project-create 路由注册成功`, getEventId());
}
