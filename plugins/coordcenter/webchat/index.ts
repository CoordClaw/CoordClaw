import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { webchatPlugin } from "./channel";
import { setWebchatRuntime } from "./gateway";

export function registerWebchat(api: OpenClawPluginApi) {
  setWebchatRuntime(api.runtime);
  api.registerChannel({ plugin: webchatPlugin });
  api.logger?.info("[webchat] Channel registered — WebChat http://localhost:3210");
  // 网关启动由 SDK 通道管理器统一调度（webchatPlugin.gateway.startAccount）
}