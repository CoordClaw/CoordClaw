import { debug, info, warn, getEventId } from "../../shared/logger";
import { AgentLifecycleState, AgentActivityRecord } from "../../shared/types";
import { getSessionQueueTracker } from "../session-queue-tracker";
import { clearSignals, resetMsgReminderCount, resetLastCompactionTime, clearAncillaryState } from "../internal-state";

// 创建"已结束、不可修复"的会话活动记录（消除 B 集群 fixable 缺失 + 去重两处字面量）。
function createEndedRecord(agentId: string, sessionKey: string, agentName: string): AgentActivityRecord {
  const now = new Date().toISOString();
  return {
    agentId,
    agentName,
    sessionKey,
    roundIndex: 0,
    status: 'ended',
    state: AgentLifecycleState.COMPLETED_WITH_GROUPCHAT,
    hasUnread: 0,
    hasSentGroupchat: 1,
    startedAt: now,
    endedAt: null,
    updatedAt: now,
    aborted: false,
    fixable: false,
    totalTokens: 0,
    totalToolCalls: 0,
    runs: [],
  };
}

const sessionActivityCache = new Map<string, AgentActivityRecord>();
const agentIdToSessionKey = new Map<string, string>();

export function getSessionActivityCache(): Map<string, AgentActivityRecord> {
  return sessionActivityCache;
}

export async function initAgentActivityCache(members: any[]): Promise<void> {
  const now = new Date().toISOString();
  let initCount = 0;
  
  for (const m of members) {
    const agentId = m.agent_id;
    const sessionKey = m.sessionKey || '';
    
    if (!sessionKey) {
      warn('message-routing', `initAgentActivityCache: member ${agentId} has no sessionKey, skipping`, getEventId());
      continue;
    }
    
    if (!sessionActivityCache.has(sessionKey)) {
      const record: AgentActivityRecord = {
        agentId,
        agentName: m.name || agentId,
        sessionKey,
        roundIndex: 0,
        status: 'ended',
        state: AgentLifecycleState.COMPLETED_WITH_GROUPCHAT,
        hasUnread: 0,
        hasSentGroupchat: 1,
        startedAt: now,
        endedAt: null,
        updatedAt: now,
        aborted: false,
        fixable: true,
        totalTokens: 0,
        totalToolCalls: 0,
        runs: [],
      };
      sessionActivityCache.set(sessionKey, record);
      agentIdToSessionKey.set(agentId, sessionKey);
      initCount++;
    }
  }

  if (initCount > 0) {
    info('message-routing', `initAgentActivityCache: initialized ${initCount} new sessions`, getEventId());
  } else {
    debug('message-routing', `initAgentActivityCache: all sessions already initialized`, getEventId());
  }
}

export function getSessionRecordBySessionKey(sessionKey: string): AgentActivityRecord | undefined {
  if (!sessionKey) return undefined;
  return sessionActivityCache.get(sessionKey);
}

export function getRecordByAgentId(agentId: string): AgentActivityRecord | undefined {
  if (!agentId) return undefined;
  const sk = agentIdToSessionKey.get(agentId);
  if (!sk) return undefined;
  return sessionActivityCache.get(sk);
}

export function migrateSessionKey(agentId: string, newSessionKey: string): AgentActivityRecord | undefined {
  if (!agentId || !newSessionKey) return undefined;

  const oldSk = agentIdToSessionKey.get(agentId);
  if (oldSk && oldSk !== newSessionKey) {
    const oldRecord = sessionActivityCache.get(oldSk);
    if (oldRecord) {
      sessionActivityCache.delete(oldSk);
      oldRecord.sessionKey = newSessionKey;
      oldRecord.updatedAt = new Date().toISOString();
      sessionActivityCache.set(newSessionKey, oldRecord);
      agentIdToSessionKey.set(agentId, newSessionKey);

      // 联动 tracker：清空旧 key，加入新 key（替换，非增量）
      const tracker = getSessionQueueTracker();
      const nextKeys = tracker.getTrackedKeys().filter((k) => k !== oldSk);
      if (!nextKeys.includes(newSessionKey)) {
        nextKeys.push(newSessionKey);
      }
      tracker.setTrackedSessionKeys(nextKeys);

      debug('message-routing', `migrateSessionKey: ${agentId} ${oldSk} → ${newSessionKey}`, getEventId());
      return oldRecord;
    }
  }

  if (!oldSk) {
    return undefined;
  }

  return sessionActivityCache.get(oldSk);
}

