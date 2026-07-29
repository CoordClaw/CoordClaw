/**
 * Gateway 共享工具 — 统一所有模块对 Gateway 的调用方式
 */

import { readFileSync, existsSync } from 'node:fs';
import { COORDCLAW_CONFIG_PATH } from '../config-resolver.js';

type CoordClawRawConfig = { gatewayUrl?: string; gatewayPid?: number; webchatUrl?: string };

let _configCache: CoordClawRawConfig | null = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5秒缓存
const GATEWAY_TIMEOUT_MS = 120000; // Gateway 调用整体超时(2分钟)：项目删除/创建等操作可能较久，过短会误报"已失败但实际成功"

function readCoordClawConfig(): CoordClawRawConfig {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL) return _configCache;
  try {
    _configCache = existsSync(COORDCLAW_CONFIG_PATH)
      ? JSON.parse(readFileSync(COORDCLAW_CONFIG_PATH, 'utf-8'))
      : {};
  } catch {
    _configCache = {};
  }
  _configCacheTime = now;
  return _configCache!;
}

/** 解析 Gateway URL */
export function resolveGatewayUrl(config: any): string | null {
  try {
    const cfg = readCoordClawConfig();
    if (cfg.gatewayUrl) return cfg.gatewayUrl;
    return null;
  } catch (error) {
    console.error('[Gateway] Failed to resolve gatewayUrl:', error);
    return null;
  }
}

/** 统一 Gateway API 调用（所有 handler 应通过此函数调用 Gateway） */
export async function callGateway(
  config: any,
  endpoint: string,
  body?: Record<string, any>,
  method: string = 'POST'
): Promise<{ ok: boolean; status: number; data: any }> {
  const gatewayUrl = resolveGatewayUrl(config);
  if (!gatewayUrl) {
    return { ok: false, status: 0, data: { error: 'Gateway URL 不可用' } };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GATEWAY_TIMEOUT_MS);
    const res = await fetch(`${gatewayUrl}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { error: err.message } };
  }
}

/** 通知 Gateway 刷新缓存（fire-and-forget） */
export function notifyCacheRefresh(config: any): void {
  const gatewayUrl = resolveGatewayUrl(config);
  if (!gatewayUrl) return;
  fetch(`${gatewayUrl}/coordclaw-plugin/coordclawcenter/cache-refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }
  }).then((r) => console.log(`[Gateway] ✅ cache-refresh (${r.status})`))
    .catch((err) => console.warn(`[Gateway] ⚠️ cache-refresh failed:`, err.message));
}

/** 读取 Gateway PID */
export function readGatewayPid(): number {
  return readCoordClawConfig().gatewayPid || 0;
}

/** 解析 WebChat URL */
export function resolveWebchatUrl(): string | null {
  return readCoordClawConfig().webchatUrl || null;
}
