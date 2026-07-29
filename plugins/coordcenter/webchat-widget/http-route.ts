/**
 * WebChat Widget - HTTP 路由注册
 *
 * 功能24: 在 Gateway 端口(28789)上提供 Widget 资源端点
 *
 * 端点：
 *   GET /coordclaw-plugin/coordclawcenter/webchat/config    → JSON 配置
 *   GET /coordclaw-plugin/coordclawcenter/webchat/widget.js  → SDK 脚本
 *   GET /coordclaw-plugin/coordclawcenter/webchat/widget.css → 样式表
 */

import { info } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { registerPluginRoute, sendJson } from "../shared/http-helpers";
import { getWidgetConfig } from "./handler";
import { getWidgetSdkJs } from "./widget-sdk";
import { getWidgetCss } from "./widget-css";

const MODULE = "webchat-widget";

/**
 * 设置响应头并发送文本内容（用于 JS/CSS/HTML 等静态资源）
 */
function sendText(res: any, statusCode: number, contentType: string, body: string): void {
  try {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    res.end(body);
  } catch (e) {
    /* 连接可能已关闭 */
  }
}

/**
 * 处理 GET /webchat/config
 */
function handleConfig(req: any, res: any) {
  const config = getWidgetConfig();
  sendJson(res, 200, config);
}

/**
 * 处理 GET /webchat/widget.js
 */
function handleWidgetJs(req: any, res: any) {
  const js = getWidgetSdkJs();
  sendText(res, 200, "application/javascript; charset=utf-8", js);
}

/**
 * 处理 GET /webchat/widget.css
 */
function handleWidgetCss(req: any, res: any) {
  const css = getWidgetCss();
  sendText(res, 200, "text/css; charset=utf-8", css);
}

export function registerWebchatWidgetRoutes(api: any): void {
  // 1. 配置接口
  registerPluginRoute(
    api,
    {
      method: "GET",
      path: ROUTES.WIDGET_CONFIG,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        handleConfig(req, res);
      },
    },
    MODULE
  );

  // 2. Widget SDK JavaScript
  registerPluginRoute(
    api,
    {
      method: "GET",
      path: ROUTES.WIDGET_JS,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        handleWidgetJs(req, res);
      },
    },
    MODULE
  );

  // 3. Widget CSS 样式
  registerPluginRoute(
    api,
    {
      method: "GET",
      path: ROUTES.WIDGET_CSS,
      auth: "plugin",
      handler: async (req: any, res: any) => {
        handleWidgetCss(req, res);
      },
    },
    MODULE
  );

  info(MODULE, `[INIT] WebChat Widget routes registered: config, widget.js, widget.css`);
}
