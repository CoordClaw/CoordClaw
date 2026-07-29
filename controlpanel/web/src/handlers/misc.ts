/**
 * 杂项处理器 — 提取自 server.ts
 * 包含: 健康检查 / 项目列表 / 成员状态 / Gateway 重启
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../lib/context.js';
import { sendJSON } from '../lib/response.js';
import { resolveGatewayUrl } from '../lib/gateway.js';
import { getAllProjects } from '../config-resolver.js';
import { AppError } from '../lib/errors.js';

/** GET /api/health */
export function handleHealthCheck(ctx: AppContext, res: ServerResponse): void {
  const uptime = ctx.stats.startTime
    ? Math.floor((Date.now() - ctx.stats.startTime.getTime()) / 1000)
    : 0;

  ctx.sendJSON(res, 200, {
    status: 'ok',
    service: 'CoordClaw Control Panel',
    version: ctx.config.version || '0.0.0',
    uptime_seconds: uptime,
    database: { connected: ctx.db.isReady(), path: ctx.db.getDbPath() },
    sse_connections: ctx.sseClients.size,
    stats: { total_requests: ctx.stats.totalRequests, api_requests: ctx.stats.apiRequests },
    timestamp: new Date().toISOString(),
  });
}

/** GET /api/projects */
export function handleGetProjects(res: ServerResponse): void {
  try {
    const result = getAllProjects();
    sendJSON(res, 200, result);
  } catch (error) {
    throw AppError.internal('获取项目列表失败', error instanceof Error ? error.message : String(error));
  }
}

/** GET /api/member-status */
export async function handleMemberStatus(ctx: AppContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gatewayUrl = resolveGatewayUrl(ctx.config);
  if (!gatewayUrl) { ctx.sendJSON(res, 200, { ok: false, count: 0, snapshots: [] }); return; }
  try {
    const r = await fetch(`${gatewayUrl}/coordclaw-plugin/coordclawcenter/session-snapshot`);
    const text = await r.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { ok: false, count: 0, snapshots: [] }; }
    ctx.sendJSON(res, 200, {
      ok: true, count: data.count || 0,
      snapshots: (data.snapshots || []).map((s: any) => ({
        sessionKey: s.sessionKey, status: s.status, state: s.state, agentId: s.agentId, fixable: s.fixable,
      })),
    });
  } catch { ctx.sendJSON(res, 200, { ok: false, count: 0, snapshots: [] }); }
}

/** POST /api/restart-gateway */
export async function handleRestartGateway(req: IncomingMessage, res: ServerResponse, restartGateway: (mode: 'soft' | 'hard') => Promise<{ success: boolean; message: string }>): Promise<void> {
  let mode: 'soft' | 'hard' = 'soft';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    if (raw) {
      const body = JSON.parse(raw);
      if (body.mode === 'hard') mode = 'hard';
    }
  } catch (e) {
    throw AppError.badRequest('无效的请求体', String(e));
  }

  const result = await restartGateway(mode);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ...result, mode }));
}
