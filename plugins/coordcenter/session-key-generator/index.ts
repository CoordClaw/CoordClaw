/**
 * 功能模块：批量创建SessionKey
 *
 * 对外暴露：
 * - batchCreateSessionKeys(): 批量创建sessionkey并更新team.json
 * - showTeamSessionKeys(): 显示team.json中sessionkey的状态
 * - registerSessionKeyGeneratorRoutes(): 注册 HTTP 路由
 */

export {
  batchCreateSessionKeys,
  showTeamSessionKeys,
} from "./handler";

export type {
  BatchCreateSessionKeysConfig,
  BatchCreateSessionKeysRequest,
  BatchCreateSessionKeysResponse,
  CreateSessionKeyResult,
} from "./handler";

export type { TeamMember } from "../shared/team-loader";

export { registerSessionKeyGeneratorRoutes } from "./http-route";

export type { HttpRouteConfig } from "./http-route";
