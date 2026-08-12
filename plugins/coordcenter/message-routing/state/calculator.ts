import { debug, error, getEventId } from "../../shared/logger";
import { getSessionRecordBySessionKey } from "../cache/manager";
import { AgentLifecycleState, CalculationResult } from "../../shared/types";
import { mapToBusinessState } from "./mapper";
import { checkGroupchatSentInDb, getMemberTaskCompletion, getReceivedUnreadMessages, getSentUnreadMessages } from "../database/manager";

export async function calculateTriggerState(
  projectRoot: string,
  agentId: string,
  agentName: string,
  startedAt: string,
  endedAt: string,
  sessionKey: string,
  allowT7: boolean = true
): Promise<CalculationResult> {
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName}(${agentId}) session=${sessionKey}`, getEventId());
  debug('message-routing', `[TRACE] calculateTriggerState: window=${startedAt} ~ ${endedAt}`, getEventId());
  const calcStartTime = Date.now();

  if (!sessionKey) {
    error('message-routing', `calculateTriggerState: no sessionKey provided for ${agentName}`, getEventId());
    return {
      has_unread: 0,
      has_sent_groupchat: 0,
      state: AgentLifecycleState.COMPLETED_WITH_GROUPCHAT,
      raw: { running: false, hasUnread: false, hasSentGroupchat: false, aborted: false },
      receivedUnreadMessages: [],
      sentUnreadMessages: []
    };
  }

  const cachedRecord = getSessionRecordBySessionKey(sessionKey);
  const isRunning = cachedRecord ? cachedRecord.status === 'processing' : false;
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} cache.status=${cachedRecord?.status || 'null'}, isRunning=${isRunning}`, getEventId());

  if (isRunning) {
    debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} is running, returning RUNNING`, getEventId());
    return {
      has_unread: 0,
      has_sent_groupchat: cachedRecord?.hasSentGroupchat ?? 0,
      state: AgentLifecycleState.RUNNING,
      raw: { running: true, hasUnread: false, hasSentGroupchat: Boolean(cachedRecord?.hasSentGroupchat), aborted: cachedRecord?.aborted ?? false },
      receivedUnreadMessages: [],
      sentUnreadMessages: []
    };
  }

  const receivedUnread = await getReceivedUnreadMessages(projectRoot, agentId);
  const hasUnread = receivedUnread.length > 0 ? 1 : 0;
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} hasUnread=${hasUnread}, messages=${JSON.stringify(receivedUnread)}`, getEventId());

  const sentUnread = await getSentUnreadMessages(projectRoot, agentId);
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} sentUnread=${sentUnread.length}, messages=${JSON.stringify(sentUnread)}`, getEventId());

  // 旧逻辑（兜底）：窗口内是否发过群聊消息——仅当 task_progress.db 不存在时使用
  const hasSentGroupchat = await checkGroupchatSentInDb(projectRoot, agentId, startedAt, endedAt);
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} hasSentGroupchat=${hasSentGroupchat} (legacy window query, NO-DB fallback only)`, getEventId());

  // 新真相源：task_progress.db 的 T5 完成态。null = 库文件不存在（回退旧逻辑）；否则必用 100 界限
  const dbDone = await getMemberTaskCompletion(projectRoot, agentId);
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} dbDone=${dbDone} (null=no task_progress.db → fallback to legacy sent)`, getEventId());

  // 有状态数据库：必用 100 界限判断完成；无库才回退旧的"是否发消息"代理
  const isCompleted = dbDone === null ? Boolean(hasSentGroupchat) : dbDone;
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} isCompleted=${isCompleted} (computed: dbDone=${dbDone}, legacySent=${hasSentGroupchat})`, getEventId());

  const hasUnreadBool = Boolean(hasUnread);
  const state = mapToBusinessState(isRunning, hasUnreadBool, isCompleted);

  // force-route 等人类手动重评估 pass 不产生 agent 生命周期语义（不阻塞、不 reset）：
  // 仅当允许 t7 时才产出 NEEDS_GROUPCHAT_FEEDBACK；否则降级为 COMPLETED_WITH_GROUPCHAT。
  // 降级落点由 mapper 逻辑可证（t7 前提 !hasUnread，故唯一降级态为 COMPLETED_WITH_GROUPCHAT）。
  // 注意：isCompleted（含 task_progress DB 读）仍必须计算——它同时决定未读态
  // （NEEDS_GROUPCHAT_AND_UNREAD vs HAS_UNREAD_MESSAGES），不可省。
  const finalState = (!allowT7 && state === AgentLifecycleState.NEEDS_GROUPCHAT_FEEDBACK)
    ? AgentLifecycleState.COMPLETED_WITH_GROUPCHAT
    : state;

  const totalTime = Date.now() - calcStartTime;
  debug('message-routing', `calculateTriggerState: ${agentName} -> ${finalState} (allowT7=${allowT7}, unread=${hasUnreadBool}, sent=${hasSentGroupchat}, total=${totalTime}ms)`, getEventId());

  return {
    has_unread: hasUnread,
    has_sent_groupchat: hasSentGroupchat,   // 保留旧值（legacy 代理），门控/日志不变；t7 真实触发改由 state 决定
    state: finalState,
    raw: { running: isRunning, hasUnread: hasUnreadBool, hasSentGroupchat: Boolean(hasSentGroupchat), aborted: cachedRecord?.aborted ?? false },
    receivedUnreadMessages: receivedUnread,
    sentUnreadMessages: sentUnread
  };
}

