/**
 * 共享类型定义 — 从 server.ts 提取
 */

import type { ServerResponse } from 'node:http';

/** SSE 客户端连接 */
export interface SSEClient {
  response: ServerResponse;
  connectedAt: number;
  lastPing: number;
}
