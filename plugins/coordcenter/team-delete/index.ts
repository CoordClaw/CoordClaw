/**
 * 功能模块：删除团队（team-delete）
 *
 * 对外暴露：
 * - deleteTeam(): 删除团队核心逻辑
 * - registerTeamDeleteRoute(): 注册 HTTP 路由
 */

export { deleteTeam } from "./handler";
export { registerTeamDeleteRoute } from "./http-route";
export type {
  DeleteTeamRequest,
  TeamDeleteResult,
  AgentDeleteResult,
  ActivationTransferResult,
} from "./types";
