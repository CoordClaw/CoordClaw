/**
 * Run Lifecycle Tracker - 实验性功能
 *
 * 目的：通过 Broadcast WebSocket 事件流获取单轮会话（run）的**唯一起止时间**
 * 解决问题：钩子系统（onAgentEvent）会在单轮 run 中多次触发 lifecycle.start/end，
 *          无法判断真正的起止点。本模块通过 seq 序列号实现精确去重。
 */

export interface LifecycleEvent {
  runId: string;
  sessionKey: string;
  stream: string;
  seq: number;
  ts: number;
  data: {
    phase: "start" | "end" | "error";
    startedAt?: number;
    endedAt?: number;
    error?: string;
    livenessState?: string;
    [key: string]: any;
  };
}

class RunLifecycleTrackerImpl {
  private runs = new Map<string, LifecycleEvent[]>();
  private trackedSessionKeys = new Set<string>();

  updateTrackedSessionKeys(sessionKeys: string[]) {
    this.trackedSessionKeys = new Set(sessionKeys);
  }

  trackEvent(evt: any): void {
    try {
      if (!evt || typeof evt !== "object") return;

      const stream = evt.stream;
      if (stream !== "lifecycle") return;

      const runId = evt.runId;
      if (!runId || typeof runId !== "string") return;

      const sessionKey = evt.sessionKey || "";
      const seq = typeof evt.seq === "number" ? evt.seq : -1;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();
      const data = evt.data || {};
      const phase = data.phase;

      if (!phase || !["start", "end", "error"].includes(phase)) return;

      const event: LifecycleEvent = { runId, sessionKey, stream, seq, ts, data };

      let events = this.runs.get(runId);
      if (!events) {
        events = [];
        this.runs.set(runId, events);
      }
      events.push(event);

      if (phase === "end" || phase === "error") {
        if (this.trackedSessionKeys.has(sessionKey)) {
          setTimeout(() => { this.runs.delete(runId); }, 60000);
        }
      }
    } catch (err) {
      // 错误已吞掉（原仅 tLog 记录，按要求完全去掉日志）
    }
  }

  getStats(): { activeRuns: number; trackedSessions: number } {
    return { activeRuns: this.runs.size, trackedSessions: this.trackedSessionKeys.size };
  }

  clear(): void {
    this.runs.clear();
  }
}

const instance = new RunLifecycleTrackerImpl();

export function getRunLifecycleTracker() {
  return instance;
}