export async function calculateOtherMemberState(
  projectRoot: string,
  agentId: string,
  agentName: string,
  sessionKey: string
): Promise<CalculationResult> {
  debug('message-routing', `[TRACE] calculateOtherMemberState: ${agentName}(${agentId}) session=${sessionKey}`, getEventId());

  if (!sessionKey) {
    error('message-routing', `calculateOtherMemberState: no sessionKey provided for ${agentName}`, getEventId());
    return {
      has_unread: 0,
      has_sent_groupchat: 0,
      state: AgentLifecycleState.COMPLETED_WITH_GROUPCHAT,
      raw: { running: false, hasUnread: false, hasSentGroupchat: false, aborted: false },
      receivedUnreadMessages: [],
      sentUnreadMessages: []
    };
  }

  const cachedRecord = getSessionRecordBySessionKey(sessionKey);
  const isRunning = cachedRecord ? cachedRecord.status === 'processing' : false;
  const hasSentGroupchat = cachedRecord?.hasSentGroupchat ?? 1;

  debug('message-routing', `[TRACE] calculateOtherMemberState: ${agentName} cache.status=${cachedRecord?.status || 'null'}, isRunning=${isRunning}, hasSentGroupchat=${hasSentGroupchat} (from cache, unused in state calc)`, getEventId());

  if (isRunning) {
    debug('message-routing', `[TRACE] calculateOtherMemberState: ${agentName} is running, returning RUNNING`, getEventId());
    return {
      has_unread: 0,
      has_sent_groupchat: hasSentGroupchat,
      state: AgentLifecycleState.RUNNING,
      raw: { running: true, hasUnread: false, hasSentGroupchat: Boolean(hasSentGroupchat), aborted: cachedRecord?.aborted ?? false },
      receivedUnreadMessages: [],
      sentUnreadMessages: []
    };
  }

  const receivedUnread = await getReceivedUnreadMessages(projectRoot, agentId);
  const hasUnread = receivedUnread.length > 0 ? 1 : 0;
  debug('message-routing', `[TRACE] calculateOtherMemberState: ${agentName} hasUnread=${hasUnread}, messages=${JSON.stringify(receivedUnread)}`, getEventId());

  const hasUnreadBool = Boolean(hasUnread);
  const state = hasUnreadBool
    ? AgentLifecycleState.HAS_UNREAD_MESSAGES
    : AgentLifecycleState.COMPLETED_WITH_GROUPCHAT;

  debug('message-routing', `calculateOtherMemberState: ${agentName} -> ${state} (unread=${hasUnreadBool}, sent=${Boolean(hasSentGroupchat)})`, getEventId());

  return {
    has_unread: hasUnread,
    has_sent_groupchat: hasSentGroupchat,
    state,
    raw: { running: isRunning, hasUnread: hasUnreadBool, hasSentGroupchat: Boolean(hasSentGroupchat), aborted: cachedRecord?.aborted ?? false },
    receivedUnreadMessages: receivedUnread,
    sentUnreadMessages: []
  };
}
