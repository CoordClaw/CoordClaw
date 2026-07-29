/**
 * 功能模块：会话状态快照（session-snapshot）
 *
 * 对外暴露：
 * - registerSessionSnapshotRoute(): 注册 HTTP GET 路由，返回 session 完整运行状态
 */

export { registerSessionSnapshotRoute } from "./http-route";
export { writeSnapshotFile, deleteSnapshotFile, writePulseNotification } from "./persistence";