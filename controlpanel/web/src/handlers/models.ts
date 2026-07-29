/**
 * 大模型配置处理器 — 通过 Gateway API 管理全局模型
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { sendJSON, parseBody } from '../lib/response.js';
import { COORDCLAW_CONFIG_PATH } from '../config-resolver.js';

// ─── Gateway 助手 ─────────────────────────────────────

interface GatewayConfig { url: string; token: string; }

function getGw(): GatewayConfig {
  const raw = JSON.parse(readFileSync(COORDCLAW_CONFIG_PATH, 'utf-8'));
  return { url: raw.gatewayUrl, token: raw.gatewayToken };
}

async function gwGet(path: string): Promise<any> {
  const { url, token } = getGw();
  const resp = await fetch(`${url}${path}`, { headers: { 'x-gateway-token': token } });
  return resp.json();
}

async function gwPost(path: string, body: any): Promise<any> {
  const { url, token } = getGw();
  const resp = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'x-gateway-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ─── API Handlers ─────────────────────────────────────

/** GET /api/models */
export async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await gwGet('/coordclaw-plugin/coordclawcenter/model-list');
    sendJSON(res, 200, { models: data.models || [] });
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}

/** POST /api/model-config — {model, sessionKey?, agentId?} */
export async function handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { model, sessionKey, agentId } = await parseBody(req);
    // model 必传；sessionKey / agentId 二选一决定作用域，都不传则作用域=全局
    if (!model) { sendJSON(res, 400, { error: '缺少 model' }); return; }
    const body: any = { model: model || null };
    if (sessionKey) body.sessionKey = sessionKey;
    if (agentId) body.agentId = agentId;
    const result = await gwPost('/coordclaw-plugin/coordclawcenter/model-set', body);
    if (result.success) {
      sendJSON(res, 200, result);
    } else {
      sendJSON(res, 500, { error: result.message || '设置失败' });
    }
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}
