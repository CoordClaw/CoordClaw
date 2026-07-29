/**
 * llm-input-dump 持久化层
 *
 * v19.25 - LLM 请求导出（完整 system 提示词）
 *
 * 文件布局：
 *   %APPDATA%/CoordClaw/llm-input-dump/
 *   └── {runId}/
 *       ├── turn_001.json
 *       ├── turn_002.json
 *       └── ...
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { getLlmInputDumpDir } from "../shared/paths";
import { debug, info, warn, getEventId } from "../shared/logger";
import { LlmInputDumpEvent, LlmInputDumpRecord } from "./types";

const MODULE = "llm-input-dump";

/** 进程内 turn 计数（按 runId 维度自增；进程重启后从 1 重新开始） */
const turnSeqMap = new Map<string, number>();

function safeFileName(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "unknown";
  return cleaned.replace(/\.\./g, "__");
}

async function ensureDir(dir: string): Promise<void> {
  // ★★★ 诊断：记录目录创建前状态 ★★★
  const existsBefore = fsSync.existsSync(dir);
  debug(MODULE, `[DIAG] ensureDir: dir=${dir} existsBefore=${existsBefore}`, getEventId());
  await fs.mkdir(dir, { recursive: true });
  const existsAfter = fsSync.existsSync(dir);
  debug(MODULE, `[DIAG] ensureDir: existsAfter=${existsAfter}`, getEventId());
}

/**
 * 写入一次 LLM input dump
 */
export async function writeDumpFile(event: LlmInputDumpEvent): Promise<void> {
  const eid = getEventId();
  const runId = String(event.runId ?? "unknown");
  const dumpRoot = getLlmInputDumpDir();

  // ★★★ 诊断：入口参数快照 ★★★
  info(MODULE, `[DIAG] writeDumpFile ENTER: runId=${runId} dumpRoot=${dumpRoot}`, eid);

  const dir = path.join(dumpRoot, safeFileName(runId));
  await ensureDir(dir);

  const seq = (turnSeqMap.get(runId) ?? 0) + 1;
  turnSeqMap.set(runId, seq);

  const file = path.join(dir, `turn_${String(seq).padStart(3, "0")}.json`);

  const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : null;
  const messages = Array.isArray(event.historyMessages) ? event.historyMessages : null;

  const record: LlmInputDumpRecord = {
    timestamp: new Date().toISOString(),
    runId,
    sessionKey: event.sessionId ?? null,
    agentId: null, // llm_input event 中无 agentId 字段，由 openclaw 框架限制
    turnSeq: seq,
    provider: event.provider ?? null,
    model: event.model ?? null,
    systemPrompt,
    systemPromptLength: systemPrompt ? systemPrompt.length : 0,
    userPrompt: typeof event.prompt === "string" ? event.prompt : null,
    messages,
    messageCount: messages ? messages.length : 0,
    imagesCount: typeof event.imagesCount === "number" ? event.imagesCount : 0,
  };

  // ★★★ 诊断：准备写入的 record 结构概览 ★★★
  debug(
    MODULE,
    `[DIAG] about to writeFile: file=${file} ` +
    `sysLen=${record.systemPromptLength} msgs=${record.messageCount} images=${record.imagesCount} ` +
    `provider=${record.provider} model=${record.model}`,
    eid,
  );

  try {
    const jsonStr = JSON.stringify(record, null, 2);
    debug(MODULE, `[DIAG] JSON stringified OK, length=${jsonStr.length}`, eid);

    await fs.writeFile(file, jsonStr, "utf-8");

    // ★★★ 诊断：验证文件确实写入了 ★★★
    const stat = fsSync.statSync(file);
    debug(MODULE, `[DIAG] file written OK: size=${stat.size} bytes`, eid);

    info(
      MODULE,
      `dumped turn_${String(seq).padStart(3, "0")}.json runId=${runId.slice(-12)} ` +
        `msgs=${record.messageCount} promptLen=${record.systemPromptLength} images=${record.imagesCount}`,
      eid,
    );
  } catch (err: any) {
    warn(MODULE, `write dump failed: ${err.message} (file=${file})`, eid);
    throw err;
  }
}

/**
 * 清空所有 dump 文件
 */
export async function clearAllDumps(): Promise<{ cleared: boolean; path: string; count: number }> {
  const dir = getLlmInputDumpDir();
  let count = 0;
  try {
    if (!fsSync.existsSync(dir)) {
      info(MODULE, `clear: dir not exists, nothing to do (${dir})`, getEventId());
      return { cleared: false, path: dir, count: 0 };
    }

    // 统计文件数（用于日志）
    try {
      const entries = fsSync.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          try {
            const sub = fsSync.readdirSync(path.join(dir, e.name));
            count += sub.length;
          } catch {
            /* 子目录读取失败不影响整体清理 */
          }
        }
      }
    } catch {
      /* 统计失败不影响清理 */
    }

    await fs.rm(dir, { recursive: true, force: true });
    turnSeqMap.clear();
    info(MODULE, `cleared ${count} dump files at ${dir}`, getEventId());
    return { cleared: true, path: dir, count };
  } catch (err: any) {
    warn(MODULE, `clear failed: ${err.message}`, getEventId());
    throw err;
  }
}

/**
 * 仅测试 / 诊断用：返回 dump 根目录
 */
export function getDumpRootDir(): string {
  return getLlmInputDumpDir();
}
