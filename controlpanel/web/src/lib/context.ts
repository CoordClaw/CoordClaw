/**
 * AppContext — 统一共享上下文
 * 所有 handler 通过 ctx 访问共享状态，替代 this.xxx
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FSWatcher } from 'node:fs';
import type { MessageDatabase } from '../database.js';

export interface SSEClient {
  response: ServerResponse;
  connectedAt: number;
  lastPing: number;
}

export interface TeamMonitorState {
  interval: ReturnType<typeof setInterval> | null;
  teamPath: string;
}

export interface AppConfig {
  port: number;
  corsOrigin: string;
  projectRoot: string;
  currentUser: string;
  currentUserId?: string;
  projectId?: string;
  projectName?: string;
  teamName?: string;
  teamId?: string;
  members?: Array<{ name: string; agent_id: string; role?: string; role_type?: string; role_label?: string; sessionKey?: string }>;
  humanMember?: Array<{ name?: string; human_id?: string; enabled?: boolean; role?: string; role_type?: string }> | null;
  msgRobot?: boolean | { enabled: boolean };
  autoCoordination?: boolean;
  databasePath?: string;
  language?: string;       // 'zh' | 'en' 等，来自 coordclaw.json
  version?: string;        // 版本号，来自 package.json（控制面板构建版本）
}

export interface RequestStats {
  totalRequests: number;
  apiRequests: number;
  sseConnections: number;
  startTime: Date | null;
}

export interface AppContext {
  db: MessageDatabase;
  config: AppConfig;
  sseClients: Set<SSEClient>;
  stats: RequestStats;
  teamJsonWatcher: FSWatcher | null;
  teamMonitor: TeamMonitorState;
  memberStatusAbort: AbortController | null;

  /** 发送 JSON 响应 */
  sendJSON: (res: ServerResponse, code: number, data: any) => void;
  /** 广播 SSE 事件 */
  broadcastSSE: (event: string, data: any) => void;
  /** 关闭所有 SSE 连接 */
  closeAllSSEConnections: () => void;
  /** 项目切换时关闭 SSE */
  closeAllSSEConnectionsForSwitch: () => void;
  /** 重启 team.json 文件监听 */
  restartTeamJsonWatcher: () => void;
  /** 确保成员状态流 */
  ensureMemberStatusStream: () => void;
  /** 强制刷新配置 */
  refreshConfig: () => void;
  /** 项目切换：DB 重连 + 广播 project_switched */
  notifyProjectSwitched: () => void;
  /** 重启 Gateway */
  restartGateway: (mode: 'soft' | 'hard') => Promise<{ success: boolean; message: string }>;

  /** 成员 ID 解析 */
  resolveMemberId: (name: string) => string;
  resolveSenderId: (name: string) => string;
}
