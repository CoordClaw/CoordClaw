/**
 * 数据库变更监测器（中心化）
 *
 * 职责单一：检测"数据库被改动"并中性扇出通知，供各业务模块订阅。
 *   - 备份模块订阅 → 执行在线备份
 *   - 消息同步模块订阅 → 重读并推送 SSE
 *
 * 检测机制（事件驱动为主，低频轮询兜底，无高频轮询）：
 *   ① 主通道：目录级 fs.watch（捕获 db / -wal / -shm 的改动，忽略 .backup 等）
 *   ② 兜底：低频轮询 PRAGMA data_version（仅当目录 watch 在 Windows 上静默失效时起作用）
 *
 * 设计要点：
 *   - 不监视"单文件"、不过滤 rename 事件，避免旧方案 rename 孤儿化/漏事件。
 *   - 备份写出的 .backup / .backup-journal 会被目录 watch 触发，但文件名过滤直接忽略，
 *     且 backup() 不改主库 data_version，确认门也判"未变"，双闸防自触发死循环。
 *   - 跟随 reconnect：轮询时若 db 路径变化，自动重建目录 watch 并重置 baseline。
 *   - 扇出逐个 try/catch 隔离，单个 listener 抛错不影响其他。
 */

import { watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';

export type MonitorListener = () => void | Promise<void>;

/** 监测器对数据库的最小依赖（解耦，避免循环引用） */
export interface MonitorDb {
  getDbPath(): string;
  /** 返回当前 data_version；不可用时返回 null */
  getDataVersion(): number | null;
}

export class DatabaseChangeMonitor {
  private listeners = new Set<MonitorListener>();
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private baseline: number | null = null;
  private watchedDir: string | null = null;
  private running = false;

  private readonly db: MonitorDb;
  private readonly pollIntervalMs: number;
  private readonly debounceMs: number;

  constructor(db: MonitorDb, opts: { pollIntervalMs?: number; debounceMs?: number } = {}) {
    this.db = db;
    this.pollIntervalMs = opts.pollIntervalMs ?? 45_000;
    this.debounceMs = opts.debounceMs ?? 300;
  }

  /** 订阅变更信号，返回取消订阅函数 */
  subscribe(listener: MonitorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 控制面板自身写入后即时调用（零轮询） */
  notifyChanged(): void {
    this.scheduleFanout();
  }

  /** 启动监测（幂等） */
  start(): void {
    if (this.running) {
      this.resetBaseline();
      return;
    }
    this.running = true;
    this.resetBaseline();
    this.setupWatch();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    console.log('[Monitor] 📡 DB change monitor started (dir watch + low-freq poll fallback)');
  }

  stop(): void {
    this.running = false;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.baseline = null;
    this.watchedDir = null;
  }

  private getDir(): string {
    return dirname(this.db.getDbPath());
  }

  private getBase(): string {
    return basename(this.db.getDbPath());
  }

  private setupWatch(): void {
    let dir: string;
    try {
      dir = this.getDir();
    } catch {
      return;
    }
    this.watchedDir = dir;
    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (!filename || !this.running) return;
        const base = this.getBase();
        const isDbRelated =
          filename === base ||
          filename === base + '-wal' ||
          filename === base + '-shm';
        // 忽略 .backup / .backup-journal 等，避免备份自身触发再备份
        if (!isDbRelated) return;
        this.scheduleFanout();
      });
      this.watcher.on('error', () => {
        // 目录 watch 出错时静默忽略，靠低频轮询兜底
        this.watcher = null;
      });
    } catch (e: any) {
      console.warn('[Monitor] ⚠️ Dir watch startup failed, relying on poll fallback only:', e?.message || e);
      this.watcher = null;
    }
  }

  private resetBaseline(): void {
    this.baseline = this.db.getDataVersion();
  }

  private poll(): void {
    if (!this.running) return;

    // 跟随 reconnect：db 路径变化则重建目录 watch 并重置 baseline
    let dir: string;
    try {
      dir = this.getDir();
    } catch {
      return;
    }
    if (dir !== this.watchedDir) {
      if (this.watcher) {
        try { this.watcher.close(); } catch { /* ignore */ }
        this.watcher = null;
      }
      this.setupWatch();
      this.resetBaseline();
      return;
    }

    const cur = this.db.getDataVersion();
    if (this.baseline === null) {
      this.baseline = cur;
      return;
    }
    if (cur !== null && cur !== this.baseline) {
      this.baseline = cur;
      this.scheduleFanout();
    }
  }

  private scheduleFanout(): void {
    if (!this.running) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.fanout();
    }, this.debounceMs);
  }

  private async fanout(): Promise<void> {
    for (const listener of Array.from(this.listeners)) {
      try {
        await listener();
      } catch (e: any) {
        console.error('[Monitor] ⚠️ listener execution failed:', e?.message || e);
      }
    }
  }
}
