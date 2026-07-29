import { getEventId, debug, info, error } from "../shared/logger";
import { parseStoredUtc, normalizeUtcStamp } from "../shared/time";
import { isCheckEnabled } from "../shared/message-picker";
import { AgentLifecycleState, AgentDispatchContext } from "../shared/types";
import {
  DEFAULT_LIFECYCLE_END_TIMEOUT_MS,
  DEFAULT_LANE_DRAINED_TIMEOUT_MS,
  parseNumberConfig,
  SessionState,
  clearSignals,
  sessionSignals,
  sessionActivityCache,
  getTeamTaskCompleted,
  setTeamTaskCompleted,
  generateChainId,
  extractAgentIdFromKey,
  refreshDatabase,
  globalLlmState,
} from "./internal-state";
import {
  getMemberByAgentId,
  isMember,
  isPM,
  loadTeamData,
  sortByT7Priority,
  buildDispatchAction,
  markTargetProcessing,
  executeDispatchAction,
  DispatchActionType,
} from "./dispatch";
import { writeSnapshotFile } from "../session-snapshot/persistence";
import {
  ensureCacheEntry,
  getSessionRecordBySessionKey,
  getRecordByAgentId,
  updateSessionRecord,
} from "./cache/manager";
import { calculateTriggerState, calculateOtherMemberState } from "./state/calculator";
import { getRecentReadRecords, resetReadStatusForAgent } from "./database/manager";
import { getSessionQueueTracker } from "./session-queue-tracker";

function getEarliestUnreadAt(receivedUnreadMessages: { created_at: string }[]): string | null {
  if (!receivedUnreadMessages || receivedUnreadMessages.length === 0) return null;
  let earliest: { created_at: string } | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const m of receivedUnreadMessages) {
    const ms = parseStoredUtc(m.created_at);
    if (Number.isNaN(ms)) continue; // 跳过空/坏值，避免 NaN 污染排序
    if (ms < earliestMs) {
      earliestMs = ms;
      earliest = m;
    }
  }
  // 返回规范化的 UTC ISO-Z，使下游 firstUnreadAt.localeCompare 排序等价于时间序
  return earliest ? normalizeUtcStamp(earliest.created_at) : null;
}

// ==================== 状态转换 ====================
export async function transitionToProcessing(sessionKey: string, agentId: string, source: string, runId?: string) {
  // 白名单前置：先检查成员和 sessionKey，通过后才操作 cache
  const member = getMemberByAgentId(
    (await loadTeamData()).teamData.members || [],
    agentId,
  );
  if (!member) return;

  const expectedSessionKey = member.sessionKey as string | undefined;
  if (expectedSessionKey && sessionKey !== expectedSessionKey) {
    debug('message-routing', `[SESSION] ${member.name || agentId}(${agentId}) sessionKey不匹配: 期望=${expectedSessionKey.slice(0, 50)} 实际=${sessionKey.slice(0, 50)}，跳过 (source=${source}) | ${sessionKey}`, getEventId());
    return;
  }

  const cached = await ensureCacheEntry(agentId, sessionKey);
  if (!cached) return;

  if (cached.status === 'processing') {
    debug('message-routing', `[SESSION] ${cached.agentName}(${cached.agentId}) | 已在processing中，跳过 (source=${source}${runId ? ` runId=${runId}` : ''}) | ${sessionKey}`, getEventId());
    return;
  }

  await updateStatus(sessionKey, 'processing', source, false);
}

export async function transitionToEnded(sessionKey: string, agentId: string, source: string, runId?: string, endedAt?: number) {
  const cached = sessionActivityCache.get(sessionKey);
  if (!cached) {
    await ensureCacheEntry(agentId, sessionKey);
  }

  const member = getMemberByAgentId(
    (await loadTeamData()).teamData.members || [],
    agentId,
  );
  if (!member) return;

  await updateStatus(sessionKey, 'ended', source, false, endedAt);
  clearSignals(sessionKey);
}

