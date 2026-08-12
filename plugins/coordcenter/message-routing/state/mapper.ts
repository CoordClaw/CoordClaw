import { AgentLifecycleState, assertNever } from "../../shared/types";

export function mapToBusinessState(
  isRunning: boolean,
  hasUnread: boolean,
  isCompleted: boolean
): AgentLifecycleState {
  if (isRunning) {
    return AgentLifecycleState.RUNNING;
  }
  if (!hasUnread && !isCompleted) {
    return AgentLifecycleState.NEEDS_GROUPCHAT_FEEDBACK;
  }
  if (!hasUnread && isCompleted) {
    return AgentLifecycleState.COMPLETED_WITH_GROUPCHAT;
  }
  if (hasUnread && !isCompleted) {
    return AgentLifecycleState.NEEDS_GROUPCHAT_AND_UNREAD;
  }
  if (hasUnread && isCompleted) {
    return AgentLifecycleState.HAS_UNREAD_MESSAGES;
  }
  return assertNever({ isRunning, hasUnread, isCompleted } as never);
}
