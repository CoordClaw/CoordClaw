/**
 * 统一错误拦截层
 *
 * 职责：
 * 1. handleError — 将异常转换为统一 JSON 错误响应
 * 2. 区分 AppError（已知业务异常）和未知异常（内部错误）
 * 3. 开发环境暴露 details，生产环境脱敏
 */

import type { ServerResponse } from 'node:http';
import { AppError, ErrorCode } from './errors.js';
import { sendJSON } from './response.js';

/**
 * 将任意异常转为统一 JSON 错误响应
 *
 * @param res       — HTTP 响应对象
 * @param requestId — 请求追踪 ID（用于日志关联）
 * @param error     — 捕获的异常
 */
export function handleError(res: ServerResponse, requestId: string, error: unknown): void {
  // 响应已发送 → 无法修改状态码
  if (res.headersSent) return;

  if (error instanceof AppError) {
    res.setHeader('X-Error-Code', error.code);
    sendJSON(res, error.statusCode, {
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
      params: error.params,
      requestId,
    });
    return;
  }

  // 未知异常：记录完整信息，返回脱敏响应
  console.error(`[ErrorHandler] Uncaught exception [${requestId}]:`, error);

  const isDev = process.env.NODE_ENV === 'development';
  res.setHeader('X-Error-Code', ErrorCode.INTERNAL_ERROR);
  sendJSON(res, 500, {
    success: false,
    error: '服务器内部错误',
    code: ErrorCode.INTERNAL_ERROR,
    details: isDev
      ? (error instanceof Error ? error.message : String(error))
      : undefined,
    requestId,
  });
}