// ==================== updateStatus ====================
async function updateStatus(sessionKey: string, status: string, source: string, force = false, endedAt?: number): Promise<boolean> {
  const cached = sessionActivityCache.get(sessionKey);
  if (!cached) return false;

  if (!force && cached.status === status) {
    debug('message-routing', `[SESSION] ${cached.agentName}(${cached.agentId}) | 状态无变化, 跳过 (source=${source}) | ${sessionKey}`, getEventId());
    return false;
  }

  const oldStatus = cached.status;
  info('message-routing', `[SESSION] ${cached.agentName}(${cached.agentId}) | status ${oldStatus || 'null'} → ${status} (source=${source}) | ${sessionKey}`, getEventId());

  if (status === 'processing') {
    cached.status = 'processing';
    cached.state = AgentLifecycleState.RUNNING;
    cached.startedAt = new Date().toISOString();
    cached.endedAt = null;
  } else {
    cached.status = 'ended';
    cached.endedAt = endedAt ? new Date(endedAt).toISOString() : new Date().toISOString();
  }
  cached.updatedAt = new Date().toISOString();

  if (oldStatus === 'processing' && status === 'ended' && source !== 'llm_error') {
    try {
      const { teamData } = await loadTeamData();
      const msgRobotEnabled = teamData.msg_robot !== false && teamData.msg_robot !== "false";

      // 自动重置仅在 msg_robot 启用时执行
      if (msgRobotEnabled && teamData.resetcontext?.internal_plugin === true) {
        const { resetWithGuard } = await import('../session-reset/handler');
        await resetWithGuard(sessionKey);
        info('message-routing', `[AUTO-RESET] sessionKey reset after session end | ${sessionKey}`, getEventId());
      }

      // 消息路由仅在 msg_robot 启用时执行
      if (msgRobotEnabled) {
        await executeMessageRouting(sessionKey, source);
      }
    } catch (err: any) {
      info('message-routing', `[AUTO-RESET] skipped or failed: ${err.message} | ${sessionKey}`, getEventId());
    }
  }

  return true;
}

