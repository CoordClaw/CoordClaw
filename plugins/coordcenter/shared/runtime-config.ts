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

/**
 * 错误码抽取字段路径的默认种子（按优先级，从前往后取第一个能抽到码的字段）。
 * errorMessage 排在 errorCode 之前：兼容“不发 errorCode、改用 errorMessage+stopReason 表达失败”的网关版本。
 * team.json 的 llm_error.fields 可覆盖；缺省回落到此种子，保证旧配置（无 fields）仍检测 errorCode。
 */
export const DEFAULT_LLM_ERROR_FIELDS: string[] = ["errorMessage", "errorCode"];

/** 固定状态码正则：从字符串字段抽出第一个三位数字（4xx/5xx 等） */
const STATUS_CODE_REGEX = /\b(\d{3})\b/;

/** 按点分路径取值，支持 "a.b.c" 嵌套（为未来 failDetails.code 等留口，零改码） */
function getByPath(obj: any, path: string): any {
  if (obj == null) return undefined;
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 仅当消息本身像错误时才从字符串字段抽码，避免普通消息内容里的“task 402”等三位数字被误抽 */
function isErrorLike(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;
  return msg.stopReason === "error" || msg.errorCode != null;
}

/**
 * 按 fields 顺序，从单条消息抽取第一个可识别的错误码。
 * 策略固定（不进配置）：number/纯数字串 → Number 直取；含文字的 string → 仅错误消息字段才过固定正则抽三位状态码。
 * 返回 null 表示本条消息无可识别错误码。
 */
export function extractErrorCode(msg: any, fields: string[]): number | null {
  if (!msg || !Array.isArray(fields)) return null;
  for (const field of fields) {
    const raw = getByPath(msg, field);
    if (raw == null) continue;
    if (typeof raw === "number") {
      if (Number.isFinite(raw) && raw > 0) return raw;
      continue;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      // 纯数字串（如 errorCode 以字符串下发 "402"）按数值直取，不走正则、无需 isErrorLike 闸门
      if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n) && n > 0) return n;
        continue;
      }
      // 含文字的字符串（如 errorMessage:"402 status code (no body)"）：仅错误消息才抽码
      if (!isErrorLike(msg)) continue;
      const m = trimmed.match(STATUS_CODE_REGEX);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return n;
      }
    }
    // 其它类型（boolean/object/undefined）忽略
  }
  return null;
}

/**
 * 从 messages 末尾往前扫，取最近一条带错误码的消息（与旧语义一致：最近一条决定，非 OR）。
 * 抽到码后由 endcodes 名单做最终过滤：命中返回 true。
 */
export function scanMessagesForLlmError(messages: any, fields: string[], endcodes: number[]): boolean {
  if (!Array.isArray(messages) || !Array.isArray(endcodes)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const code = extractErrorCode(messages[i], fields);
    if (code != null) {
      return endcodes.includes(code);
    }
  }
  return false;
}

export const llmErrorConfig: { enabled: boolean; endcodes: number[]; fields: string[] } = {
  enabled: false,
  endcodes: [],
  fields: [...DEFAULT_LLM_ERROR_FIELDS],
};

// ==================== 配置快照 ====================

export interface RuntimeConfigSnapshot {
  compaction: CompactionConfig | undefined;
  llmError: { enabled: boolean; endcodes: number[]; fields: string[] };
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
  const llmError = teamData?.llm_error as { enabled?: boolean; endcode?: number[]; fields?: string[] } | undefined;
  if (llmError?.enabled && Array.isArray(llmError.endcode) && llmError.endcode.length > 0) {
    llmErrorConfig.enabled = true;
    llmErrorConfig.endcodes = llmError.endcode.filter((c: any) => typeof c === "number");
    // fields：可热加载的抽取路径列表；配置提供时覆盖，否则回落默认种子（保证旧配置无 fields 仍检测 errorCode）
    llmErrorConfig.fields = Array.isArray(llmError.fields)
      ? llmError.fields.filter((f: any) => typeof f === "string")
      : [...DEFAULT_LLM_ERROR_FIELDS];
    info(MODULE, `[CONFIG] llm_error: enabled=true endcodes=[${llmErrorConfig.endcodes.join(",")}] fields=[${llmErrorConfig.fields.join(",")}]`, eventId);
  } else {
    llmErrorConfig.enabled = false;
    llmErrorConfig.endcodes = [];
    llmErrorConfig.fields = [...DEFAULT_LLM_ERROR_FIELDS];
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
    llmError: { enabled: llmErrorConfig.enabled, endcodes: [...llmErrorConfig.endcodes], fields: [...llmErrorConfig.fields] },
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