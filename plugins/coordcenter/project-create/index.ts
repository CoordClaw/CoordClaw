/**
 * 功能18 (v19.33): 新建项目 - 模块入口
 *
 * 导出:
 *   - createProject(req): 核心逻辑
 *   - registerProjectCreateRoute(api): HTTP 路由注册
 */

export { createProject } from "./handler";
export { registerProjectCreateRoute } from "./http-route";
