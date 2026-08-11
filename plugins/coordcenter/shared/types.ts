export enum AgentLifecycleState {
  RUNNING = 'RUNNING',
  COMPLETED_WITH_GROUPCHAT = 'COMPLETED_WITH_GROUPCHAT',
  NEEDS_GROUPCHAT_FEEDBACK = 'NEEDS_GROUPCHAT_FEEDBACK',
  HAS_UNREAD_MESSAGES = 'HAS_UNREAD_MESSAGES',
  NEEDS_GROUPCHAT_AND_UNREAD = 'NEEDS_GROUPCHAT_AND_UNREAD',
}

export interface AgentDispatchContext {
  agentId: string;
  agentName: string;
  sessionKey: string;
  state: AgentLifecycleState;
  isPM: boolean;
  pmSessionKey?: string;
  teamHasUnread: boolean;
  members: any[];
  teamData: any;
  logger: any;
  chainId?: string;
  isTrigger?: boolean;
  projectRoot?: string;
  aborted?: boolean;
}

export interface DispatchLimiter {
  current: number;
  max: number;
}

export interface AgentActivityRecord {
  agentId: string;
  agentName: string;
  sessionKey: string;
  roundIndex: number;
  status: 'processing' | 'ended' | 'error';
  state: AgentLifecycleState;
  hasUnread: number;
  hasSentGroupchat: number;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  aborted: boolean;
  fixable: boolean;
  completedNormally?: boolean; // 上轮正常完成标记: t7(blocksReset)→false(阻塞); 其余(含processing→skip)→true。容量层节流读取。
  lastRunError?: boolean;
  totalTokens: number;
  totalToolCalls: number;
  runs: RunDetail[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface RunDetail {
  runId: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string | null;
  toolCount: number;
  tokens?: TokenUsage | null;
}

export interface UnreadMessageInfo {
  sender: string;
  recipient: string;
  created_at: string;
  content?: string;
  msg_id?: string;
  read_at?: string;
}

export interface CalculationResult {
  has_unread: number;
  has_sent_groupchat: number;
  state: AgentLifecycleState;
  raw: { running: boolean; hasUnread: boolean; hasSentGroupchat: boolean; aborted: boolean };
  receivedUnreadMessages: UnreadMessageInfo[];
  sentUnreadMessages: UnreadMessageInfo[];
}

export interface CompactionConfig {
  enabled?: boolean;
  msg_count_threshold?: number;
  window_duration_minutes?: number;
  focus_instructions?: string;
}

export function assertNever(value: never): never {
  throw new Error(`未处理的 AgentLifecycleState: ${value}`);
}
