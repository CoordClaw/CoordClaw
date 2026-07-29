/**
 * 资源名校验器（公用）— 团队 / 项目等所有命名共用，单一真相源。
 *
 * 采用「黑名单」策略：仅拒绝会导致路径解析 / 文件系统出问题的字符
 * （\ / : * ? " < > | 以及 ASCII 控制字符），其余一律放行
 * （含中文、空格、emoji、&、()、-、_ 等合法内容）。
 * 这正贴合「检测可能导致 bug 的特殊符号」的本意，且不会误杀合法团队名。
 */

export type ValidationCode = 'OK' | 'EMPTY' | 'INVALID_CHAR' | 'TOO_LONG';

export interface ValidationResult {
  ok: boolean;
  code: ValidationCode;
  reason?: string;
}

/** 文件系统禁止的字符（Windows / 类 Unix 通用危险字符） */
const INVALID_CHARS = /[\\/:*?"<>|]/;
/** ASCII 控制字符（0x00-0x1F 与 0x7F DEL） */
const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f]');
const DEFAULT_MAX_LEN = 50;

/**
 * 校验资源名。
 * @param raw   原始输入（允许任意类型，非字符串按空处理）
 * @param maxLen 最大长度，默认 50
 */
export function validateResourceName(raw: unknown, maxLen: number = DEFAULT_MAX_LEN): ValidationResult {
  const name = typeof raw === 'string' ? raw.trim() : '';

  if (name.length === 0) {
    return { ok: false, code: 'EMPTY', reason: '名称不能为空' };
  }
  if (name.length > maxLen) {
    return { ok: false, code: 'TOO_LONG', reason: `名称长度不能超过 ${maxLen} 个字符` };
  }
  if (INVALID_CHARS.test(name)) {
    return { ok: false, code: 'INVALID_CHAR', reason: '名称包含非法字符：\\ / : * ? " < > |' };
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, code: 'INVALID_CHAR', reason: '名称包含控制字符' };
  }
  return { ok: true, code: 'OK' };
}
