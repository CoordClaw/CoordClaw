/**
 * SSE 推送处理器 — 提取自 server.ts
 *
 * 层次:
 *   1. 纯工具函数（无 AppContext 依赖，可测试）
 *   2. 处理器函数（依赖 AppContext）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext, SSEClient } from '../lib/context.js';
import { resolveGatewayUrl } from '../lib/gateway.js';
let gatewayOnline = false; // 模块级：新连接感知 Gateway 状态

// ============ 1. 纯工具函数 ============

/** 广播 SSE 事件给所有连接的客户端 */
export function broadcastSSE(sseClients: Set<SSEClient>, event: string, data: any): void {
  if (sseClients.size === 0) return;
  const eventData = JSON.stringify(data);
  const message = `event: ${event}\ndata: ${eventData}\n\n`;
  let closedCount = 0;
  for (const client of sseClients) {
    if (!client.response.writableEnded) {
      try { client.response.write(message); } catch (error) { closedCount++; }
    } else { closedCount++; }
  }
  if (closedCount > 0) {
    console.log(`[SSE] 🧹 Cleaned up ${closedCount} closed connection(s)`);
  }
}

/** 关闭所有 SSE 连接 */
export function closeAllSSEConnections(sseClients: Set<SSEClient>): void {
  for (const client of sseClients) {
    if (!client.response.writableEnded) {
      try { client.response.end(); } catch (_) { /* ignore */ }
    }
  }
  sseClients.clear();
}

/** 关闭所有 SSE 连接（项目切换专用） */
export function closeAllSSEConnectionsForSwitch(sseClients: Set<SSEClient>): void {
  let closedCount = 0;
  for (const client of sseClients) {
    if (!client.response.writableEnded) {
      try { client.response.end(); closedCount++; } catch (_) { /* ignore */ }
    }
  }
  sseClients.clear();
  if (closedCount > 0) {
    console.log(`[SSE] 🔄 Project switch: closed ${closedCount} connection(s) (clients will auto-reconnect)`);
  }
}

// ============ 2. 处理器函数 ============

/** 确保 Gateway SSE 成员状态流已订阅 */
export function ensureMemberStatusStream(ctx: AppContext): void {
  if (ctx.memberStatusAbort) return;
  ctx.memberStatusAbort = new AbortController();
  console.log('[MemberStatus] ▶ Starting SSE subscription');


  (async () => {
    let wasOnline = false;
    while (true) {
      const gatewayUrl = resolveGatewayUrl(ctx.config);
      if (!gatewayUrl) {
        console.log('[MemberStatus] ⚠️ No Gateway address, retry in 2s');
        broadcastSSE(ctx.sseClients, 'gateway_offline', { reason: 'no address' });
        wasOnline = false; gatewayOnline = false;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const url = `${gatewayUrl}/coordclaw-plugin/coordclawcenter/session-snapshot?stream=true`;
      try {
        console.log('[MemberStatus] 🔗 Connecting to Gateway SSE...');
        const r = await fetch(url, { signal: ctx.memberStatusAbort!.signal });
        if (!r.ok || !r.body) {
          console.warn(`[MemberStatus] ⚠️ Abnormal response ${r.status}, retry in 2s`);
          broadcastSSE(ctx.sseClients, 'gateway_offline', { reason: `HTTP ${r.status}` });
          wasOnline = false; gatewayOnline = false;
          await new Promise(r2 => setTimeout(r2, 2000));
          continue;
        }
        console.log('[MemberStatus] ✅ Connected, waiting for data...');
        if (!wasOnline) broadcastSSE(ctx.sseClients, 'gateway_online', { gatewayUrl: resolveGatewayUrl(ctx.config) });
        wasOnline = true; gatewayOnline = true;

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) { console.log('[MemberStatus] 🔌 Stream ended'); break; }
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = '', data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5);
            }
            if (event === 'snapshot' && data) {
              try {
                const raw = JSON.parse(data);
                const snapshots = raw.filter((s: any) => s.agentId && !s.agentId.startsWith('agent:'));
                console.log(`[MemberStatus] 📡 Pushed ${snapshots.length}/${raw.length} members`);
                broadcastSSE(ctx.sseClients, 'member_status', { snapshots });
              } catch(e) {
                console.warn('[MemberStatus] ⚠️ JSON parse failed:', (e as Error).message);
              }
            }
          }
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          console.log('[MemberStatus] 🛑 Aborted');
          broadcastSSE(ctx.sseClients, 'gateway_offline', { reason: 'aborted' });
          break;
        }
        console.warn(`[MemberStatus] ⚠️ Connection error: ${e?.message || e}, retry in 2s...`);
        broadcastSSE(ctx.sseClients, 'gateway_offline', { reason: e?.message || 'connection lost' });
        wasOnline = false; gatewayOnline = false;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  })();
}

/** GET /api/sse-stream */
export function handleSSEStream(ctx: AppContext, _req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': ctx.config.corsOrigin,
  });

  res.write(': connected\n\n');
  res.write(`event: config\ndata: ${JSON.stringify({ currentUser: ctx.config.currentUser })}\n\n`);

  const client: SSEClient = { response: res, connectedAt: Date.now(), lastPing: Date.now() };
  ctx.sseClients.add(client);
  ctx.stats.sseConnections = ctx.sseClients.size;
  console.log(`[SSE] ✅ New connection (current ${ctx.sseClients.size} active)`);

  // 新连接感知 Gateway 当前状态
  if (gatewayOnline) {
    res.write(`event: gateway_online\ndata: ${JSON.stringify({ gatewayUrl: resolveGatewayUrl(ctx.config) })}\n\n`);
  }

  ensureMemberStatusStream(ctx);

  const heartbeatInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeatInterval);
      ctx.sseClients.delete(client);
      return;
    }
    res.write(': heartbeat\n\n');
    client.lastPing = Date.now();
  }, 30_000);

  let lastSyncTime = 0;
  let lastFingerprint = '';

  const syncFromDb = () => {
    if (res.writableEnded) return;
    const now = Date.now();
    if (now - lastSyncTime < 2000) return; // 2s 节流
    lastSyncTime = now;
    const result = ctx.db.getMessages({ limit: 50 });
    if (result.messages.length === 0) return;
    const fp = result.messages.map(m => `${m.msg_id}:${m.is_unread ? 1 : 0}:${m.view_count || 0}`).join(',');
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    res.write(`event: messages_sync\ndata: ${JSON.stringify(result.messages)}\n\n`);
  };

  // 订阅中心变更监测器的中性信号（外部写入经目录 watch / 低频轮询；自写经 notifyChanged 即时触发）
  const dbUnsub = ctx.db.onChange(() => syncFromDb());
  console.log(`[SSE] 📡 Subscribed to database change signal`);

  _req.on('close', () => {
    clearInterval(heartbeatInterval);
    if (dbUnsub) dbUnsub();
    ctx.sseClients.delete(client);
    ctx.stats.sseConnections = ctx.sseClients.size;
    console.log(`[SSE] 🔌 Connection closed (remaining ${ctx.sseClients.size})`);
    if (ctx.sseClients.size === 0 && ctx.memberStatusAbort) {
      ctx.memberStatusAbort.abort();
      ctx.memberStatusAbort = null;
      console.log('[MemberStatus] 🛑 Stopped');
    }
  });
}
