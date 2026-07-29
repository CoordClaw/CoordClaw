/**
 * 功能: 删除会话 - 类型定义
 *
 * 流程：前端传入 sessionKey → 调用 Gateway RPC sessions.delete → 全量刷新缓存
 */

export interface DeleteSessionRequest {
  /** 会话标识（必填） */
  sessionKey: string;
}

export interface SessionDeleteResult {
  success: boolean;
  message: string;
  sessionKey: string;
  deleted: boolean;
  error?: string;
}
