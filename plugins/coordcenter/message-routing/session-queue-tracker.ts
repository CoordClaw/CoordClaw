import { info, debug, warn, getEventId } from "../shared/logger";

const MODULE = "session-queue";

const LANE_DRAIN_POLL_MS = 50;
const LANE_DRAIN_STABLE_CHECKS = 3;
const DEFAULT_LANE_DRAINED_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SessionState {
  hasUserRun: boolean;
  draining: boolean;
}

class SessionQueueTracker {
  private sessions = new Map<string, SessionState>();
  private trackedSessionKeys = new Set<string>();
  private _initialized = false;
  private onIdleCallback: ((sessionKey: string, agentId: string, endedAt?: number) => void) | null = null;
  private idleConfirmMs: number = 3000;

  setOnIdle(callback: (sessionKey: string, agentId: string, endedAt?: number) => void): void {
    this.onIdleCallback = callback;
  }

  setTrackedSessionKeys(keys: string[]): void {
    this.trackedSessionKeys = new Set(keys.filter((k) => k && k.length > 0));
    this._initialized = true;

    if (this.trackedSessionKeys.size > 0) {
      info(MODULE, `[TRACK] ${this.trackedSessionKeys.size} sessionKey(s) loaded`, getEventId());
    } else {
      info(MODULE, `[TRACK] no team sessionKeys, tracking ALL sessions`, getEventId());
    }
  }

  /** 获取当前追踪的所有 sessionKey（供外部切换项目时修复状态用） */
  getTrackedKeys(): string[] {
    return Array.from(this.trackedSessionKeys);
  }

  setIdleConfirmMs(ms: number): void {
    this.idleConfirmMs = Math.max(0, Math.floor(ms));
    info(MODULE, `[CONFIRM] idle confirm window set to ${this.idleConfirmMs}ms`, getEventId());
  }

  getIdleConfirmMs(): number {
    return this.idleConfirmMs;
  }

  isTracked(sessionKey: string): boolean {
    if (!this._initialized) return false;
    if (this.trackedSessionKeys.size === 0) return true;
    return this.trackedSessionKeys.has(sessionKey);
  }