export function ensureCacheEntry(agentId: string, newSessionKey: string, agentName?: string): AgentActivityRecord | undefined {
  if (!agentId || !newSessionKey) return undefined;

  const existing = sessionActivityCache.get(newSessionKey);
  if (existing) return existing;

  const migrated = migrateSessionKey(agentId, newSessionKey);
  if (migrated) return migrated;

  const name = agentName || agentId;
  const record = createEndedRecord(agentId, newSessionKey, name);
  sessionActivityCache.set(newSessionKey, record);
  agentIdToSessionKey.set(agentId, newSessionKey);
  debug('message-routing', `ensureCacheEntry: created new entry for ${name}(${agentId}) session=${newSessionKey}`, getEventId());
  return record;
}

export function updateSessionRecord(sessionKey: string, updates: Partial<AgentActivityRecord>): void {
  if (!sessionKey) return;
  
  const record = sessionActivityCache.get(sessionKey);
  if (record) {
    Object.assign(record, updates);
    record.updatedAt = new Date().toISOString();
  }
}

export function getAgentStateVector(): string {
  const vectors: string[] = [];
  for (const [sessionKey, record] of sessionActivityCache) {
    vectors.push(`${sessionKey}:${record.state}`);
  }
  return vectors.join(',');
}

export function getActiveSessions(): Map<string, { sessionKey: string; startTs: number }> {
  const sessions = new Map<string, { sessionKey: string; startTs: number }>();
  for (const [sessionKey, record] of sessionActivityCache) {
    if (record.status === 'processing' && record.startedAt) {
      sessions.set(sessionKey, {
        sessionKey: record.sessionKey,
        startTs: new Date(record.startedAt).getTime()
      });
    }
  }
  return sessions;
}

/**
 * 增量同步 sessionActivityCache 和 agentIdToSessionKey
 *
 * 不清除现有缓存，根据 team.json 的 members 数组做增量更新：
 *   - 新增成员 → 创建 ended 条目
 *   - 已有成员 → 只更新静态字段（name），不动动态字段（status/state/roundIndex/tokens/runs）
 *   - 移除成员 → 仅当状态为 ended 时删除，processing 状态保留
 *
 * @param members team.json 的 members 数组
 * @returns 同步统计：新增/更新/保留/移除/跳过
 */
