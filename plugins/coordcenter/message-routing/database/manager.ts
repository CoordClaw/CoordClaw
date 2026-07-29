import { debug, info, warn, error, getEventId } from "../../shared/logger";
import { withTeamDbLock } from "../../shared/concurrency";
import { UnreadMessageInfo } from "../../shared/types";
import { getDatabase } from "../internal-state";
import { getCoordClawDbPath } from "../../shared/paths";
import { parseStoredUtc, toUnixSeconds, formatUtcStamp } from "../../shared/time";

// DB 类型薄封装：消除 node:sqlite 返回类型与领域类型不匹配（C 集群 .all() 强转 + D 集群 changes number|bigint）。
function dbQuery<T>(db: any, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function dbRunChanges(db: any, sql: string, ...params: any[]): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.changes);
}

function logDbAccess(projectRoot: string, functionName: string): void {
  const dbPath = getCoordClawDbPath(projectRoot);
  debug('message-routing', `[DB-ACCESS] ${functionName}: path=${dbPath}, projectRoot=${projectRoot}`, getEventId());
}

export async function getReceivedUnreadMessages(
  projectRoot: string,
  agentId: string
): Promise<UnreadMessageInfo[]> {
  debug('message-routing', `[DB-QUERY] getReceivedUnreadMessages: ${agentId} (window=NONE)`, getEventId());
  return withTeamDbLock(async () => {
    try {
      logDbAccess(projectRoot, 'getReceivedUnreadMessages');
      const db = getDatabase(projectRoot);
      const query = `SELECT tm.sender, tm.recipient, tm.created_at, tm.msg_id, tm.content, tmr.read_at
           FROM team_messages tm
           LEFT JOIN team_message_reads tmr ON tm.msg_id = tmr.msg_id AND tmr.reader_id = ?
           WHERE tm.recipient_id = ?
           AND tmr.msg_id IS NULL`;
      const messages = dbQuery<UnreadMessageInfo>(db, query, agentId, agentId);
      debug('message-routing', `[DB-RESULT] getReceivedUnreadMessages: ${agentId} found ${messages.length} unread messages`, getEventId());
      return messages;
    } catch (err: any) {
      error('message-routing', `getReceivedUnreadMessages ERROR for ${agentId}: ${err.message}`, getEventId());
      return [];
    }
  });
}

export async function getSentUnreadMessages(
  projectRoot: string,
  agentId: string
): Promise<UnreadMessageInfo[]> {
  debug('message-routing', `[DB-QUERY] getSentUnreadMessages: ${agentId} (window=NONE)`, getEventId());
  return withTeamDbLock(async () => {
    try {
      logDbAccess(projectRoot, 'getSentUnreadMessages');
      const db = getDatabase(projectRoot);
      const query = `SELECT tm.sender, tm.recipient, tm.created_at, tm.msg_id, tm.content, tmr.read_at
           FROM team_messages tm
           LEFT JOIN team_message_reads tmr ON tm.msg_id = tmr.msg_id AND tmr.reader_id = tm.recipient_id
           WHERE tm.sender_id = ?
           AND tmr.msg_id IS NULL`;
      const messages = dbQuery<UnreadMessageInfo>(db, query, agentId);
      debug('message-routing', `[DB-RESULT] getSentUnreadMessages: ${agentId} found ${messages.length} sent unread messages`, getEventId());
      return messages;
    } catch (err: any) {
      error('message-routing', `getSentUnreadMessages ERROR for ${agentId}: ${err.message}`, getEventId());
      return [];
    }
  });
}

export async function getRecentReadRecords(
  projectRoot: string,
  limit: number = 20
): Promise<{ msg_id: string; reader_id: string; read_at: string }[]> {
  return withTeamDbLock(async () => {
    try {
      logDbAccess(projectRoot, 'getRecentReadRecords');
      const db = getDatabase(projectRoot);
      return db.prepare(
        `SELECT msg_id, reader_id, read_at FROM team_message_reads ORDER BY read_at DESC LIMIT ?`
      ).all(limit) as any[];
    } catch (err: any) {
      error('message-routing', `getRecentReadRecords ERROR: ${err.message}`, getEventId());
      return [];
    }
  });
}

export async function checkGroupchatSentInDb(
  projectRoot: string,
  agentId: string,
  windowStart: string,
  windowEnd: string
): Promise<number> {
  debug('message-routing', `[DB-QUERY] checkGroupchatSentInDb: ${agentId} window=[${windowStart} ~ ${windowEnd}]`, getEventId());
  return withTeamDbLock(async () => {
    try {
      logDbAccess(projectRoot, 'checkGroupchatSentInDb');
      const db = getDatabase(projectRoot);

      // 控制面板写入的 created_at 已是 UTC；用 unixepoch() 把 DB 文本解析为 UTC 秒，
      // 与窗口的 UTC 秒比较——与具体 UTC 文本格式（"YYYY-MM-DD HH:MM:SS" 或 ISO-Z）无关。
      const startSec = toUnixSeconds(windowStart);
      const endSec = toUnixSeconds(windowEnd);
      debug('message-routing', `[DB-QUERY] checkGroupchatSentInDb: time window UTC [${formatUtcStamp(windowStart)} ~ ${formatUtcStamp(windowEnd)}]`, getEventId());

      const query = `SELECT sender, recipient, created_at, msg_id FROM team_messages
           WHERE sender_id = ?
           AND unixepoch(created_at) >= ?
           AND unixepoch(created_at) <= ?`;
      const foundMessages = db.prepare(query).all(agentId, startSec, endSec) as any[];
      const count = foundMessages.length;
      debug('message-routing', `[DB-RESULT] checkGroupchatSentInDb: ${agentId} found ${count} messages in window`, getEventId());
      for (const msg of foundMessages) {
        debug('message-routing', `[DB-RESULT]   ↳ msg_id=${msg.msg_id} sender=${msg.sender} recipient=${msg.recipient} at=${msg.created_at}`, getEventId());
      }
      return count > 0 ? 1 : 0;
    } catch (err: any) {
      error('message-routing', `checkGroupchatSentInDb ERROR for ${agentId}: ${err.message}`, getEventId());
      return 0;
    }
  });
}
export async function resetReadStatusForAgent(
  projectRoot: string,
  agentId: string,
  windowStart: string,
  windowEnd: string
): Promise<number> {
  debug('message-routing', `[DB-MUTATION] resetReadStatusForAgent: ${agentId} window=[${windowStart} ~ ${windowEnd}]`, getEventId());
  return withTeamDbLock(async () => {
    try {
      logDbAccess(projectRoot, 'resetReadStatusForAgent');
      const db = getDatabase(projectRoot);

      const startSec = toUnixSeconds(windowStart);
      const endSec = toUnixSeconds(windowEnd);
      debug('message-routing', `[DB-MUTATION] resetReadStatusForAgent: time window UTC [${formatUtcStamp(windowStart)} ~ ${formatUtcStamp(windowEnd)}]`, getEventId());

      const deleted = dbRunChanges(db,
        `DELETE FROM team_message_reads WHERE reader_id = ? AND unixepoch(read_at) >= ? AND unixepoch(read_at) <= ?`,
        agentId, startSec, endSec);

      debug('message-routing', `[DB-RESULT] resetReadStatusForAgent: ${agentId} deleted ${deleted} read records`, getEventId());
      return deleted;
    } catch (err: any) {
      error('message-routing', `resetReadStatusForAgent ERROR for ${agentId}: ${err.message}`, getEventId());
      return 0;
    }
  });
}
