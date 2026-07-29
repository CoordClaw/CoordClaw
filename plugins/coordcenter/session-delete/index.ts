/**
 * 功能模块：删除会话（session-delete）
 *
 * 对外暴露：
 * - deleteSessionByKey(): 删除指定会话核心逻辑
 * - registerSessionDeleteRoute(): 注册 HTTP 路由
 */

export { deleteSessionByKey } from "./handler";
export { registerSessionDeleteRoute } from "./http-route";
