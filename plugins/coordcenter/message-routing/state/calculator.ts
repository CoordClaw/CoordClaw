import { debug, error, getEventId } from "../../shared/logger";
import { getSessionRecordBySessionKey } from "../cache/manager";
import { AgentLifecycleState, CalculationResult } from "../../shared/types";
import { mapToBusinessState } from "./mapper";
import { checkGroupchatSentInDb, getReceivedUnreadMessages, getSentUnreadMessages } from "../database/manager";

export async function calculateTriggerState(
  projectRoot: string,
  agentId: string,
  agentName: string,
  startedAt: string,
  endedAt: string,
  sessionKey: string
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

  const hasSentGroupchat = await checkGroupchatSentInDb(projectRoot, agentId, startedAt, endedAt);
  debug('message-routing', `[TRACE] calculateTriggerState: ${agentName} hasSentGroupchat=${hasSentGroupchat} (window query)`, getEventId());

  const hasUnreadBool = Boolean(hasUnread);
  const hasSentGroupchatBool = Boolean(hasSentGroupchat);
  const state = mapToBusinessState(isRunning, hasUnreadBool, hasSentGroupchatBool);

  const totalTime = Date.now() - calcStartTime;
  debug('message-routing', `calculateTriggerState: ${agentName} -> ${state} (unread=${hasUnreadBool}, sent=${hasSentGroupchatBool}, total=${totalTime}ms)`, getEventId());

  return {
    has_unread: hasUnread,
    has_sent_groupchat: hasSentGroupchat,
    state,
    raw: { running: isRunning, hasUnread: hasUnreadBool, hasSentGroupchat: hasSentGroupchatBool, aborted: cachedRecord?.aborted ?? false },
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
