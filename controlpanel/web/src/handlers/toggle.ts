/**
 * Toggle 开关处理器 — 提取自 server.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../lib/context.js';
import { readTeamJson, writeTeamJson } from '../lib/team-json.js';
import { resolveGatewayUrl } from '../lib/gateway.js';
import { AppError } from '../lib/errors.js';

/** POST /api/toggle-human — body: { human_id: string } */
export function handleToggleHuman(ctx: AppContext, _req: IncomingMessage, res: ServerResponse, body?: any): void {
  try {
    const data = readTeamJson(ctx.config.projectRoot);

    // ★ 兼容旧格式：单对象转数组
    if (!Array.isArray(data.humanmember)) {
      if (!data.humanmember || !data.humanmember.name) {
        ctx.sendJSON(res, 400, {
          success: false, error: 'humanmember 未配置'
        });
        return;
      }
      data.humanmember = [data.humanmember];
    }

    // 如果传了 human_id，切换指定成员；否则切换第一个
    const targetId = body?.human_id || (data.humanmember[0]?.human_id);
    const target = data.humanmember.find((h: any) => h.human_id === targetId);
    if (!target) {
      throw AppError.notFound(`未找到 human_id=${targetId}`);
    }
    target.enabled = !target.enabled;
    writeTeamJson(ctx.config.projectRoot, data);

    console.log(`[ToggleHuman] ✅ ${target.name}(${targetId}) enabled=${target.enabled}`);
    ctx.sendJSON(res, 200, { success: true, human_id: targetId, enabled: target.enabled, name: target.name });
  } catch (error) {
    console.error('[ToggleHuman] ❌ Failed:', error);
    if (error instanceof AppError) throw error;
    throw AppError.internal('切换人类用户状态失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/toggle-auto-coordination */
export function handleToggleAutoCoordination(ctx: AppContext, _req: IncomingMessage, res: ServerResponse): void {
  try {
    const data = readTeamJson(ctx.config.projectRoot);
    data.auto_coordination = !data.auto_coordination;
    writeTeamJson(ctx.config.projectRoot, data);
    console.log(`[ToggleAutoCoordination] ✅ auto_coordination = ${data.auto_coordination}`);

    const gatewayUrl = resolveGatewayUrl(ctx.config);
    if (gatewayUrl) {
      fetch(`${gatewayUrl}/coordclaw-plugin/coordclawcenter/cache-refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }).then(r => console.log(`[ToggleAutoCoordination] cache-refresh (${r.status})`))
        .catch(e => console.warn('[ToggleAutoCoordination] cache-refresh failed:', e.message));
    }
    ctx.sendJSON(res, 200, { success: true, enabled: data.auto_coordination });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.internal('切换自动协同失败', String(e));
  }
}

/** POST /api/toggle-msg-robot */
export function handleToggleMsgRobot(ctx: AppContext, _req: IncomingMessage, res: ServerResponse): void {
  try {
    const data = readTeamJson(ctx.config.projectRoot);

    if (typeof data.msg_robot === 'boolean') {
      data.msg_robot = !data.msg_robot;
    } else if (typeof data.msg_robot === 'object' && data.msg_robot !== null) {
      data.msg_robot = !data.msg_robot.enabled;
    } else {
      data.msg_robot = true;
    }

    writeTeamJson(ctx.config.projectRoot, data);
    console.log(`[ToggleMsgRobot] ✅ msg_robot = ${data.msg_robot}`);

    const gatewayUrl = resolveGatewayUrl(ctx.config);
    if (gatewayUrl) {
      const cacheRefreshUrl = `${gatewayUrl}/coordclaw-plugin/coordclawcenter/cache-refresh`;
      console.log(`[ToggleMsgRobot] 🔄 Calling Gateway cache-refresh: ${cacheRefreshUrl}`);
      fetch(cacheRefreshUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then((gres) => {
          console.log(`[ToggleMsgRobot] ✅ Gateway cache-refresh responded (${gres.status})`);
        })
        .catch(err => console.warn('[ToggleMsgRobot] ⚠️ Gateway cache-refresh failed:', err.message));
    }

    ctx.sendJSON(res, 200, { success: true, msg_robot: data.msg_robot });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.internal('切换消息路由失败', String(e));
  }
}
