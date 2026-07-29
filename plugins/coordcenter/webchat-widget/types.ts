/**
 * WebChat Widget SDK - 类型定义
 *
 * 功能24: 通过 Gateway 端口(28789)提供可嵌入的前端聊天 Widget
 *
 * 复用 OpenClaw /__openclaw__/ws WebSocket 协议实现双向聊天，
 * 不依赖独立端口 3210，与现有 webchat 功能完全独立。
 */

// ==================== 配置响应 ====================

/** Widget 配置接口（GET /webchat/config 返回） */
export interface WidgetConfigResponse {
  success: boolean;
  /** Gateway WebSocket 地址 */
  wsUrl: string;
  /** Gateway HTTP 基础地址 */
  httpUrl: string;
  /** Gateway 认证 Token（用于 WebSocket 握手） */
  token?: string;
  /** 可用的 session 列表（从 team.json 加载） */
  sessions: WidgetSessionInfo[];
  error?: string;
}

/** Session 信息 */
export interface WidgetSessionInfo {
  sessionKey: string;
  agentId?: string;
  displayName?: string;
  role?: string;
}

// ==================== Widget 实例选项 ====================

/** WebChatWidget 构造选项 */
export interface WidgetOptions {
  /** 挂载容器（CSS 选择器或 HTMLElement） */
  container: string | HTMLElement;
  /** 目标 sessionKey */
  sessionKey?: string;
  /** Gateway WebSocket 地址（不填则从 /config 自动获取） */
  wsUrl?: string;
  /** Gateway Token（不填则从 /config 自动获取） */
  token?: string;
  /** 主题：light / dark */
  theme?: "light" | "dark";
  /** 标题栏文字 */
  title?: string;
  /** 占位提示文字 */
  placeholder?: string;
  /**
   * 自定义 CSS 变量覆盖（注入到 widget 的 :root 作用域）
   *
   * 可用变量：
   *   --wcw-bg, --wcw-surface, --wcw-accent, --wcw-text,
   *   --wcw-text-dim, --wcw-border, --wcw-user-bg, --wcw-ai-bg,
   *   --wcw-input-bg, --wcw-code-bg
   *
   * @example
   *   new WebChatWidget({
   *     container: '#chat',
   *     css: { '--wcw-accent': '#6366f1', '--wcw-bg': '#0f172a' }
   *   });
   */
  css?: Record<string, string>;
  /** 完整自定义 CSS 字符串（注入到 widget 内部 <style> 标签） */
  cssText?: string;
  /** 收到消息回调 */
  onMessage?: (msg: WidgetMessage) => void;
  /** 连接状态变化回调 */
  onConnectionChange?: (connected: boolean) => void;
  /** 错误回调 */
  onError?: (err: Error) => void;
}

// ==================== 消息类型 ====================

/** Widget 内部消息 */
export interface WidgetMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  state?: "delta" | "done" | "error";
}

// ==================== API 结果类型 ====================

/** 通用结果 */
export interface WidgetResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
