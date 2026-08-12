import { debug, info, warn, error, getEventId } from "../../shared/logger";
import { withTeamDbLock } from "../../shared/concurrency";
import { UnreadMessageInfo } from "../../shared/types";
import { getDatabase, getTaskProgressDatabase } from "../internal-state";
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

/**
 * 查询成员 agent 的 T5 任务是否已完成（task_progress.db 权威真相源）。
 *
 * 返回语义（精确分野，与"有库必用 100 界限"一致）：
 *   - null ：task_progress.db 文件不存在 —— 唯一允许上层回退旧逻辑（"是否发消息"）的信号。
 *   - false：库存在，但（a）该 agent 无记录，或（b）最新 task_progress !== 100，或（c）读取出错。
 *            一律保守为"未完成"，绝不回退旧的"是否发消息"代理逻辑。
 *   - true ：库存在，且该 agent 最新一条 task_progress === 100（T5 完成）。
 *
 * 复用 withTeamDbLock（串行队列）+ dbQuery（薄封装）+ error/getEventId（既有日志方案）。
 * 取该 agent 最新一条记录（ORDER BY id DESC LIMIT 1）的 task_progress 比对 100。
 */
export async function getMemberTaskCompletion(
  projectRoot: string,
  agentId: string
): Promise<boolean | null> {
  debug('message-routing', `[DB-QUERY] getMemberTaskCompletion: ${agentId}`, getEventId());
  return withTeamDbLock(async () => {
    const db = getTaskProgressDatabase(projectRoot);
    if (!db) return null;   // 文件缺失 → 上层回退旧逻辑的唯一信号
    try {
      const rows = dbQuery<{ task_progress: number }>(
        db,
        `SELECT task_progress FROM task_progress WHERE agent_id = ? ORDER BY id DESC LIMIT 1`,
        agentId
      );
      if (!rows.length) {
        debug('message-routing', `[DB-RESULT] getMemberTaskCompletion: ${agentId} no record → false`, getEventId());
        return false;
      }
      const done = rows[0].task_progress === 100;
      debug('message-routing', `[DB-RESULT] getMemberTaskCompletion: ${agentId} task_progress=${rows[0].task_progress} → done=${done}`, getEventId());
      return done;
    } catch (err: any) {
      error('message-routing', `getMemberTaskCompletion ERROR for ${agentId}: ${err.message}`, getEventId());
      return false;  // 库存在但读错 → 保守未完成，绝不回退旧逻辑
    }
  });
}
