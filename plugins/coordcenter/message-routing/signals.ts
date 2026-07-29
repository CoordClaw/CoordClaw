import { getEventId, debug, info, warn } from "../shared/logger";
import { resetSessionToolCount, getSessionToolCount, sendMsg6 } from "../index";
import {
  getOrCreateSignals,
  SessionState,
  getTeamTaskCompleted,
} from "./internal-state";
import { transitionToProcessing, transitionToEnded } from "./state-machine";
import { getSessionActivityCache } from "./cache/manager";
import { getSessionQueueTracker } from "./session-queue-tracker";
import { writeSnapshotFile } from "../session-snapshot/persistence";

// ==================== 状态转换引擎 ====================
export function transition(
  currentState: SessionState,
  event: string,
): SessionState {
  switch (currentState) {
    case SessionState.IDLE:
      if (event === 'prompt_build') return SessionState.ACTIVE;
      return currentState;

    case SessionState.ACTIVE:
      if (event === 'agent_end_final') return SessionState.COMPLETED;
      return currentState;

    case SessionState.COMPLETED:
      return currentState;

    default:
      return currentState;
  }
}

// ==================== 事件处理器 ====================
export async function onPromptBuild(sessionKey: string, agentId: string, runId?: string): Promise<void> {
  if (!sessionKey) return;
  const sig = getOrCreateSignals(sessionKey);
  const prevState = sig.state;
  const newState = transition(prevState, 'prompt_build');
  sig.state = newState;

  if (prevState !== newState) {
    info('message-routing', `[SESSION] ${sessionKey} state ${prevState} → ${newState} (event=prompt_build runId=${runId || '-'})`, getEventId());
  }
  await transitionToProcessing(sessionKey, agentId, 'before_prompt_build', runId);
  // 翻牌：agent 已真实启动，health_poll 可修复
  const cache = getSessionActivityCache();
  const rec = cache.get(sessionKey);
  if (rec) rec.fixable = true;
  writeSnapshotFile(sessionKey);
}

export async function onAgentEnd(sessionKey: string, agentId: string, trigger?: string, runId?: string): Promise<void> {
  if (!sessionKey) return;
  const sig = getOrCreateSignals(sessionKey);
  const prevState = sig.state;
  const newState = transition(prevState, 'agent_end_final');
  sig.state = newState;

  if (prevState !== newState) {
    debug('message-routing', `[SESSION] ${sessionKey} state ${prevState} → ${newState} (event=agent_end trigger=${trigger || '-'} runId=${runId || '-'})`, getEventId());
  }

  writeSnapshotFile(sessionKey);
}

export async function onSessionIdle(sessionKey: string, agentId: string, endedAt?: number): Promise<void> {
  if (!sessionKey) return;

  try {
    info('message-routing', `[SESSION-IDLE] enter | sessionKey=${sessionKey} agentId=${agentId} endedAt=${endedAt ?? '-'}`, getEventId());

    const sessionToolCount = getSessionToolCount(sessionKey);
    const hasUserRun = getSessionQueueTracker().hasUserRun(sessionKey);

    if (hasUserRun && sessionToolCount === 0 && !getTeamTaskCompleted()) {
      try {
        await sendMsg6(sessionKey, agentId);
        info('message-routing', `[MSG6] sent on session idle | agent=${agentId} hasUserRun=true sessionToolCount=0`, getEventId());
      } catch (err: any) {
        info('message-routing', `[MSG6] send failed on session idle: ${err.message}`, getEventId());
      }
    } else {
      debug('message-routing', `[MSG6] skip on session idle | agent=${agentId} hasUserRun=${hasUserRun} sessionToolCount=${sessionToolCount} teamTaskCompleted=${getTeamTaskCompleted()}`, getEventId());
    }

    resetSessionToolCount(sessionKey);
    await transitionToEnded(sessionKey, agentId, 'session_idle', undefined, endedAt);
    writeSnapshotFile(sessionKey);
    getSessionQueueTracker().clearSession(sessionKey);
  } catch (err: any) {
    warn('message-routing', `[SESSION-IDLE] error: ${err.message} | sessionKey=${sessionKey} agentId=${agentId}`, getEventId());
  }
}