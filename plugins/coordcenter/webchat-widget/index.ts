/**
 * 功能模块：WebChat Widget SDK（webchat-widget）
 *
 * 对外暴露：
 * - getWidgetConfig(): 获取 Widget 配置（WS地址 + session列表）
 * - getWidgetSdkJs(): 获取前端 SDK JavaScript
 * - getWidgetCss(): 获取 Widget 样式
 * - registerWebchatWidgetRoutes(): 注册 HTTP 路由
 */

export { getWidgetConfig } from "./handler";
export { getWidgetSdkJs } from "./widget-sdk";
export { getWidgetCss } from "./widget-css";
export { registerWebchatWidgetRoutes } from "./http-route";
export type {
  WidgetConfigResponse,
  WidgetSessionInfo,
  WidgetOptions,
  WidgetMessage,
} from "./types";
