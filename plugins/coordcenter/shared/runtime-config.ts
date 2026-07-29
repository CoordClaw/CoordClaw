/**
 * 运行时配置管理器 — v19.36
 *
 * 从 team.json 解析并应用运行时配置（compaction、llm_error、context_optimization、llm_input_dump），
 * 供插件初始化（index.ts）和缓存刷新（cache-coordinator.ts）复用。
 *
 * 职责：
 *   - 解析 team.json 中的运行时配置字段
 *   - 设置 globalThis 标志（跨进程通信）
 *   - 更新 compaction / llm_error 配置
 *   - 提供配置快照供日志输出
 */

import { setCompactionConfig } from "../message-routing/internal-state";
import { CompactionConfig } from "./types";
import { info, getEventId } from "./logger";

const MODULE = "runtime-config";

// ==================== LLM 错误阻断配置（共享可变对象） ====================

/** 健康轮询连续救活达到此次数后自动触发 llm_error 阻断 */
export const HEALTH_RESCUE_LIMIT = 20;

export const llmErrorConfig: { enabled: boolean; endcodes: number[] } = {
  enabled: false,
  endcodes: [],
};

// ==================== 配置快照 ====================

export interface RuntimeConfigSnapshot {
  compaction: CompactionConfig | undefined;
  llmError: { enabled: boolean; endcodes: number[] };
  contextOptimization: { enabled: boolean; keep_recent_rounds: number; discard: boolean; compress: boolean; log: boolean };
  llmInputDumpEnabled: boolean;
}

/**
 * 解析并应用运行时配置
 *
 * @param teamData  team.json 解析后的对象
 * @returns         配置快照（供日志输出）
 */
export function applyRuntimeConfig(teamData: any): RuntimeConfigSnapshot {
  const eventId = getEventId();

  // ==== 1. compaction 配置 ====
  const compaction = teamData?.compaction as CompactionConfig | undefined;
  setCompactionConfig(compaction);
  if (compaction) {
    info(MODULE, `[CONFIG] compaction: enabled=${compaction.enabled} count_threshold=${compaction.msg_count_threshold ?? 20} duration_min=${compaction.window_duration_minutes ?? 25}`, eventId);
  }

  // ==== 2. llm_error 阻断配置 ====
  const llmError = teamData?.llm_error as { enabled?: boolean; endcode?: number[] } | undefined;
  if (llmError?.enabled && Array.isArray(llmError.endcode) && llmError.endcode.length > 0) {
    llmErrorConfig.enabled = true;
    llmErrorConfig.endcodes = llmError.endcode.filter((c: any) => typeof c === "number");
    info(MODULE, `[CONFIG] llm_error: enabled=true endcodes=[${llmErrorConfig.endcodes.join(",")}]`, eventId);
  } else {
    llmErrorConfig.enabled = false;
    llmErrorConfig.endcodes = [];
    info(MODULE, `[CONFIG] llm_error: disabled`, eventId);
  }

  // ==== 3. llm_input_dump ====
  const llmInputDump = teamData?.llm_input_dump as { enabled?: boolean } | undefined;
  const dumpEnabled = llmInputDump?.enabled === true;
  (globalThis as any).__coordClawLlmInputDump = { enabled: dumpEnabled };
  info(MODULE, `[CONFIG] llm_input_dump: enabled=${dumpEnabled}`, eventId);

  // ==== 4. context_optimization ====
  const ctxOpt = teamData?.context_optimization as {
    enabled?: boolean;
    keep_recent_rounds?: number;
    discard_tool_result?: boolean;
    compress_toolcall_to_summary?: boolean;
    log_stats?: boolean;
  } | undefined;

  if (ctxOpt) {
    (globalThis as any).__coordClawContextOptimization = ctxOpt;
    info(MODULE, `[CONFIG] context_optimization: enabled=${ctxOpt.enabled ?? false} keep_recent_rounds=${ctxOpt.keep_recent_rounds ?? 1} discard=${ctxOpt.discard_tool_result !== false} compress=${ctxOpt.compress_toolcall_to_summary !== false} log=${ctxOpt.log_stats !== false}`, eventId);
  } else {
    (globalThis as any).__coordClawContextOptimization = { enabled: false };
    info(MODULE, `[CONFIG] context_optimization: not configured, default disabled`, eventId);
  }

  return {
    compaction,
    llmError: { enabled: llmErrorConfig.enabled, endcodes: [...llmErrorConfig.endcodes] },
    contextOptimization: {
      enabled: ctxOpt?.enabled ?? false,
      keep_recent_rounds: ctxOpt?.keep_recent_rounds ?? 1,
      discard: ctxOpt?.discard_tool_result !== false,
      compress: ctxOpt?.compress_toolcall_to_summary !== false,
      log: ctxOpt?.log_stats !== false,
    },
    llmInputDumpEnabled: dumpEnabled,
  };
}