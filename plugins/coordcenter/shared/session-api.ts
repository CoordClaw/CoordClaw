/**
 * 框架会话 API 单例（L0 共享原语）
 *
 * 由 index.ts register 注入，供 token-stats 与 session-key reconcile 共用同一真相源。
 * 从 token-stats/pool.ts:139-140 提升为进程级单例，避免私有副本
 * （呼应 config-store 铁律"不私藏副本"）。
 */

let _sessionApi: any = null;

export function setSessionApi(a: any): void {
  _sessionApi = a;
}

export function getSessionApi(): any {
  return _sessionApi;
}
