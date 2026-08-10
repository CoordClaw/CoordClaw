import { getEventId, error } from "../shared/logger";
import { writeSnapshotFile } from "../session-snapshot/persistence";
import { isCheckEnabled } from "../shared/message-picker";
import { shouldDispatchNotification, recordDispatch } from "./dispatcher/rate-limiter";
import {
  sendTaskCompletionSignal,
  sendT7Notification,
  sendUnreadOnlyReminder,
  sendUnreadReminder,
  sendAbortNotification,
  maybeCompactBeforeDispatch,
} from "../shared/http-client";
import { AgentLifecycleState, AgentDispatchContext } from "../shared/types";
import {
  loadProjectTeamJson,
  resolveProjectRoot,
} from "../prompt-injection";
import { getConfig, incrementMsgReminderCount } from "./internal-state";
import { getSessionRecordBySessionKey } from "./cache/manager";
import { setStatusAndTime } from './transition';

export function getMemberByAgentId(members: any[], agentId: string) {
  return members.find((m: any) => m.agent_id === agentId);
}

export function isMember(members: any[], agentId: string): boolean {
  return members.some((m: any) => m.agent_id === agentId);
}

export function isPM(members: any[], agentId: string): boolean {
  const firstMember = members[0];
  return Boolean(firstMember && agentId === firstMember.agent_id);
}

// loadTeamData 短期缓存：同一轮路由中避免重复读取文件（修复 10.4-10.6 重复调用）
let _cachedLoadTeamResult: { projectRoot: string; teamData: any } | null = null;
let _cachedLoadTeamTime = 0;
const LOAD_TEAM_CACHE_MS = 500;

export async function loadTeamData() {
  const now = Date.now();
  if (_cachedLoadTeamResult && (now - _cachedLoadTeamTime) < LOAD_TEAM_CACHE_MS) {
    return _cachedLoadTeamResult;
  }
  const cfg = getConfig();
  const projectRoot = await resolveProjectRoot(cfg.jsonPath, cfg.cacheTtl);
  const teamData = await loadProjectTeamJson(projectRoot, cfg.cacheTtl) as any;
  _cachedLoadTeamResult = { projectRoot, teamData };
  _cachedLoadTeamTime = now;
  return _cachedLoadTeamResult;
}

export type DispatchActionType = 'msg1' | 'msg2' | 't7' | 'msg5' | 'skip';

// t7 方法输出契约：blocksReset 由 t7 方法在源头声明（NEEDS_GROUPCHAT_FEEDBACK 非 PM 分支 与 NEEDS_GROUPCHAT_AND_UNREAD(t7) 均为 true），
// 门控 needsT7ResetGate 只读此语义标志，永不匹配 't7' 字符串，使 t7 可自由增删机制/改名而不动门控。
export interface DispatchAction {
  type: DispatchActionType;
  label: string;
  blocksReset?: boolean;
}

export function buildDispatchAction(
  ctxObj: AgentDispatchContext,
  teamTaskCompleted: boolean
): DispatchAction {
  // 预留机制: abort 通知(msg5) —— 仅被 abort 的 trigger 自身处理, 避免旁观 pass 混入他人 abort 导致重复/错上下文。
  if (ctxObj.aborted && ctxObj.isTrigger) {
    if (!isCheckEnabled(ctxObj.teamData, 'checkdeadlockstatus')) {
      return { type: 'skip', label: '跳过(checkdeadlockstatus已关闭)' };
    }
    return { type: 'msg5', label: '发送msg5(abort通知)' };
  }

  const { state, isPM, teamHasUnread } = ctxObj;
  const hasUnread = teamHasUnread ?? false;

  switch (state) {
    case AgentLifecycleState.RUNNING:
      return { type: 'skip', label: '跳过(运行中)' };

    case AgentLifecycleState.COMPLETED_WITH_GROUPCHAT:
      return { type: 'skip', label: '跳过(正常完成)' };

    case AgentLifecycleState.NEEDS_GROUPCHAT_FEEDBACK:
      if (isPM) {
        if (!isCheckEnabled(ctxObj.teamData, 'checktaskstatus')) {
          return { type: 'skip', label: '跳过(checktaskstatus已关闭)' };
        }
        if (hasUnread) return { type: 'skip', label: '跳过(团队有未读消息，不发msg2)' };
        if (teamTaskCompleted) return { type: 'skip', label: '跳过(团队任务已完成)' };
        return { type: 'msg2', label: '发送msg2(任务完成)' };
      }
      if (!isCheckEnabled(ctxObj.teamData, 'checktaskfeedback')) {
        return { type: 'skip', label: '跳过(checktaskfeedback已关闭)' };
      }
      return { type: 't7', label: '发送T7通知(查询群聊结果)', blocksReset: true };

    case AgentLifecycleState.HAS_UNREAD_MESSAGES:
      if (!isCheckEnabled(ctxObj.teamData, 'checkunread')) {
        return { type: 'skip', label: '跳过(checkunread已关闭)' };
      }
      return { type: 'msg1', label: '发送msg1(未读提醒)' };

    case AgentLifecycleState.NEEDS_GROUPCHAT_AND_UNREAD:
      // t7 优先（提醒处理完上轮群聊任务）；t7 关闭后降级为 msg1（未读提醒）。
      // 全员统一（PM 与非 PM 同规则），去掉原 PM 硬编码 msg1 的特例。
      // 不进 state-machine 的 T7→T1 兜底链（该态本就存在未读，兜底链的 deleted>0 守卫会导致静默 skip）。
      if (isCheckEnabled(ctxObj.teamData, 'checktaskfeedback')) {
        return { type: 't7', label: '发送T7通知(查询群聊结果)', blocksReset: true };  // 复用 :97 同源 t7 声明
      }
      if (!isCheckEnabled(ctxObj.teamData, 'checkunread')) {
        return { type: 'skip', label: '跳过(checkunread已关闭)' };
      }
      return { type: 'msg1', label: '有群聊+未读 → 发送msg1(未读提醒)' };

    default:
      return { type: 'skip', label: '跳过(未知状态)' };
  }
}

export function markTargetProcessing(sessionKey: string): void {
  const targetRecord = getSessionRecordBySessionKey(sessionKey);
  if (!targetRecord) {
    error("message-routing", "markTargetProcessing: session record not found for sessionKey: " + sessionKey);
    return;
  }
  setStatusAndTime(targetRecord, 'processing');
  targetRecord.fixable = false;
  targetRecord.updatedAt = new Date().toISOString();

  writeSnapshotFile(sessionKey);
}

export async function executeDispatchAction(
  action: { type: 'msg1' | 'msg2' | 't7' | 'msg5' },
  ctxObj: AgentDispatchContext
): Promise<void> {
  if (!shouldDispatchNotification()) {
    throw new Error('circuit breaker tripped');
  }

  await maybeCompactBeforeDispatch(ctxObj.sessionKey, ctxObj.logger);

  switch (action.type) {
    case 'msg1': {
      if (ctxObj.state === AgentLifecycleState.NEEDS_GROUPCHAT_AND_UNREAD && !ctxObj.isPM) {
        await sendUnreadReminder(ctxObj);
      } else {
        await sendUnreadOnlyReminder(ctxObj);
      }
      break;
    }
    case 'msg2':
      await sendTaskCompletionSignal(ctxObj);
      break;
    case 't7':
      await sendT7Notification(ctxObj);
      break;
    case 'msg5':
      await sendAbortNotification(ctxObj);
      break;
  }

  incrementMsgReminderCount(ctxObj.sessionKey);
  recordDispatch();
}