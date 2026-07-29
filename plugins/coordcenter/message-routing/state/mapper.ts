import { AgentLifecycleState, assertNever } from "../../shared/types";

export function mapToBusinessState(
  isRunning: boolean,
  hasUnread: boolean,
  hasSentGroupchat: boolean
): AgentLifecycleState {
  if (isRunning) {
    return AgentLifecycleState.RUNNING;
  }
  if (!hasUnread && !hasSentGroupchat) {
    return AgentLifecycleState.NEEDS_GROUPCHAT_FEEDBACK;
  }
  if (!hasUnread && hasSentGroupchat) {
    return AgentLifecycleState.COMPLETED_WITH_GROUPCHAT;
  }
  if (hasUnread && !hasSentGroupchat) {
    return AgentLifecycleState.NEEDS_GROUPCHAT_AND_UNREAD;
  }
  if (hasUnread && hasSentGroupchat) {
    return AgentLifecycleState.HAS_UNREAD_MESSAGES;
  }
  return assertNever({ isRunning, hasUnread, hasSentGroupchat } as never);
}
