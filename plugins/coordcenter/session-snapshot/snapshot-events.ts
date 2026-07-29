/**
 * session-snapshot SSE 事件总线
 *
 * 管理 SSE 客户端连接池，在 agent 状态变化时推送全量快照。
 * - 每个 SSE 客户端通过 subscribe(fn) 注册，返回 unsubscribe()
 * - transitionToProcessing / transitionToEnded 触发 pushAll()
 */
import { getEventId, debug } from "../shared/logger";
import { getSessionActivityCache } from "../message-routing";
import type { ServerResponse } from "http";

const MODULE = "snapshot-events";

type SnapshotRecord = Record<string, any>;
type SnapshotListener = (snapshots: SnapshotRecord[]) => void;

const listeners = new Set<SnapshotListener>();

/** 构建单个 agent 的快照记录（供 http-route 和 SSE 共用） */
export function buildSnapshotRecord(record: any, opts?: { includeRuns?: boolean }): SnapshotRecord {
  const includeRuns = opts?.includeRuns ?? false;
  return {
    agentId: record.agentId,
    agentName: record.agentName,
    sessionKey: record.sessionKey,
    roundIndex: record.roundIndex ?? 0,
    status: record.status,
    fixable: record.fixable ?? false,
    state: record.state,
    startedAt: record.startedAt ? String(record.startedAt) : null,
    endedAt: record.endedAt ? String(record.endedAt) : null,
    updatedAt: record.updatedAt ? String(record.updatedAt) : null,
    totalTokens: record.totalTokens ?? 0,
    totalToolCalls: record.totalToolCalls ?? 0,
    ...(includeRuns ? { runs: record.runs ?? [] } : {}),
  };
}

/** 构建当前全部 agent 快照列表 */
function buildAllSnapshots(): SnapshotRecord[] {
  const cache = getSessionActivityCache();
  const snapshots: SnapshotRecord[] = [];
  for (const [, record] of cache) {
    snapshots.push(buildSnapshotRecord(record));
  }
  return snapshots;
}

/** 向所有 SSE 客户端推送当前快照 */
export function pushSnapshotEvent(): void {
  if (listeners.size === 0) return;
  const snapshots = buildAllSnapshots();
  debug(MODULE, `push to ${listeners.size} SSE clients, ${snapshots.length} agents`, getEventId());
  for (const fn of listeners) {
    try { fn(snapshots); } catch { /* 客户端已断开，下次 push 前由清理逻辑移除 */ }
  }
}

/** 注册 SSE 推送监听，返回取消函数 */
export function subscribeSnapshot(fn: SnapshotListener): () => void {
  listeners.add(fn);
  debug(MODULE, `SSE client subscribed, total: ${listeners.size}`, getEventId());
  return () => {
    listeners.delete(fn);
    debug(MODULE, `SSE client unsubscribed, total: ${listeners.size}`, getEventId());
  };
}

/** 发送 SSE 初始化快照 + 订阅后续推送 */
export function serveSnapshotSSE(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let id = 0;
  function send(data: SnapshotRecord[]) {
    id++;
    const payload = JSON.stringify(data);
    res.write(`id: ${id}\nevent: snapshot\ndata: ${payload}\n\n`);
  }

  // 立即发送当前快照
  const initial = buildAllSnapshots();
  send(initial);

  // 订阅后续变更
  const unsubscribe = subscribeSnapshot(send);

  // 客户端断开时清理
  res.on("close", () => {
    unsubscribe();
    try { res.end(); } catch {}
  });
}
