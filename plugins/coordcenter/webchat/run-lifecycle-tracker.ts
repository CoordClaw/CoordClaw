/**
 * Run Lifecycle Tracker - 实验性功能
 *
 * 目的：通过 Broadcast WebSocket 事件流获取单轮会话（run）的**唯一起止时间**
 * 解决问题：钩子系统（onAgentEvent）会在单轮 run 中多次触发 lifecycle.start/end，
 *          无法判断真正的起止点。本模块通过 seq 序列号实现精确去重。
 */

import fsSync from "node:fs";
import pathMod from "node:path";
import osMod from "node:os";

const TRACKER_LOG_FILE = pathMod.join(osMod.homedir(), ".coordclaw-runtracker-debug.log");

function tLog(msg: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fsSync.appendFileSync(TRACKER_LOG_FILE, line, "utf8");
  } catch (e) {}
}

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

export interface RunBoundary {
  runId: string;
  sessionKey: string;
  agentId: string;
  uniqueStart: {
    seq: number;
    startedAt: number;
    ts: number;
  } | null;
  uniqueEnd: {
    seq: number;
    endedAt: number;
    phase: "end" | "error";
    ts: number;
  } | null;
  totalEvents: number;
  durationMs: number | null;
  hasCompaction: boolean;
  timestamp: string;
}

class RunLifecycleTrackerImpl {
  private runs = new Map<string, LifecycleEvent[]>();
  private trackedSessionKeys = new Set<string>();

  updateTrackedSessionKeys(sessionKeys: string[]) {
    this.trackedSessionKeys = new Set(sessionKeys);
    tLog(`updateTrackedSessionKeys: ${sessionKeys.length} keys`);
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

      if (this.trackedSessionKeys.has(sessionKey)) {
        tLog(
          `EVENT: runId=${String(runId).slice(0,12)}... ` +
          `sessionKey=${String(sessionKey).slice(-20)}... ` +
          `phase=${phase} seq=${seq}`
        );
      }

      if (phase === "end" || phase === "error") {
        this.tryExtractBoundary(runId);
      }
    } catch (err) {
      tLog(`trackEvent ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private tryExtractBoundary(runId: string): void {
    try {
      const events = this.runs.get(runId);
      if (!events || events.length === 0) return;

      const sessionKey = events[0].sessionKey;
      if (!this.trackedSessionKeys.has(sessionKey)) return;

      const starts = events.filter((e) => e.data.phase === "start");
      const ends = events.filter((e) => e.data.phase === "end" || e.data.phase === "error");

      if (starts.length === 0 || ends.length === 0) return;

      starts.sort((a, b) => a.seq - b.seq);
      ends.sort((a, b) => b.seq - a.seq);

      const uniqueStart = starts[0];
      const uniqueEnd = ends[0];

      const hasCompaction = events.some((e) => e.stream === "compaction");
      const durationMs =
        uniqueEnd.data.endedAt && uniqueStart.data.startedAt
          ? uniqueEnd.data.endedAt - uniqueStart.data.startedAt
          : null;

      const agentId = this.extractAgentId(sessionKey);

      const boundary: RunBoundary = {
        runId,
        sessionKey,
        agentId,
        uniqueStart: {
          seq: uniqueStart.seq,
          startedAt: uniqueStart.data.startedAt || uniqueStart.ts,
          ts: uniqueStart.ts
        },
        uniqueEnd: {
          seq: uniqueEnd.seq,
          endedAt: uniqueEnd.data.endedAt || uniqueEnd.ts,
          phase: uniqueEnd.data.phase as "end" | "error",
          ts: uniqueEnd.ts
        },
        totalEvents: events.length,
        durationMs,
        hasCompaction,
        timestamp: new Date().toISOString()
      };

      this.logBoundary(boundary);

      setTimeout(() => { this.runs.delete(runId); }, 60000);
    } catch (err) {
      tLog(`tryExtractBoundary ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private extractAgentId(sessionKey: string): string {
    try {
      const parts = sessionKey.split(":");
      if (parts.length >= 2) return parts[1];
      return sessionKey;
    } catch {
      return sessionKey;
    }
  }

  private logBoundary(boundary: RunBoundary): void {
    const startTime = new Date(boundary.uniqueStart!.startedAt).toISOString();
    const endTime = new Date(boundary.uniqueEnd!.endedAt).toISOString();
    const durationStr = boundary.durationMs !== null ? `${(boundary.durationMs / 1000).toFixed(2)}s` : "N/A";
    const compactionFlag = boundary.hasCompaction ? " [含Compaction]" : "";

    tLog("");
    tLog("╔════════════════════════════════════════════════════════════╗");
    tLog("║           🎯 RUN LIFECYCLE BOUNDARY (唯一性保证)           ║");
    tLog("╠════════════════════════════════════════════════════════════╣");
    tLog(`║  Agent ID     : ${boundary.agentId.padEnd(44)}║`);
    tLog(`║  Session Key  : ${boundary.sessionKey.slice(-46).padStart(46)}║`);
    tLog(`║  Run ID       : ${boundary.runId.padEnd(44)}║`);
    tLog("╠════════════════════════════════════════════════════════════╣");
    tLog(`║  ✅ 真正开始   : seq=${String(boundary.uniqueStart!.seq).padStart(6)} @ ${startTime}${compactionFlag}`);
    tLog(`║  ✅ 真正结束   : seq=${String(boundary.uniqueEnd!.seq).padStart(6)} @ ${endTime} (${boundary.uniqueEnd.phase})`);
    tLog(`║  ⏱️  持续时间   : ${durationStr.padEnd(44)}║`);
    tLog(`║  📊 总事件数   : ${String(boundary.totalEvents).padEnd(44)}║`);
    tLog("╠════════════════════════════════════════════════════════════╣");
    tLog(`║  🔍 唯一性验证 : start.seq=${boundary.uniqueStart!.seq} < end.seq=${boundary.uniqueEnd!.seq} ✅`);
    tLog("╚════════════════════════════════════════════════════════════╝");
    tLog("");
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
