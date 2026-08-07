// re-exports from sub-modules
export { shouldDispatchNotification, recordDispatch } from "./dispatcher/rate-limiter";
export {
  checkGroupchatSentInDb,
  getReceivedUnreadMessages,
  getSentUnreadMessages,
  getRecentReadRecords
} from "./database/manager";
export {
  getSessionActivityCache,
  initAgentActivityCache,
  getAgentStateVector,
  getActiveSessions,
  getSessionRecordBySessionKey,
  getRecordByAgentId,
  ensureCacheEntry,
  updateSessionRecord,
} from "./cache/manager";
export { mapToBusinessState } from "./state/mapper";
export {
  calculateTriggerState,
  calculateOtherMemberState
} from "./state/calculator";

// internal-state exports
export {
  setConfig,
  getConfig,
  clearAllCaches,
  getDatabase,
  closeDatabase,
  refreshDatabase,
  getTeamTaskCompleted,
  setTeamTaskCompleted,
  getCompactionConfig,
  setCompactionConfig,
  getMsgReminderCount,
  incrementMsgReminderCount,
  resetMsgReminderCount,
  getLastCompactionTime,
  setLastCompactionTime,
  globalLlmState,
} from "./internal-state";

// state-machine exports
export { transitionToProcessing, transitionToEnded, executeMessageRouting } from "./state-machine";

// signal handlers
export {
  onPromptBuild,
  onAgentEnd,
  onSessionIdle,
} from "./signals";

// session queue tracker
export { getSessionQueueTracker } from "./session-queue-tracker";

// dispatch
export { buildDispatchAction, markTargetProcessing, executeDispatchAction, isMember, isPM, getMemberByAgentId, loadTeamData } from "./dispatch";

// initialization
import { info, getEventId } from "../shared/logger";
import { loadProjectTeamJson } from "../prompt-injection";
import { initAgentActivityCache } from "./cache/manager";

export async function initAgentActivity(projectRoot: string): Promise<void> {
  const team = await loadProjectTeamJson(projectRoot, 5000);
  if (!team?.members?.length) {
    info('message-routing', `[INIT] team.json empty, skipping agent activity init`, getEventId());
    return;
  }
  await initAgentActivityCache(team.members);
  info('message-routing', `[INIT] agent activity cache initialized: ${team.members.length} agents`, getEventId());
}