  private ensureSession(sessionKey: string): SessionState {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = { hasUserRun: false, draining: false };
      this.sessions.set(sessionKey, s);
    }
    return s;
  }

  private extractAgentId(sessionKey: string): string {
    const parts = sessionKey.split(":");
    if (parts.length >= 2 && parts[0] === "agent") return parts[1];
    return sessionKey;
  }

  onAgentEnd(sessionKey: string, agentId: string, runId: string, trigger?: string): void {
    if (!sessionKey) return;
    if (!this.isTracked(sessionKey)) return;

    const s = this.ensureSession(sessionKey);
    if (trigger === "user") {
      s.hasUserRun = true;
    }

    debug(
      MODULE,
      `[AGENT-END] sessionKey=${sessionKey.slice(-32)} runId=${String(runId).slice(0, 8)} trigger=${trigger || "-"}`,
      getEventId()
    );

    this.startDrainIfNeeded(sessionKey, agentId);
  }

  private startDrainIfNeeded(sessionKey: string, agentId: string): void {
    const s = this.sessions.get(sessionKey);
    if (!s || s.draining) return;
    s.draining = true;

    info(
      MODULE,
      `[DRAIN-START] sessionKey=${sessionKey.slice(-32)} agentId=${agentId} quietWindow=${this.idleConfirmMs}ms`,
      getEventId()
    );

    this.drainAndNotify(sessionKey, agentId).finally(() => {
      const ss = this.sessions.get(sessionKey);
      if (ss) ss.draining = false;
    });
  }

  private async drainAndNotify(sessionKey: string, agentId: string): Promise<void> {
    const drainResult = await this.waitForLaneDrained(sessionKey, this.idleConfirmMs);

    if (drainResult.drained && this.onIdleCallback && this._initialized) {
      info(
        MODULE,
        `[DRAIN-DONE] sessionKey=${sessionKey.slice(-32)} agentId=${agentId} reason=${drainResult.reason}`,
        getEventId()
      );
      try {
        void this.onIdleCallback(sessionKey, agentId, Date.now());
      } catch (err: any) {
        warn(MODULE, `[DRAIN] callback error: ${err.message}`, getEventId());
      }
    } else if (!drainResult.drained) {
      warn(
        MODULE,
        `[DRAIN-TIMEOUT] sessionKey=${sessionKey.slice(-32)} reason=${drainResult.reason}`,
        getEventId()
      );
    }
  }

  isIdle(sessionKey: string): boolean {
    const laneKey = `session:${sessionKey.trim()}`;
    const cmdqSymbol = Symbol.for("openclaw.commandQueueState");
    const cmdState = (globalThis as any)[cmdqSymbol];
    const laneState = cmdState?.lanes?.get(laneKey);
    if (!laneState) return true;
    const activeCount = laneState?.activeTaskIds?.size ?? 0;
    const queueCount = laneState?.queue?.length ?? 0;
    return activeCount === 0 && queueCount === 0;
  }

  /** 三态判断：active（执行中）| queued（排队中）| idle（空闲） */
  isSessionRunning(sessionKey: string): 'active' | 'queued' | 'idle' {
    const cmdqSymbol = Symbol.for("openclaw.commandQueueState");
    const cmdState = (globalThis as any)[cmdqSymbol];
    if (!cmdState?.lanes) return 'idle';

    // 1. session lane 有活 → 正在执行
    const sessionLaneKey = `session:${sessionKey.trim()}`;
    const sessionLane = cmdState.lanes.get(sessionLaneKey);
    if (sessionLane && (sessionLane.activeTaskIds?.size > 0 || sessionLane.queue?.length > 0)) {
      return 'active';
    }

    // 2. session lane 空的，查 main lane 是否拥堵
    const mainLane = cmdState.lanes.get("main");
    if (mainLane) {
      const activeCount = mainLane.activeTaskIds?.size ?? 0;
      const queueCount = mainLane.queue?.length ?? 0;
      const maxConcurrent = mainLane.maxConcurrent ?? 1;
      // main lane 已经满载 + 还有任务等 → 本 agent 可能在主队列排队
      if (activeCount >= maxConcurrent && queueCount > 0) {
        return 'queued';
      }
    }

    return 'idle';
  }

  hasUserRun(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.hasUserRun ?? false;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  async waitForLaneDrained(
    sessionKey: string,
    quietWindowMs: number,
    maxWaitMs: number = 300_000
  ): Promise<{ drained: boolean; reason: string }> {
    const laneKey = `session:${sessionKey.trim()}`;
    const cmdqSymbol = Symbol.for("openclaw.commandQueueState");
    const startedAt = Date.now();

    info(
      MODULE,
      `[LANE-DRAIN] start lane=${laneKey.slice(-32)} quietWindow=${quietWindowMs}ms maxWait=${maxWaitMs}ms`,
      getEventId()
    );

    const cmdState = (globalThis as any)[cmdqSymbol];
    const laneState = cmdState?.lanes?.get(laneKey);
    const activeCount = laneState?.activeTaskIds?.size ?? 0;
    const queueCount = laneState?.queue?.length ?? 0;

    if (activeCount > 0 || queueCount > 0) {
      info(
        MODULE,
        `[LANE-DRAIN] still busy active=${activeCount} queue=${queueCount} lane=${laneKey.slice(-32)}`,
        getEventId()
      );
      return { drained: false, reason: `lane busy (active=${activeCount} queue=${queueCount})` };
    }

    await sleep(quietWindowMs);

    const cmdState2 = (globalThis as any)[cmdqSymbol];
    const laneState2 = cmdState2?.lanes?.get(laneKey);
    const activeCount2 = laneState2?.activeTaskIds?.size ?? 0;
    const queueCount2 = laneState2?.queue?.length ?? 0;

    if (activeCount2 > 0 || queueCount2 > 0) {
      info(
        MODULE,
        `[LANE-DRAIN] new task in quiet window active=${activeCount2} queue=${queueCount2} lane=${laneKey.slice(-32)}`,
        getEventId()
      );
      return { drained: false, reason: `new task in quiet window (active=${activeCount2} queue=${queueCount2})` };
    }

    const elapsed = Date.now() - startedAt;
    info(
      MODULE,
      `[LANE-DRAIN] drained lane=${laneKey.slice(-32)} elapsed=${elapsed}ms`,
      getEventId()
    );
    return { drained: true, reason: `drained after ${elapsed}ms` };
  }

  clear(): void {
    this.sessions.clear();
  }

  destroy(): void {
    this.sessions.clear();
    this.onIdleCallback = null;
    this._initialized = false;
  }
}

const instance = new SessionQueueTracker();

export function getSessionQueueTracker(): SessionQueueTracker {
  return instance;
}

export { SessionQueueTracker };