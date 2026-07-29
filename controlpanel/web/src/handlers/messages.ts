/**
 * 消息 CRUD 处理器 — 提取自 server.ts
 * 通过 AppContext 访问 db / sendJSON / broadcastSSE
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../lib/context.js';
import { parseBody } from '../lib/response.js';
import { AppError } from '../lib/errors.js';
import { readTeamJson, writeTeamJson } from '../lib/team-json.js';
import { resolveGatewayUrl } from '../lib/gateway.js';

/** GET /api/messages */
export async function handleGetMessages(ctx: AppContext, url: URL, res: ServerResponse): Promise<void> {
  const params = Object.fromEntries(url.searchParams);
  const member = params.member || undefined;
  const member_id = member ? ctx.resolveMemberId(member) : undefined;
  const sender = params.sender || undefined;
  const sender_id = sender ? ctx.resolveSenderId(sender) : undefined;

  const result = ctx.db.getMessages({
    limit: parseInt(params.limit) || undefined,
    since_id: params.since_id ? parseInt(params.since_id) : undefined,
    before_id: params.before_id ? parseInt(params.before_id) : undefined,
    member: member,
    member_id: member_id,
    sender: sender_id,
    from_date: params.from_date || undefined,
    offset: params.offset ? parseInt(params.offset) : undefined,
    unread_only: params.unread_only === 'true',
    read_only: params.read_only === 'true',
    keyword: params.keyword || undefined,
  });

  ctx.sendJSON(res, 200, result);
}

/** GET /api/members */
export function handleGetMembers(ctx: AppContext, res: ServerResponse): void {
  const members = ctx.db.getMembers(ctx.config.currentUser);
  ctx.sendJSON(res, 200, { members });
}

/** GET /api/unread-count */
export function handleGetUnreadCount(ctx: AppContext, res: ServerResponse): void {
  const count = ctx.db.getUnreadCount();
  ctx.sendJSON(res, 200, { count });
}

/** GET /api/messages/count */
export function handleGetMessageCount(ctx: AppContext, res: ServerResponse): void {
  const total = ctx.db.getMessageCount();
  ctx.sendJSON(res, 200, { total });
}

/** GET /api/member-unread */
export function handleGetMemberUnread(ctx: AppContext, url: URL, res: ServerResponse): void {
  const member = url.searchParams.get('member') || '';
  const memberId = ctx.resolveMemberId(member);
  const messages = ctx.db.getMemberUnread(member, memberId);
  ctx.sendJSON(res, 200, { messages, member });
}

/** POST /api/mark-read */
export async function handleMarkRead(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const msgIds: number[] = data.msg_ids || [];
    const reader: string = data.reader || ctx.config.currentUser;

    if (!Array.isArray(msgIds) || msgIds.length === 0) {
      throw AppError.validation('msg_ids 必须是非空数组');
    }

    const result = ctx.db.markRead(msgIds, reader);
    ctx.sendJSON(res, result.success ? 200 : 500, result);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest('无效的JSON格式', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/mark-all-read */
export async function handleMarkAllRead(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let filters: any = {};
  try { filters = await parseBody(req) || {}; } catch {}
  const { sender, member, keyword } = filters;
  const sender_id = sender ? ctx.resolveSenderId(sender) : undefined;
  const member_id = member ? ctx.resolveMemberId(member) : undefined;
  const result = ctx.db.markAllRead({ sender: sender_id, member: member, member_id, keyword });
  ctx.sendJSON(res, 200, result);
}

/** POST /api/export-csv */
export async function handleExportCSV(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let filters: any = {};
  try { filters = await parseBody(req) || {}; } catch {}
  const { sender, member, keyword, unread_only, read_only } = filters;
  const sender_id = sender ? ctx.resolveSenderId(sender) : undefined;
  const member_id = member ? ctx.resolveMemberId(member) : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="messages.csv"',
  });
  // BOM for Excel UTF-8
  res.write('\uFEFF');
  res.write('id,msg_id,sender,recipient,content,created_at,is_unread,view_count\n');

  ctx.db.exportCSV({ sender: sender_id, member_id, keyword, unread_only, read_only }, (rows) => {
    const lines = rows.map(r => [
      r.id, r.msg_id,
      csvEscape(r.from_name), csvEscape(r.recipient), csvEscape(r.content),
      r.created_at, r.is_unread ? 'true' : 'false', r.view_count ?? 0
    ].join(','));
    res.write(lines.join('\n') + '\n');
  });
  res.end();
}