export function syncFromMembers(members: any[]): {
  added: number;
  updated: number;
  retained: number;
  removed: number;
  skipped: number;
} {
  const now = new Date().toISOString();
  const newKeys = new Set<string>();
  const memberBySessionKey = new Map<string, any>();

  for (const m of members) {
    const sk = m.sessionKey;
    if (sk && sk.length > 0) {
      newKeys.add(sk);
      memberBySessionKey.set(sk, m);
    }
  }

  // 统计旧 sessionKey
  const oldKeys = new Set(sessionActivityCache.keys());
  const oldAgentIdKeys = new Map(agentIdToSessionKey.entries());
  let added = 0, updated = 0, retained = 0, removed = 0, skipped = 0;

  // 1. 处理移除的成员（在旧缓存中但不在新 members 中）
  for (const [oldSk, oldRecord] of sessionActivityCache.entries()) {
    if (!newKeys.has(oldSk)) {
      if (oldRecord.status !== 'processing') {
        sessionActivityCache.delete(oldSk);
        clearSignals(oldSk);
        resetMsgReminderCount(oldSk);
        resetLastCompactionTime(oldSk);
        for (const [aid, sk] of oldAgentIdKeys) {
          if (sk === oldSk) agentIdToSessionKey.delete(aid);
        }
        removed++;
        debug('message-routing', `syncFromMembers: removed ended member sessionKey=${oldSk.slice(-32)}`, getEventId());
      } else {
        // processing 状态保留不动
        retained++;
        debug('message-routing', `syncFromMembers: retained processing member sessionKey=${oldSk.slice(-32)}`, getEventId());
      }
    }
  }

  // 2. 处理新增/更新的成员
  for (const [sk, m] of memberBySessionKey) {
    const agentId = m.agent_id;
    if (!agentId) {
      skipped++;
      warn('message-routing', `syncFromMembers: member has no agent_id, skipping`, getEventId());
      continue;
    }

    const existingRecord = sessionActivityCache.get(sk);

    if (existingRecord) {
      // 已有成员：只更新静态字段
      const oldName = existingRecord.agentName;
      const newName = m.name || agentId;
      if (oldName !== newName) {
        existingRecord.agentName = newName;
        existingRecord.updatedAt = now;
        updated++;
        debug('message-routing', `syncFromMembers: updated name "${oldName}" → "${newName}" sessionKey=${sk.slice(-32)}`, getEventId());
      } else {
        retained++;
      }
      // 确保 agentIdToSessionKey 映射正确
      agentIdToSessionKey.set(agentId, sk);
    } else {
      // 新成员：创建 ended 条目
      const record = createEndedRecord(agentId, sk, m.name || agentId);
      sessionActivityCache.set(sk, record);
      agentIdToSessionKey.set(agentId, sk);
      added++;
      debug('message-routing', `syncFromMembers: added new member ${m.name || agentId} sessionKey=${sk.slice(-32)}`, getEventId());
    }
  }

  info('message-routing', `syncFromMembers: added=${added} updated=${updated} retained=${retained} removed=${removed} skipped=${skipped} total=${members.length}`, getEventId());
  return { added, updated, retained, removed, skipped };
}

/**
 * 全量重建 sessionActivityCache 和 agentIdToSessionKey
 *
 * 全量清除现有缓存，根据 team.json 的 members 数组重新初始化。
 * 由 cache-coordinator 协调层调用，用于项目切换场景（fullReset）。
 *
 * @param members team.json 的 members 数组
 */
export function rebuildFromMembers(members: any[]): void {
  const now = new Date().toISOString();

  sessionActivityCache.clear();
  agentIdToSessionKey.clear();
  clearAncillaryState();

  let initCount = 0;
  const allSessionKeys: string[] = [];
  const tracker = getSessionQueueTracker();

  for (const m of members) {
    const agentId = m.agent_id;
    const sessionKey = m.sessionKey || '';

    if (!sessionKey) {
      warn('message-routing', `rebuildFromMembers: member ${agentId} has no sessionKey, skipping`, getEventId());
      continue;
    }

    allSessionKeys.push(sessionKey);

    const idle = tracker.isIdle(sessionKey);
    const record: AgentActivityRecord = {
      agentId,
      agentName: m.name || agentId,
      sessionKey,
      roundIndex: 0,
      status: idle ? 'ended' : 'processing',
      state: idle ? AgentLifecycleState.COMPLETED_WITH_GROUPCHAT : AgentLifecycleState.RUNNING,
      hasUnread: 0,
      hasSentGroupchat: idle ? 1 : 0,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      aborted: false,
      fixable: true,
      totalTokens: 0,
      totalToolCalls: 0,
      runs: [],
    };
    sessionActivityCache.set(sessionKey, record);
    agentIdToSessionKey.set(agentId, sessionKey);
    initCount++;
  }

  // 同步 tracker 的 trackedKeys，使健康轮询能监控这些 sessionKey
  tracker.setTrackedSessionKeys(allSessionKeys);

  info('message-routing', `rebuildFromMembers: rebuilt ${initCount} entries from ${members.length} members`, getEventId());
}
