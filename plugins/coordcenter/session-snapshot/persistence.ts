import fs from "fs";
import path from "path";
import { getCoordClawDataDir, getCoordClawLogsDir } from "../shared/paths";
import { getSessionActivityCache } from "../message-routing/cache/manager";
import { debug, warn, getEventId } from "../shared/logger";
import { normalizeUtcStamp } from "../shared/time";
import { pushSnapshotEvent } from "./snapshot-events";

const MODULE = "snapshot-persist";
const SNAPSHOT_FILENAME = "session-snapshot.json";
const PULSE_FILENAME = "snapshot-pulse.jsonl";

function datedFilename(base: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return `${d}-${base}`;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getSnapshotFilePath(): string {
  return path.join(getCoordClawDataDir(), "cache", SNAPSHOT_FILENAME);
}

export function getPulseFilePath(): string {
  return path.join(getCoordClawLogsDir(), datedFilename(PULSE_FILENAME));
}

export function deleteSnapshotFile(): void {
  try {
    const filePath = getSnapshotFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      debug(MODULE, `deleted snapshot: ${filePath}`, getEventId());
    }
  } catch (e: any) {
    warn(MODULE, `delete snapshot failed: ${e.message}`, getEventId());
  }
}

export function writeSnapshotFile(sessionKey: string): void {
  try {
    const cache = getSessionActivityCache();
    const record = cache.get(sessionKey);
    if (!record) {
      debug(MODULE, `skip snapshot: cache miss for ${sessionKey}`, getEventId());
      return;
    }

    const filePath = getSnapshotFilePath();
    ensureDir(path.dirname(filePath));

    let data: Record<string, any> = {};
    if (fs.existsSync(filePath)) {
      try {
        data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch { /* 文件损坏则重建 */ }
    }

    data[sessionKey] = {
      agentId: record.agentId,
      agentName: record.agentName,
      sessionKey: record.sessionKey,
      roundIndex: record.roundIndex,
      status: record.status,
      fixable: record.fixable ?? false,
      completedNormally: record.completedNormally ?? true, // 与 fixable 完全同路径
      state: record.state,
      startedAt: toUtcIso(record.startedAt),
      endedAt: toUtcIso(record.endedAt),
      updatedAt: toUtcIso(record.updatedAt),
      totalTokens: record.totalTokens,
      totalToolCalls: record.totalToolCalls,
      runs: (record.runs ?? []).map((r: any) => ({
        ...r,
        startedAt: toUtcIso(r.startedAt),
        endedAt: toUtcIso(r.endedAt),
      })),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    pushSnapshotEvent();
  } catch (e: any) {
    warn(MODULE, `write snapshot failed: ${e.message}`, getEventId());
  }
}

function toUtcIso(isoStr: string | null): string | null {
  // 统一 UTC：把任意输入归一成纯 ISO-Z（record.startedAt 等本就是本插件 toISOString() 生成的 UTC，
  // 这里归一化是为了防御源数据格式不统一；本地化展示由控制面板 / 前端负责）。
  if (!isoStr) return null;
  return normalizeUtcStamp(isoStr);
}

export function writePulseNotification(
  event: string,
  sessionKey: string,
  roundIndex: number,
): void {
  try {
    const line = JSON.stringify({
      event,
      sessionKey,
      roundIndex,
      timestamp: new Date().toISOString(),
    }) + "\n";
    const filePath = getPulseFilePath();
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, line, "utf-8");
  } catch (e: any) {
    warn(MODULE, `write pulse failed: ${e.message}`, getEventId());
  }
}