/**
 * 功能模块：RPC 测试消息发送 - HTTP 路由注册
 *
 * HTTP 端点：
 * POST /coordclaw-plugin/coordclawcenter/msgtopm
 * auth: plugin（无需 Token，PowerShell/curl 可直接调用）
 *
 * 触发后通过 Gateway RPC sessions.send 发送测试消息"请复述团队通用规则"给 PM
 */

import { getEventId, info } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute } from "../shared/http-helpers";
import { HttpRouteConfig } from "../shared/types-http";
import { sendTestMessageToPm } from "./handler";

export { HttpRouteConfig };

const MODULE = "test-rpc";

async function handleMsgToPm(config: HttpRouteConfig, res: any) {
  info(MODULE, `[HTTP] 收到 msgtopm 请求，开始发送测试消息`, getEventId());
  const result = await sendTestMessageToPm(config);
  sendJson(res, result.success ? 200 : 500, result);
}

export function registerTestRpcRoute(api: any, config: HttpRouteConfig): void {
  registerPluginRoute(api, {
    method: "POST",
    path: ROUTES.MSG_TO_PM,
    auth: "plugin",
    handler: async (_req: any, res: any) => {
      await handleMsgToPm(config, res);
    },
  }, MODULE);
}