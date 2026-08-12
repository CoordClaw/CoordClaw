import fs from "fs";
import { debug, info, error, getEventId } from "../shared/logger";
import { CompactionConfig } from "../shared/types";
import { getSessionActivityCache } from "./cache/manager";
import { DatabaseSync } from "node:sqlite";  // F4: 静态导入，依赖 Node≥22（package.json engines 已强制）
import { getCoordClawDbPath, getTaskProgressDbPath } from "../shared/paths";

export const DEFAULT_LIFECYCLE_END_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_LANE_DRAINED_TIMEOUT_MS = 5_000;

export function parseNumberConfig(value: any, defaultValue: number): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

// ==================== 信号状态 ====================
export enum SessionState {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
}

export interface SessionSignalState {
  state: SessionState;
  routingTimer: ReturnType<typeof setTimeout> | null;
  scavengerTimer: ReturnType<typeof setTimeout> | null;
}

export const sessionSignals = new Map<string, SessionSignalState>();

export function getOrCreateSignals(sessionKey: string): SessionSignalState {
  let sig = sessionSignals.get(sessionKey);
  if (!sig) {
    sig = { state: SessionState.IDLE, routingTimer: null, scavengerTimer: null };
    sessionSignals.set(sessionKey, sig);
  }
  return sig;
}

export function clearSignals(sessionKey: string): void {
  const sig = sessionSignals.get(sessionKey);
  if (sig) {
    if (sig.routingTimer) clearTimeout(sig.routingTimer);
    if (sig.scavengerTimer) clearTimeout(sig.scavengerTimer);
    sessionSignals.delete(sessionKey);
  }
}

// ==================== 内部状态 ====================
export const sessionActivityCache = getSessionActivityCache();
export let cachedConfig: { jsonPath: string; cacheTtl: number; stateDir: string } | null = null;
let dbInstances = new Map<string, DatabaseSync>();

// ==================== 团队任务完成标记（跨路由持久化） ====================
let _teamTaskCompleted = false;

export function getTeamTaskCompleted(): boolean {
  return _teamTaskCompleted;
}

export function setTeamTaskCompleted(value: boolean): void {
  _teamTaskCompleted = value;
}

// ==================== 配置 ====================
export function setConfig(jsonPath: string, cacheTtl: number, stateDir?: string) {
  cachedConfig = { jsonPath, cacheTtl, stateDir: stateDir || '' };
}

export function getConfig() {
  if (!cachedConfig) throw new Error('Config not initialized');
  return cachedConfig;
}

// ==================== 缓存清除 ====================
export function clearAllCaches(): { sessionSignals: number; sessionActivityCache: number } {
  const sessionSignalsSize = sessionSignals.size;
  const sessionActivityCacheSize = sessionActivityCache.size;

  sessionSignals.clear();
  sessionActivityCache.clear();
  msgReminderCount.clear();
  lastCompactionTime.clear();
  _teamTaskCompleted = false;
  closeDatabase();

  return { sessionSignals: sessionSignalsSize, sessionActivityCache: sessionActivityCacheSize };
}

/**
 * 重建缓存时清理附属的 signal 和 compaction 状态
 * （不清除 sessionActivityCache 本体，由调用方负责）
 */
export function clearAncillaryState(): void {
  sessionSignals.clear();
  msgReminderCount.clear();
  lastCompactionTime.clear();
}

// ==================== 初始化 ====================
export function getDatabase(projectRoot: string): DatabaseSync {
  const dbPath = getCoordClawDbPath(projectRoot);
  const existing = dbInstances.get(dbPath);
  if (existing) return existing;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  dbInstances.set(dbPath, db);
  info('message-routing', `[INIT] database connected via node:sqlite: ${dbPath}`, getEventId());
  return db;
}

export function closeDatabase(): void {
  for (const [dbPath, db] of dbInstances) {
    db.close();
    info('message-routing', `[INIT] database connection closed: ${dbPath}`, getEventId());
  }
  dbInstances.clear();
}

export function refreshDatabase(projectRoot: string): void {
  const dbPath = getCoordClawDbPath(projectRoot);
  const existing = dbInstances.get(dbPath);
  if (existing) {
    existing.close();
    dbInstances.delete(dbPath);
    debug('message-routing', `[DB] connection refreshed for WAL snapshot: ${dbPath}`, getEventId());
  }
}

/**
 * 获取 task_progress.db 的只读连接（复用 dbInstances 缓存，与 coordclaw.db 按路径隔离）。
 * 库文件不存在时返回 null —— 这是唯一允许上层回退旧逻辑（"是否发消息"代理）的信号。
 * 库存在则以只读方式打开并缓存（PRAGMA WAL + busy_timeout 与 getDatabase 一致）。
 *
 * 注意：返回 null 仅代表"文件缺失"，绝不代表"未完成"；完成判定由 manager.getMemberTaskCompletion
 * 在库存在时按 task_progress === 100 严格判断，读错/无记录一律保守为 false（不回退旧逻辑）。
 */
export function getTaskProgressDatabase(projectRoot: string): DatabaseSync | null {
  const dbPath = getTaskProgressDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return null;
  const existing = dbInstances.get(dbPath);
  if (existing) return existing;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  dbInstances.set(dbPath, db);
  info('message-routing', `[INIT] task_progress database connected (readOnly) via node:sqlite: ${dbPath}`, getEventId());
  return db;
}

// ==================== 全局 LLM 错误阻断 ====================

/** 全局状态对象：health poll 救活 / lifecycle.error / model_call_ended error 任意来源可设 */
export const globalLlmState = { error: false, rescueCount: 0 };

// ==================== 链式ID ====================
export let chainIdCounter = 0;
export function generateChainId(): string {
  return `链-${Date.now()}-${++chainIdCounter}`;
}

// ==================== 压缩追踪 ====================
const msgReminderCount = new Map<string, number>();
const lastCompactionTime = new Map<string, number>();
let compactionConfig: CompactionConfig | undefined;

export function getCompactionConfig(): CompactionConfig | undefined {
  return compactionConfig;
}

export function setCompactionConfig(config: CompactionConfig | undefined): void {
  compactionConfig = config;
}

export function getMsgReminderCount(sessionKey: string): number {
  return msgReminderCount.get(sessionKey) || 0;
}

export function incrementMsgReminderCount(sessionKey: string): void {
  msgReminderCount.set(sessionKey, getMsgReminderCount(sessionKey) + 1);
}

export function resetMsgReminderCount(sessionKey: string): void {
  msgReminderCount.set(sessionKey, 0);
}

export function getLastCompactionTime(sessionKey: string): number {
  return lastCompactionTime.get(sessionKey) || 0;
}

export function setLastCompactionTime(sessionKey: string, time: number): void {
  lastCompactionTime.set(sessionKey, time);
}

export function resetLastCompactionTime(sessionKey: string): void {
  lastCompactionTime.delete(sessionKey);
}

// ==================== 工具函数 ====================
export function extractAgentIdFromKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length >= 2 && parts[0] === 'agent') return parts[1];
  return null;
}