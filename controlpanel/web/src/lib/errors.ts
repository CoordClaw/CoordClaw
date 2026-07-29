/**
 * 统一错误类型定义
 * 所有 handler 通过 throw AppError 替代手动 sendJSON 构造错误响应
 * 由 error-handler.ts 统一捕获并转换为 HTTP 响应
 */

/** 标准化错误码 — 前端可据此做差异化处理 */
export enum ErrorCode {
  BAD_REQUEST      = 'BAD_REQUEST',
  NOT_FOUND        = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  GATEWAY_ERROR    = 'GATEWAY_ERROR',
  DB_ERROR         = 'DB_ERROR',
  FILE_ERROR       = 'FILE_ERROR',
  INTERNAL_ERROR   = 'INTERNAL_ERROR',
}

/** 统一应用错误 — handler 中 throw，由拦截层统一捕获并转换 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: string;
  public readonly params?: any[];

  constructor(statusCode: number, message: string, code: ErrorCode = ErrorCode.INTERNAL_ERROR, details?: string, params?: any[]) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.params = params;
  }

  // ─── 工厂方法 ──────────────────────────────────

  /** 400 — 请求参数/格式错误 */
  static badRequest(message: string, details?: string, params?: any[]): AppError {
    return new AppError(400, message, ErrorCode.BAD_REQUEST, details, params);
  }

  /** 400 — 参数校验失败 */
  static validation(message: string, details?: string, params?: any[]): AppError {
    return new AppError(400, message, ErrorCode.VALIDATION_ERROR, details, params);
  }

  /** 404 — 资源不存在 */
  static notFound(message: string, params?: any[]): AppError {
    return new AppError(404, message, ErrorCode.NOT_FOUND, undefined, params);
  }

  /** 502 — Gateway 调用失败 */
  static gateway(message: string, details?: string, params?: any[]): AppError {
    return new AppError(502, message, ErrorCode.GATEWAY_ERROR, details, params);
  }

  /** 500 — 数据库错误 */
  static database(message: string, details?: string, params?: any[]): AppError {
    return new AppError(500, message, ErrorCode.DB_ERROR, details, params);
  }

  /** 500 — 文件操作错误 */
  static fileError(message: string, details?: string, params?: any[]): AppError {
    return new AppError(500, message, ErrorCode.FILE_ERROR, details, params);
  }

  /** 500 — 未知内部错误 */
  static internal(message: string, details?: string, params?: any[]): AppError {
    return new AppError(500, message, ErrorCode.INTERNAL_ERROR, details, params);
  }
}
