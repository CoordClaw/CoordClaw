/**
 * 功能模块：切换项目（project-switch）
 *
 * 对外暴露：
 * - switchProject(): 切换激活项目核心逻辑
 * - registerProjectSwitchRoute(): 注册 HTTP 路由
 */

export { switchProject } from "./handler";
export { registerProjectSwitchRoute } from "./http-route";
export type {
  SwitchProjectRequest,
  SwitchProjectResult,
} from "./types";
