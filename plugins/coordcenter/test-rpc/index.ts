/**
 * 功能模块：RPC 测试消息发送（test-rpc）
 *
 * 独立测试模块，不影响现有任何功能。
 *
 * 对外暴露：
 * - sendTestMessageToPm(): 通过 Gateway RPC sessions.send 发送测试消息
 * - registerTestRpcRoute(): 注册 HTTP POST /msgtopm 路由
 */

export { sendTestMessageToPm } from "./handler";
export type { TestRpcConfig, TestRpcResult } from "./handler";
export { registerTestRpcRoute } from "./http-route";