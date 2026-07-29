/**
 * 跨平台文件/目录监视器（零依赖，纯 Node fs）。
 *
 * 设计要点（与 sse.ts / server.ts 现有 watch 模式一致，抽出复用）：
 *  - 优先 fs.watch（Windows / macOS / Linux 原生支持）。
 *  - 目录监听时按文件名过滤（文件可能尚未创建，故监听父目录）。
 *  - mtime 去重，避免同一变更触发多次。
 *  - 可选轮询兜底（默认 30s），应对 fs.watch 在部分环境 / 网络盘不触发的情况。
 *
 * 复用点：token-stats 模块及后续任意文件监听需求均可直接实例化本类。
 */
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileWatcherOptions {
  /** 防抖窗口（ms），合并连续事件，默认 300 */
  debounceMs?: number;
  /** 轮询兜底间隔（ms），0 表示关闭，默认 30000 */
  pollFallbackMs?: number;
  /** 若监听目录，仅当变更子文件名匹配时才触发（不含路径） */
  filterFilename?: string;
}

export class FileWatcher {
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMtimeMs = 0;
  private stopped = false;

  constructor(
    private readonly targetPath: string,
    private readonly handler: () => void,
    private readonly opts: FileWatcherOptions = {},
  ) {}

  /** 启动监听（fs.watch + 可选轮询兜底） */
  start(): void {
    this.stopped = false;
    this.tryFsWatch();
    const poll = this.opts.pollFallbackMs ?? 30000;
    if (poll > 0) {
      this.pollTimer = setInterval(() => void this.poll(), poll);
      void this.poll(); // 立即校一次，捕获 watch 未触发的期间变更
    }
  }

  /** 停止并释放所有资源 */
  stop(): void {
    this.stopped = true;
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch { /* noop */ }
      this.fsWatcher = null;
    }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  /** 尝试建立 fs.watch；目标不存在或失败则交由轮询兜底 */
  private tryFsWatch(): void {
    if (this.fsWatcher || this.stopped) return;
    try {
      this.fsWatcher = watch(this.targetPath, (eventType, filename) => {
        if (this.opts.filterFilename) {
          if (!filename || filename !== this.opts.filterFilename) return;
        }
        this.fire();
      });
      this.fsWatcher.on('error', () => {
        // 目录/文件被删除或不可访问：关闭，交由轮询重试
        try { this.fsWatcher?.close(); } catch { /* noop */ }
        this.fsWatcher = null;
      });
    } catch {
      // 目标尚不存在，留给轮询兜底
      this.fsWatcher = null;
    }
  }

  /** 轮询兜底：探测实际文件 mtime（过滤文件名时探测该子文件，而非目录） */
  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (!this.fsWatcher) this.tryFsWatch(); // 目标已出现则重建 watch
    const probe = this.opts.filterFilename
      ? join(this.targetPath, this.opts.filterFilename)
      : this.targetPath;
    try {
      const st = await stat(probe);
      const m = st.mtimeMs;
      if (m !== this.lastMtimeMs) {
        this.lastMtimeMs = m;
        this.fire();
      }
    } catch {
      // 文件/目录不存在：重置 mtime，等待创建
      this.lastMtimeMs = 0;
    }
  }

  /** 防抖后执行回调 */
  private fire(): void {
    if (this.stopped) return;
    const d = this.opts.debounceMs ?? 300;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.handler();
    }, d);
  }
}