// ==================== 消息路由 ====================
export async function executeMessageRouting(sessionKey: string, source: string) {
  if (globalLlmState.error && !source.startsWith("force-route")) {
    info('message-routing', `[ROUTING] BLOCKED | global LLM error flag set (source=${source})`, getEventId());
    return;
  }

  const record = getSessionRecordBySessionKey(sessionKey);
  if (!record) {
    info('message-routing', `[ROUTING] SKIP | session not found in cache (source=${source}) | ${sessionKey}`, getEventId());
    return;
  }

  const agentId = record.agentId;
  const agentName = record.agentName;

  const chainId = `${generateChainId()}/${agentName}`;

  info('message-routing', `[ROUTING] [${chainId}] ===== ${agentName}(${agentId}) 消息分发开始 ===== (source=${source}) | ${sessionKey}`, getEventId());

  try {
    const { projectRoot, teamData } = await loadTeamData();
    refreshDatabase(projectRoot);
    const members = teamData.members || [];
    const msgRobotEnabled = teamData.msg_robot !== false && teamData.msg_robot !== "false";
    const triggerIsPM = isPM(members, agentId);

    info('message-routing', `[ROUTING] [${chainId}] TRIGGER-INFO: agent=${agentName}(${agentId}) isPM=${triggerIsPM} source=${source} projectRoot=${projectRoot}`, getEventId());

    if (!msgRobotEnabled) {
      info('message-routing', `[ROUTING] SKIP | msg_robot disabled | ${agentName}(${agentId}) projectRoot=${projectRoot}`, getEventId());
      return;
    }

    if (!isMember(members, agentId)) {
      info('message-routing', `[ROUTING] SKIP | trigger agent not in team | ${agentName}(${agentId})`, getEventId());
      return;
    }

    const memberStates = new Map<string, { state: AgentLifecycleState; sessionKey: string; agentName: string; hasUnread: number; hasSentGroupchat: number; firstUnreadAt: string | null; aborted: boolean }>();

    const triggerCache = sessionActivityCache.get(sessionKey);
    const triggerStartedAt = triggerCache?.startedAt ?? new Date().toISOString();
    const triggerEndedAt = triggerCache?.endedAt ?? new Date().toISOString();

    info('message-routing', `[ROUTING] [${chainId}] TRIGGER-WINDOW: ${triggerStartedAt} ~ ${triggerEndedAt}`, getEventId());
    info('message-routing', `[ROUTING] [${chainId}] WINDOW-GMT+8: ${new Date(triggerStartedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ~ ${new Date(triggerEndedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, getEventId());

    info('message-routing', `[ROUTING] [${chainId}] ===== 成员会话信息 =====`, getEventId());
    for (const m of members) {
      const mAgentId = m.agent_id;
      const mAgentName = m.name ?? mAgentId;
      const ensured = await ensureCacheEntry(
        mAgentId,
        m.sessionKey || `${mAgentId}:dashboard:unknown`,
      );
      if (ensured) {
        info('message-routing', `[ROUTING] [${chainId}]   ${mAgentName}(${mAgentId}): sessionKey=${ensured.sessionKey}, status=${ensured.status}`, getEventId());
      }
    }

    info('message-routing', `[ROUTING] [${chainId}] ===== 状态计算 =====`, getEventId());
    for (const m of members) {
      const mAgentId = m.agent_id;
      const mAgentName = m.name ?? mAgentId;
      try {
        const isTrigger = mAgentId === agentId;
        if (isTrigger) {
          info('message-routing', `[ROUTING] [${chainId}]   ${mAgentName}(${mAgentId}): [TRIGGER] using trigger window`, getEventId());
          const stateResult = await calculateTriggerState(
            projectRoot,
            mAgentId,
            mAgentName,
            triggerStartedAt,
            triggerEndedAt,
            sessionKey,
          );
          memberStates.set(mAgentId, {
            sessionKey,
            agentName: mAgentName,
            hasUnread: stateResult.has_unread,
            hasSentGroupchat: stateResult.has_sent_groupchat,
            state: stateResult.state,
            firstUnreadAt: getEarliestUnreadAt(stateResult.receivedUnreadMessages),
            aborted: stateResult.raw.aborted,
          });
          info('message-routing', `[ROUTING] [${chainId}]   STATE | ${mAgentName}(${mAgentId})=${stateResult.state} (unread=${stateResult.has_unread}, groupchat=${stateResult.has_sent_groupchat})`, getEventId());
        } else {
          const ownSessionKey = m.sessionKey || `${mAgentId}:dashboard:unknown`;
          info('message-routing', `[ROUTING] [${chainId}]   ${mAgentName}(${mAgentId}): [OTHER] using own sessionKey=${ownSessionKey}`, getEventId());
          const stateResult = await calculateOtherMemberState(
            projectRoot,
            mAgentId,
            mAgentName,
            ownSessionKey,
          );
          memberStates.set(mAgentId, {
            sessionKey: ownSessionKey,
            agentName: mAgentName,
            hasUnread: stateResult.has_unread,
            hasSentGroupchat: stateResult.has_sent_groupchat,
            state: stateResult.state,
            firstUnreadAt: getEarliestUnreadAt(stateResult.receivedUnreadMessages),
            aborted: stateResult.raw.aborted,
          });
          info('message-routing', `[ROUTING] [${chainId}]   STATE | ${mAgentName}(${mAgentId})=${stateResult.state} (unread=${stateResult.has_unread}, groupchat=${stateResult.has_sent_groupchat})`, getEventId());
        }
      } catch (err: any) {
        error('message-routing', `[ROUTING] [${chainId}] STATE-ERROR | ${mAgentName}: ${err.message}`, getEventId());
      }
    }

    const sortedMembers = sortByT7Priority(members, memberStates);
    let maxActivations = parseNumberConfig(teamData.max_activations, 2);

    const teamHasUnread = [...memberStates.values()].some(ms =>
      ms.state === AgentLifecycleState.HAS_UNREAD_MESSAGES ||
      ms.state === AgentLifecycleState.NEEDS_GROUPCHAT_AND_UNREAD
    );
    if (teamHasUnread) {
      setTeamTaskCompleted(false);
    }

    info('message-routing', `[ROUTING] [${chainId}] ===== 全员状态汇总 ===== teamHasUnread=${teamHasUnread} teamTaskCompleted=${getTeamTaskCompleted()}`, getEventId());
    for (const m of members) {
      const mAgentId = m.agent_id;
      const mAgentName = m.name ?? mAgentId;
      const mState = memberStates.get(mAgentId);
      const pmTag = isPM(members, mAgentId) ? '(PM)' : '';
      if (mState) {
        info('message-routing', `[ROUTING] [${chainId}]   ${mAgentName}${pmTag} = ${mState.state} (unread=${mState.hasUnread}, sent=${mState.hasSentGroupchat})`, getEventId());
      } else {
        info('message-routing', `[ROUTING] [${chainId}]   ${mAgentName}${pmTag} = (未计算)`, getEventId());
      }
    }
    info('message-routing', `[ROUTING] [${chainId}] ===== 分发决策 ===== maxActivations=${maxActivations}`, getEventId());

    const recentReads = await getRecentReadRecords(projectRoot, 20);
    if (recentReads.length > 0) {
      info('message-routing', `[ROUTING] [${chainId}] [DIAG-READS] 最近${recentReads.length}条已读记录(read_at): ${JSON.stringify(recentReads)}`, getEventId());
    }

    interface PendingDispatch {
      ctxObj: AgentDispatchContext;
      actionType: string;
      actionLabel: string;
      isPM: boolean;
      isTrigger: boolean;
      agentName: string;
      agentId: string;
      mState: any;
      firstUnreadAt: string | null;
    }
    const pendingList: PendingDispatch[] = [];

    for (const m of sortedMembers) {
      const mAgentId = m.agent_id;
      const mState = memberStates.get(mAgentId);
      if (!mState) continue;

      const isTrigger = mAgentId === agentId;
      const ctxObj: AgentDispatchContext = {
        agentId: mAgentId,
        agentName: mState.agentName,
        sessionKey: mState.sessionKey,
        state: mState.state,
        isPM: isPM(members, mAgentId),
        pmSessionKey: members[0]?.sessionKey,
        teamHasUnread,
        members,
        teamData,
        logger: console,
        chainId,
        isTrigger,
        projectRoot,
      };

      const action = buildDispatchAction(ctxObj, getTeamTaskCompleted());

      info('message-routing', `[ROUTING] [${chainId}] [DISPATCH-DETAIL] ${mState.agentName}(${mAgentId}) isPM=${ctxObj.isPM} isTrigger=${isTrigger} teamHasUnread=${teamHasUnread} state=${mState.state}`, getEventId());
      info('message-routing', `[ROUTING] [${chainId}] [DISPATCH] ${mState.agentName}(${mAgentId})${ctxObj.isPM ? '(PM)' : ''} → ${mState.state} → ${action.label}`, getEventId());

      pendingList.push({ ctxObj, actionType: action.type, actionLabel: action.label, isPM: ctxObj.isPM, isTrigger, agentName: mState.agentName, agentId: mAgentId, mState, firstUnreadAt: mState.firstUnreadAt });
    }

    // T7→T1 兜底：trigger 需要反馈但 T7 关闭 → 重置已读 + 发 msg1 唤醒（仅 skip，不碰 msg2）
    const triggerState = memberStates.get(agentId);
    if (triggerState && triggerState.state === AgentLifecycleState.NEEDS_GROUPCHAT_FEEDBACK && triggerState.hasSentGroupchat === 0) {
      if (!isCheckEnabled(teamData, 'checktaskfeedback')) {
        const triggerEntry = pendingList.find(e => e.isTrigger);
        if (triggerEntry && triggerEntry.actionType === 'skip') {
          info('message-routing', `[ROUTING] [${chainId}] T7→T1 | ${triggerState.agentName}(${agentId}) hasSent=0 + checktaskfeedback=OFF → reset read_at + msg1`, getEventId());
          const deleted = await resetReadStatusForAgent(projectRoot, agentId, triggerStartedAt, triggerEndedAt);
          info('message-routing', `[ROUTING] [${chainId}] T7→T1 | ${triggerState.agentName}(${agentId}) deleted ${deleted} read records`, getEventId());
          if (deleted > 0) {
            triggerEntry.actionType = 'msg1';
            triggerEntry.actionLabel = 'T7→T1: 发送msg1(未读提醒)';
            info('message-routing', `[ROUTING] [${chainId}] T7→T1 | ${triggerState.agentName}(${agentId}) skip → msg1`, getEventId());
          }
        }
      }
    }

    for (const m of members) {
      const mAgentId = m.agent_id;
      const mState = memberStates.get(mAgentId);
      if (!mState || !mState.aborted) continue;

      if (!isCheckEnabled(teamData, 'checkdeadlockstatus')) {
        info('message-routing', `[ROUTING] [${chainId}] ABORT-SKIP | ${mState.agentName}(${mAgentId}) aborted=true but checkdeadlockstatus disabled`, getEventId());
        const record = getSessionRecordBySessionKey(mState.sessionKey);
        if (record) record.aborted = false;
        continue;
      }

      const ctxObj: AgentDispatchContext = {
        agentId: mAgentId,
        agentName: mState.agentName,
        sessionKey: mState.sessionKey,
        state: mState.state,
        isPM: isPM(members, mAgentId),
        pmSessionKey: members[0]?.sessionKey,
        teamHasUnread,
        members,
        teamData,
        logger: console,
        chainId,
        isTrigger: mAgentId === agentId,
        projectRoot,
        aborted: true,
      };

      pendingList.unshift({
        ctxObj,
        actionType: 'msg5' as DispatchActionType,
        actionLabel: '发送msg5(abort通知)',
        isPM: ctxObj.isPM,
        isTrigger: ctxObj.isTrigger,
        agentName: mState.agentName,
        agentId: mAgentId,
        mState,
        firstUnreadAt: null,
      });

      const record = getSessionRecordBySessionKey(mState.sessionKey);
      if (record) record.aborted = false;
      info('message-routing', `[ROUTING] [${chainId}] ABORT-QUEUE | ${mState.agentName}(${mAgentId}) aborted=true → msg5 已插入队列，标记已重置`, getEventId());
    }

    pendingList.sort((a, b) => {
      if (a.actionType === 'msg5' && b.actionType !== 'msg5') return -1;
      if (a.actionType !== 'msg5' && b.actionType === 'msg5') return 1;
      if (a.actionType === 't7' && b.actionType !== 't7') return -1;
      if (a.actionType !== 't7' && b.actionType === 't7') return 1;
      if (a.actionType === 'msg2' && b.actionType === 'msg1') return -1;
      if (a.actionType === 'msg1' && b.actionType === 'msg2') return 1;
      if (a.actionType === 'msg1' && b.actionType === 'msg1') {
        if (a.firstUnreadAt && b.firstUnreadAt) {
          return a.firstUnreadAt.localeCompare(b.firstUnreadAt);
        }
        if (a.firstUnreadAt) return -1;
        if (b.firstUnreadAt) return 1;
      }
      return 0;
    });

    info('message-routing', `[ROUTING] [${chainId}] ===== Phase 2: 乐观标记 (最多 ${maxActivations}) =====`, getEventId());

    // 全局并发控制：取插件 cache 和 OpenClaw 队列的较大值
    const cmdState = (globalThis as any)[Symbol.for("openclaw.commandQueueState")];
    const mainLane = cmdState?.lanes?.get("main");
    const mainMax = mainLane?.maxConcurrent ?? 3;
    const queueUsed = mainLane?.activeTaskIds?.size ?? 0;
    const cacheUsed = [...sessionActivityCache.values()].filter(r => r.status === 'processing').length;
    const mainUsed = Math.max(queueUsed, cacheUsed);
    const freeSlots = Math.max(0, mainMax - mainUsed);
    const effectiveMax = Math.min(maxActivations, freeSlots);
    info('message-routing', `[ROUTING] [${chainId}] 全局并发: mainMax=${mainMax} mainUsed=${mainUsed} freeSlots=${freeSlots} effectiveMax=${effectiveMax}`, getEventId());

    const sendList: PendingDispatch[] = [];
    let markCount = 0;
    let triggerSelfTargeted = false;
    let hasBlockedCandidate = false;
    for (const item of pendingList) {
      if (item.actionType === 'skip') {
        info('message-routing', `[ROUTING] [${chainId}] MARK-SKIP | ${item.agentName}(${item.agentId}) 状态=${item.mState.state} 决策=${item.actionLabel}`, getEventId());
        continue;
      }
      if (item.actionType !== 'msg5' && markCount >= effectiveMax) {
        hasBlockedCandidate = true;
        info('message-routing', `[ROUTING] [${chainId}] MARK-LIMIT | ${item.agentName}(${item.agentId}) 超出上限(${markCount}/${effectiveMax}) 状态=${item.mState.state} → 不标记不发送`, getEventId());
        continue;
      }
      const prevStatus = getSessionRecordBySessionKey(item.ctxObj.sessionKey)?.status || '?';
      if (prevStatus !== 'ended') {
        info('message-routing', `[ROUTING] [${chainId}] MARK-CAS | ${item.agentName}(${item.agentId}) 已被标记(${prevStatus}) → 跳过，不耗槽位`, getEventId());
        continue;
      }
      if (item.actionType !== 'msg5') {
        markCount++;
      }
      if (item.ctxObj.sessionKey === sessionKey) {
        triggerSelfTargeted = true;
      }
      markTargetProcessing(item.ctxObj.sessionKey);
      if (item.actionType === 'msg2') {
        setTeamTaskCompleted(true);
      }
      sendList.push(item);
      info('message-routing', `[ROUTING] [${chainId}] MARK | [${markCount}/${maxActivations}] ${item.agentName}(${item.agentId}) ${prevStatus}→processing, action=${item.actionLabel}`, getEventId());
    }

    // 条件 keeper：并发全满 + 无 running agent → 保留 1 个最低循环
    if (sendList.length === 0 && hasBlockedCandidate) {
      const hasRunner = [...sessionActivityCache.values()]
        .some(r => r.fixable === true && r.status === 'processing');
      if (!hasRunner) {
        for (const item of pendingList) {
          if (item.actionType === 'skip' || item.actionType === 'msg5') continue;
          const prevStatus = getSessionRecordBySessionKey(item.ctxObj.sessionKey)?.status || '?';
          if (prevStatus !== 'ended') continue;
          markTargetProcessing(item.ctxObj.sessionKey);
          sendList.push(item);
          info('message-routing', `[ROUTING] [${chainId}] MARK-LIMIT-KEEPER | ${item.agentName}(${item.agentId}) 无running agent → 保留最低循环`, getEventId());
          break;
        }
      }
    }

    if (!triggerSelfTargeted) {
      info('message-routing', `[ROUTING] [${chainId}] Phase 2 完成: ${sendList.length} 个发送 | 路由已锁定`, getEventId());
    } else {
      info('message-routing', `[ROUTING] [${chainId}] Phase 2 完成: ${sendList.length} 个发送 | 路由未锁定(trigger自身也是目标)`, getEventId());
    }

    info('message-routing', `[ROUTING] [${chainId}] ===== Phase 3: 定时发射 (间隔1s) =====`, getEventId());
    for (let i = 0; i < sendList.length; i++) {
      const item = sendList[i];
      const seq = i + 1;
      const delay = i * 1000;

      setTimeout(async () => {
        try {
          await executeDispatchAction({ type: item.actionType as 'msg1' | 'msg2' | 't7' }, item.ctxObj);
          info('message-routing', `[ROUTING] [${chainId}] SENT | [${seq}/${sendList.length}] ${item.agentName}(${item.agentId}) action=${item.actionLabel}`, getEventId());

          // 发送成功后 10s，若仍未收到 onPromptBuild(agent 真实起 run)，翻 fixable=true
          // 让 health_poll 可在 agent 因竞态/异常未启动时回退 processing→ended，避免永久 stuck
          setTimeout(() => {
            const rec = getSessionRecordBySessionKey(item.ctxObj.sessionKey);
            if (rec && rec.fixable === false && rec.status === 'processing') {
              rec.fixable = true;
              writeSnapshotFile(item.ctxObj.sessionKey);
              info('message-routing', `[ROUTING] [${chainId}] fixable-flip | ${item.agentName} fixable→true (sent+10s, no prompt_build)`, getEventId());
            }
          }, 10000);
        } catch (err: any) {
          const targetSessionKey = item.ctxObj.sessionKey;
          const targetRecord = getSessionRecordBySessionKey(targetSessionKey);

          // TOCTOU-SKIP / LANE-BLOCKED 但 agent 已被真实唤醒(fixable=true) → 不碰status，不重试
          const isTocTou = err.message?.includes('TOCTOU-SKIP') || err.message?.includes('TOCTOU-LANE-BLOCKED');
          if (isTocTou && targetRecord?.fixable === true) {
            info('message-routing', `[ROUTING] [${chainId}] FAILED(TOCTOU-已启动) | ${item.agentName}(${item.agentId}) fixable=true → agent已启动，不碰status不重试`, getEventId());
            return;
          }

          // TOCTOU + fixable=false → 外部触发/清理窗口，不是路由唤醒的 → 与发送失败同款可恢复
          if (isTocTou) {
            if (targetRecord) { targetRecord.status = 'ended'; writeSnapshotFile(targetSessionKey); }
            if (item.actionType === 'msg2') setTeamTaskCompleted(false);
            error('message-routing', `[ROUTING] [${chainId}] FAILED(TOCTOU-外部) | ${item.agentName}(${item.agentId}) ${err.message} — fixable=false，回退ended，30s后重试`, getEventId());
            setTimeout(() => {
              executeMessageRouting(targetSessionKey, 'retry-failed-send').catch(() => {});
            }, 30_000);
            return;
          }

          const targetSig = sessionSignals.get(targetSessionKey);
          const wasDelivered = targetSig && targetSig.state !== SessionState.IDLE;

          if (wasDelivered) {
            info('message-routing', `[ROUTING] [${chainId}] FAILED(已送达) | ${item.agentName}(${item.agentId}) ${err.message} — 保持processing`, getEventId());
          } else {
            if (targetRecord) { targetRecord.status = 'ended'; writeSnapshotFile(targetSessionKey); }
            if (item.actionType === 'msg2') setTeamTaskCompleted(false);
            error('message-routing', `[ROUTING] [${chainId}] FAILED(未送达) | ${item.agentName}(${item.agentId}) ${err.message} — 回退ended，30s后重试`, getEventId());
            setTimeout(() => {
              executeMessageRouting(targetSessionKey, 'retry-failed-send').catch(() => {});
            }, 30_000);
          }
        }
      }, delay);
    }
    info('message-routing', `[ROUTING] [${chainId}] Phase 3 调度完成: ${sendList.length} 条已排入定时器`, getEventId());

    const windowDurationSec = Math.round((new Date(triggerEndedAt).getTime() - new Date(triggerStartedAt).getTime()) / 1000);
    const windowDurationStr = windowDurationSec >= 60
      ? `${Math.floor(windowDurationSec / 60)}分${windowDurationSec % 60}秒`
      : `${windowDurationSec}秒`;
    info('message-routing', `[ROUTING] [${chainId}] ===== ${agentName}(${agentId}) 消息分发结束 ===== 发送: ${sendList.length} | 窗口时长: ${windowDurationStr}`, getEventId());
  } catch (err: any) {
    error('message-routing', `[ROUTING] ERROR | ${err.message} | ${sessionKey}`, getEventId());
  }
}