function csvEscape(val: any): string {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** POST /api/export-html */
export async function handleExportHTML(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let filters: any = {};
  try { filters = await parseBody(req) || {}; } catch {}
  const { sender, member, keyword, unread_only, read_only, locale } = filters;
  const sender_id = sender ? ctx.resolveSenderId(sender) : undefined;
  const member_id = member ? ctx.resolveMemberId(member) : undefined;

  const html = ctx.db.exportHTML({ sender: sender_id, member_id, keyword, unread_only, read_only }, locale);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': 'attachment; filename="messages.html"',
  });
  res.end(html);
}

/** POST /api/send-message */
export async function handleSendMessage(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const sender = data.sender || '';
    const recipient = data.recipient || '';
    const content = (data.content || '').trim();

    if (!sender || !recipient || !content) {
      throw AppError.validation('发送者、接收者和消息内容不能为空');
    }

    const senderId = ctx.resolveSenderId(sender);
    const recipientId = ctx.resolveSenderId(recipient) || '';

    const result = ctx.db.sendMessage({ sender, sender_id: senderId, recipient, recipient_id: recipientId, content });

    if (result.success) {
      result.message = {
        id: result.message_id, msg_id: result.msg_id,
        from_name: sender, from_id: senderId,
        recipient: recipient, recipient_id: recipientId,
        content: content, created_at: new Date().toISOString(),
        is_unread: true,
      };
    }

    // ★ auto_coordination 联动: 发消息后自动开启 msg_robot（必须在响应前完成，确保 forceRoute 时网关已感知）
    let msgRobotChanged = false;
    if (result.success) {
      try {
        const team = readTeamJson(ctx.config.projectRoot);
        if (!team) throw new Error('team 为空');
        const autoCoord = team.auto_coordination === true;
        const msgRobotRaw = team.msg_robot;
        const msgRobotType = typeof msgRobotRaw;
        const msgRobotEnabled = msgRobotType === 'boolean'
          ? msgRobotRaw
          : (msgRobotType === 'object' && msgRobotRaw !== null ? msgRobotRaw.enabled === true : false);

        console.log('[SendMessage] 📋 team.json state:', JSON.stringify({ autoCoord, msgRobotRaw, msgRobotType, msgRobotEnabled, projectRoot: ctx.config.projectRoot }));

        if (!autoCoord) {
          console.log('[SendMessage] ⏭️ Skipped: auto_coordination not enabled (current=' + team.auto_coordination + ', type=' + typeof team.auto_coordination + ')');
        } else if (msgRobotEnabled) {
          console.log('[SendMessage] ⏭️ Skipped: msg_robot already enabled (current=' + JSON.stringify(msgRobotRaw) + ')');
        } else {
          team.msg_robot = true;
          writeTeamJson(ctx.config.projectRoot, team);
          msgRobotChanged = true;
          console.log('[SendMessage] ✅ Set msg_robot to true, team.json written');
          const gw = resolveGatewayUrl(ctx.config);
          console.log('[SendMessage] 🔗 gatewayUrl=' + (gw || 'none'));
          if (gw) {
            try {
              const crResp = await fetch(`${gw}/coordclaw-plugin/coordclawcenter/cache-refresh`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }
              });
              console.log(`[SendMessage] ✅ cache-refresh (${crResp.status})`);
            } catch (e) { console.warn('[SendMessage] ⚠️ cache-refresh failed:', (e as Error).message); }
          }
        }
      } catch (e) { console.warn('[SendMessage] ⚠️ auto_coordination linkage error:', e); }
    }

    // 响应中携带 msg_robot 是否变更，前端可据此判断是否需要刷新
    const responseData = { ...result, msg_robot_changed: msgRobotChanged };
    ctx.sendJSON(res, result.success ? 200 : 500, responseData);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest('无效的JSON格式', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/toggle-read */
export async function handleToggleRead(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const msgId = data.msg_id || '';
    const readerName = data.reader_name || '';
    const readerId = data.reader_id || '';
    const action = data.action || '';

    if (!msgId || !readerName || !readerId) {
      throw AppError.validation('参数不全');
    }

    let result: any;
    if (action === 'mark_read') {
      result = ctx.db.markAsRead(msgId, readerName, readerId);
    } else if (action === 'mark_unread') {
      result = ctx.db.markAsUnread(msgId, readerId);
    } else {
      result = ctx.db.toggleRead(msgId, readerName, readerId);
    }
    ctx.sendJSON(res, result.success ? 200 : 500, result);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest('无效的JSON格式', error instanceof Error ? error.message : String(error));
  }
}
