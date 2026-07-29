/**
 * 共享响应工具 — 从 server.ts 提取
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { joinStatic } from './paths.js';
import { AppError } from './errors.js';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

/** 解析 JSON 请求体（统一入口，10MB 上限） */
export function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('请求体超过 10MB')); return; }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** 生成请求 ID */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/** 设置通用响应头 */
export function setCommonHeaders(res: ServerResponse, corsOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Powered-By', 'CoordClaw-ControlPanel/1.0');
  res.setHeader('X-Request-ID', generateRequestId());
}

/** OPTIONS 预检 */
export function handlePreflight(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** 统一 JSON 响应 */
export function sendJSON(res: ServerResponse, statusCode: number, data: any): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

/** 静态文件服务 */
export function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  const fullPath = joinStatic(filePath);
  if (!existsSync(fullPath)) {
    if (!filePath.startsWith('auto/')) console.warn(`[Static] ⚠️  File not found: ${filePath}`);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File Not Found');
    return;
  }
  try {
    const content = readFileSync(fullPath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (error) {
    console.error(`[Static] ❌ Failed to read file [${filePath}]:`, error);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
}

/** 便捷发送 AppError（用于需要手动控制的非抛出场景） */
export function sendError(res: ServerResponse, error: AppError, requestId?: string): void {
  res.setHeader('X-Error-Code', error.code);
  sendJSON(res, error.statusCode, {
    success: false,
    error: error.message,
    code: error.code,
    details: error.details,
    requestId,
  });
}

/** 根据扩展名获取 Content-Type */
export function getContentType(pathname: string): string {
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}
