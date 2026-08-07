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
  buildDispatchAction,
  markTargetProcessing,
  executeDispatchAction,
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
import { setStatusAndTime } from './transition';

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

  await updateStatus(sessionKey, 'processing', source);
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

  await updateStatus(sessionKey, 'ended', source, endedAt);
  clearSignals(sessionKey);
}

// ==================== updateStatus ====================
async function updateStatus(sessionKey: string, status: string, source: string, endedAt?: number): Promise<boolean> {
  const cached = sessionActivityCache.get(sessionKey);
  if (!cached) return false;

  const oldStatus = cached.status;
  info('message-routing', `[SESSION] ${cached.agentName}(${cached.agentId}) | status ${oldStatus || 'null'} → ${status} (source=${source}) | ${sessionKey}`, getEventId());

  setStatusAndTime(cached, status, endedAt);
  if (status === 'processing') {
    cached.state = AgentLifecycleState.RUNNING;
  }
  cached.updatedAt = new Date().toISOString();
  writeSnapshotFile(sessionKey);

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
    // 解耦核心: 列表分桶拼接 + 仅 msg1 桶内排序。skip 直接丢弃, 永不进排序(消除非传递比较器污染 msg1 顺序)。
    function compareFirstUnreadAt(a: PendingDispatch, b: PendingDispatch): number {
      const fa = a.firstUnreadAt, fb = b.firstUnreadAt;
      if (fa && fb) return fa.localeCompare(fb); // 最早未读(滞留最久)排前
      if (fa) return -1;                          // null 置最末, 保传递性
      if (fb) return 1;
      return 0;
    }
    function buildDispatchQueue(list: PendingDispatch[]): PendingDispatch[] {
      const buckets: Record<string, PendingDispatch[]> = { msg5: [], t7: [], msg2: [], msg1: [] };
      for (const e of list) {
        if (e.actionType === 'skip') continue;            // skip 直接丢弃
        (buckets[e.actionType] ?? buckets.msg1).push(e);  // msg5/t7/msg2 各≤1, 占位无需排序
      }
      buckets.msg1.sort(compareFirstUnreadAt);             // 唯一真实排序, 隔离纯函数
      return [...buckets.msg5, ...buckets.t7, ...buckets.msg2, ...buckets.msg1];
    }

    const pendingList: PendingDispatch[] = [];

    for (const m of members) {
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
        aborted: mState.aborted,
        projectRoot,
      };

      const action = buildDispatchAction(ctxObj, getTeamTaskCompleted());

      // 预留机制(msg5): 若 abort 被判定为抑制(返回 skip 而非 msg5, 通常 checkdeadlockstatus 关闭),
      // 在此消费(aborted)标志, 避免该 agent 在后续路由 pass 中反复触发。
      // (msg5 真正派发时的标志清除在 Phase2 派发点执行, 避免 CAS 跳过导致"清了却没发"。)
      if (ctxObj.aborted && ctxObj.isTrigger && action.type === 'skip') {
        const rec = getSessionRecordBySessionKey(mState.sessionKey);
        if (rec) rec.aborted = false;
      }

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

    // msg5(abort 通知) 已并入 buildDispatchAction 统一判定(仅被 abort 的 trigger 自处理),
    // 不再在此独立循环 scoop 他人 abort。详见 dispatch.ts buildDispatchAction 顶部分支。

    // 解耦: 分桶拼接 + 仅 msg1 内排序。skip 直接丢弃, 绝不进排序(消除非传递比较器污染)。
    const dispatchQueue = buildDispatchQueue(pendingList);

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
    for (const item of dispatchQueue) {
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
      // 预留机制(msg5): 仅在 msg5 实际派发(通过 CAS)时才消费 aborted 标志, 避免 CAS 跳过导致"清了却没发"。
      if (item.actionType === 'msg5') {
        const rec = getSessionRecordBySessionKey(item.ctxObj.sessionKey);
        if (rec) rec.aborted = false;
      }
      info('message-routing', `[ROUTING] [${chainId}] MARK | [${markCount}/${maxActivations}] ${item.agentName}(${item.agentId}) ${prevStatus}→processing, action=${item.actionLabel}`, getEventId());
    }

    // 条件 keeper：并发全满 + 无 running agent → 保留 1 个最低循环
    if (sendList.length === 0 && hasBlockedCandidate) {
      const hasRunner = [...sessionActivityCache.values()]
        .some(r => r.fixable === true && r.status === 'processing');
      if (!hasRunner) {
        for (const item of dispatchQueue) {
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
          await executeDispatchAction({ type: item.actionType as 'msg1' | 'msg2' | 't7' | 'msg5' }, item.ctxObj);
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
            if (targetRecord) { setStatusAndTime(targetRecord, 'ended'); writeSnapshotFile(targetSessionKey); }
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
            if (targetRecord) { setStatusAndTime(targetRecord, 'ended'); writeSnapshotFile(targetSessionKey); }
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