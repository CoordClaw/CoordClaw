/**
 * 功能模块：删除项目（project-delete）
 *
 * 对外暴露：
 * - deleteProject(): 删除项目核心逻辑
 * - registerProjectDeleteRoute(): 注册 HTTP 路由
 */

export { deleteProject } from "./handler";
export { registerProjectDeleteRoute } from "./http-route";
