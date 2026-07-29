/**
 * 缓存协调层（Cache Coordinator）— v19.37
 *
 * 统一管理所有缓存的生命周期，提供三层语义的刷新函数：
 *
 * ▪ reloadFileCache() — 轻量文件重载
 *    用途：外部 cache-refresh HTTP 接口
 *    操作：L1（文件缓存清除+重读）+ L5（运行时配置热更新）
 *    影响：仅使磁盘文件缓存失效 + 配置热生效，不碰任何运行时状态
 *
 * ▪ syncTeamData() — 运行时数据同步
 *    用途：session-key-generator 写入后、成员增量变更后
 *    操作：L1 + L5 + L2/L3（增量同步，保留 processing 状态）+ L6
 *    影响：运行时数据与 team.json 文件同步，正在工作的 agent 状态不丢失
 *
 * ▪ fullReset() — 全量重建
 *    用途：project-create 后、project-delete 后
 *    操作：L1~L6 全量（等同于插件冷启动）
 *    影响：彻底重建所有运行时状态
 *
 * 协调的缓存层级：
 *   Layer 1 - 文件内容缓存（prompt-injection/loader.ts）
 *     - ruleCache:           team RULE.md 文件内容
 *     - rulePathCache:       激活项目根路径（来自 coordclaw.json 解析）
 *     - projectTeamJsonCache: team.json 解析后数据
 *
 *   Layer 2 - 会话队列跟踪（message-routing/session-queue-tracker.ts）
 *     - trackedSessionKeys:  参与 drain 等待的 sessionKey 集合
 *
 *   Layer 3 - 会话活动缓存（message-routing/cache/manager.ts）
 *     - sessionActivityCache: sessionKey → AgentActivityRecord
 *     - agentIdToSessionKey:  agent_id → sessionKey 反向索引
 *
 *   Layer 4 - 信号状态（message-routing/internal-state.ts）
 *     - sessionSignals:       会话信号状态机 Map
 *
 *   Layer 5 - 运行时配置（shared/runtime-config.ts）
 *     - compaction / llm_error / context_optimization / llm_input_dump 配置热更新
 *
 *   Layer 6 - 广播追踪（webchat/broadcast-v2.ts 可选）
 *     - run-lifecycle-tracker trackedKeys:  广播事件过滤的 sessionKey 集合
 */

import { info, warn, getEventId } from "./logger";
import { getCoordClawJsonPath } from "./paths";
import {
  clearLoaderCache,
  resolveProjectRoot,
  loadProjectTeamJson,
} from "../prompt-injection/loader";
import { getSessionQueueTracker } from "../message-routing/session-queue-tracker";
import { rebuildFromMembers, syncFromMembers } from "../message-routing/cache/manager";
import { sessionSignals } from "../message-routing/internal-state";
import { applyRuntimeConfig } from "./runtime-config";
import { pushSnapshotEvent } from "../session-snapshot/snapshot-events";

const MODULE = "cache-coordinator";

// ==================== 共享返回类型 ====================

export interface CacheOperationResult {
  ok: boolean;
  message: string;
  projectRoot: string;
  memberCount: number;
  errors: string[];
}

export interface SyncTeamDataResult extends CacheOperationResult {
  /** 增量同步统计 */
  syncStats?: {
    added: number;
    updated: number;
    retained: number;
    removed: number;
    skipped: number;
  };
}

// ==================== 共享 Helper ====================

/** 读取 coordclaw.json → 获取激活项目 root → 加载 team.json */
async function loadTeamFromFiles(cacheTtl: number): Promise<{ projectRoot: string; teamData: any; members: any[] }> {
  const coordclawJsonPath = getCoordClawJsonPath();
  const projectRoot = await resolveProjectRoot(coordclawJsonPath, cacheTtl);
  const teamData = await loadProjectTeamJson(projectRoot, cacheTtl) as any;
  const members: any[] = Array.isArray(teamData?.members) ? teamData.members : [];
  return { projectRoot, teamData, members };
}

/** 提取 sessionKey 列表 */
function extractSessionKeys(members: any[]): string[] {
  const keys: string[] = [];
  for (const m of members) {
    if (m.sessionKey && m.sessionKey.length > 0) {
      keys.push(m.sessionKey);
    }
  }
  return keys;
}

/** 同步 L6 broadcast-v2 trackedKeys（可选，失败不影响主流程） */
async function syncBroadcastKeys(members: any[]): Promise<void> {
  try {
    const sessionKeys = extractSessionKeys(members);
    const { setTrackedSessionKeys: bcSetKeys } = await import("../webchat/broadcast-v2");
    if (typeof bcSetKeys === "function") {
      bcSetKeys(sessionKeys);
      info(MODULE, `[REFRESH] L6 broadcast-v2 trackedKeys 已刷新: ${sessionKeys.length} 个`, getEventId());
    }
  } catch (err: any) {
    if (err.message !== "Cannot find module" && !err.message.includes("Cannot find")) {
      warn(MODULE, `[REFRESH] L6 broadcast-v2 刷新失败: ${err.message}`, getEventId());
    }
  }
}

// ==================== 函数 1：reloadFileCache — 轻量文件重载 ====================

/**
 * 轻量文件重载：仅使文件缓存失效 + 运行时配置热更新
 *
 * 不碰 L2/L3/L4/L6，对运行中 agent 零影响。
 * 供 cache-refresh HTTP 接口调用。
 *
 * @param cacheTtl 缓存 TTL 毫秒数，默认 0 表示强制绕过缓存直接读取文件
 */
export async function reloadFileCache(cacheTtl: number = 0): Promise<CacheOperationResult> {
  const eventId = getEventId();
  const errors: string[] = [];

  info(MODULE, `[RELOAD] 轻量文件重载开始`, eventId);

  // ====== Layer 1: 文件内容缓存 ======
  const cleared = clearLoaderCache();
  info(MODULE, `[RELOAD] L1 文件缓存已清除: ${cleared.cleared.join(", ") || "(空)"}`, eventId);

  let projectRoot: string;
  let reloadedMembers: any[] = [];
  try {
    const { projectRoot: root, members } = await loadTeamFromFiles(cacheTtl);
    projectRoot = root;
    reloadedMembers = members;
    info(MODULE, `[RELOAD] L1 文件缓存已重载: ${projectRoot}, ${members.length} 个成员`, eventId);
  } catch (err: any) {
    const errMsg = `重载文件缓存失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RELOAD] L1 ${errMsg}`, eventId);
    return { ok: false, message: `文件重载失败: ${errMsg}`, projectRoot: "", memberCount: 0, errors };
  }

  // ====== Layer 2: session-queue-tracker + SSE 推送 ======
  try {
    const sessionKeys = extractSessionKeys(reloadedMembers);
    getSessionQueueTracker().setTrackedSessionKeys(sessionKeys);
    info(MODULE, `[RELOAD] L2 session-queue-tracker 已同步: ${sessionKeys.length} 个 sessionKey`, eventId);
  } catch (err: any) {
    const errMsg = `同步 session-queue-tracker 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RELOAD] L2 ${errMsg}`, eventId);
  }

  try {
    pushSnapshotEvent();
    info(MODULE, `[RELOAD] L2 SSE 全量快照已推送`, eventId);
  } catch (_) { /* SSE 推送非致命 */ }

  // ====== Layer 5: 运行时配置热更新 ======
  try {
    const { teamData } = await loadTeamFromFiles(cacheTtl);
    const snapshot = applyRuntimeConfig(teamData);
    info(MODULE, `[RELOAD] L5 运行时配置已刷新: compaction=${snapshot.compaction?.enabled ? "on" : "off"} llm_error=${snapshot.llmError.enabled ? snapshot.llmError.endcodes.join(",") : "off"} ctx_opt=${snapshot.contextOptimization.enabled ? "on" : "off"} dump=${snapshot.llmInputDumpEnabled ? "on" : "off"}`, eventId);
  } catch (err: any) {
    const errMsg = `应用运行时配置失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RELOAD] L5 ${errMsg}`, eventId);
  }

  const allOk = errors.length === 0;
  const message = allOk
    ? `文件缓存重载成功 — projectRoot=${projectRoot}`
    : `文件缓存重载部分完成 — ${errors.length} 个警告`;

  info(MODULE, `[RELOAD] 完成: ok=${allOk} projectRoot=${projectRoot} errors=${errors.length}`, eventId);
  return { ok: allOk, message, projectRoot, memberCount: 0, errors };
}

// ==================== 函数 2：syncTeamData — 运行时数据同步 ====================

/**
 * 运行时数据同步：不破坏运行中 agent 状态的增量更新
 *
 *   L3 增量策略：
 *     - 新增成员 → 创建 ended 条目
 *     - 已有成员 → 仅更新静态字段（name），不动 status/state/roundIndex/tokens/runs
 *     - 移除成员 → 仅 ended 状态删除，processing 状态保留
 *   L4 不碰：sessionSignals 保留（运行中 agent 状态机上下文不丢）
 *
 * 供 session-key-generator 写入后调用、team.json 成员变更后调用。
 *
 * @param cacheTtl 缓存 TTL 毫秒数，默认 0 表示强制绕过缓存直接读取文件
 */
export async function syncTeamData(cacheTtl: number = 0): Promise<SyncTeamDataResult> {
  const eventId = getEventId();
  const errors: string[] = [];

  info(MODULE, `[SYNC] 运行时数据同步开始`, eventId);

  // ====== Layer 1: 文件内容缓存 ======
  const cleared = clearLoaderCache();
  info(MODULE, `[SYNC] L1 文件缓存已清除: ${cleared.cleared.join(", ") || "(空)"}`, eventId);

  let projectRoot: string;
  let members: any[];
  try {
    const loaded = await loadTeamFromFiles(cacheTtl);
    projectRoot = loaded.projectRoot;
    members = loaded.members;
    info(MODULE, `[SYNC] L1 文件缓存已重载: ${projectRoot}, ${members.length} 个成员`, eventId);
  } catch (err: any) {
    const errMsg = `重载文件缓存失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[SYNC] L1 ${errMsg}`, eventId);
    return { ok: false, message: `数据同步失败: ${errMsg}`, projectRoot: "", memberCount: 0, errors };
  }

  // ====== Layer 5: 运行时配置热更新 ======
  try {
    const { teamData } = await loadTeamFromFiles(cacheTtl);
    const snapshot = applyRuntimeConfig(teamData);
    info(MODULE, `[SYNC] L5 运行时配置已刷新: compaction=${snapshot.compaction?.enabled ? "on" : "off"} llm_error=${snapshot.llmError.enabled ? snapshot.llmError.endcodes.join(",") : "off"} ctx_opt=${snapshot.contextOptimization.enabled ? "on" : "off"} dump=${snapshot.llmInputDumpEnabled ? "on" : "off"}`, eventId);
  } catch (err: any) {
    const errMsg = `应用运行时配置失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[SYNC] L5 ${errMsg}`, eventId);
  }

  // ====== Layer 2: session-queue-tracker（增量更新） ======
  try {
    const sessionKeys = extractSessionKeys(members);
    getSessionQueueTracker().setTrackedSessionKeys(sessionKeys);
    info(MODULE, `[SYNC] L2 session-queue-tracker 已同步: ${sessionKeys.length} 个 sessionKey`, eventId);
  } catch (err: any) {
    const errMsg = `同步 session-queue-tracker 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[SYNC] L2 ${errMsg}`, eventId);
  }

  // ====== Layer 3: sessionActivityCache（增量同步，不破坏 processing 状态） ======
  let syncStats: SyncTeamDataResult['syncStats'];
  try {
    syncStats = syncFromMembers(members);
    info(MODULE, `[SYNC] L3 sessionActivityCache 已同步: added=${syncStats.added} updated=${syncStats.updated} retained=${syncStats.retained} removed=${syncStats.removed} skipped=${syncStats.skipped}`, eventId);
  } catch (err: any) {
    const errMsg = `同步 sessionActivityCache 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[SYNC] L3 ${errMsg}`, eventId);
  }

  // ⚠️ L4 不碰 — sessionSignals 保留

  // ====== Layer 6: broadcast-v2 trackedKeys ======
  try {
    await syncBroadcastKeys(members);
  } catch (err: any) {
    warn(MODULE, `[SYNC] L6 ${err.message}`, eventId);
  }

  const allOk = errors.length === 0;
  const message = allOk
    ? `运行时数据同步成功 — projectRoot=${projectRoot}, members=${members.length}`
    : `运行时数据同步部分完成 — ${errors.length} 个警告`;

  info(MODULE, `[SYNC] 完成: ok=${allOk} projectRoot=${projectRoot} members=${members.length} errors=${errors.length} syncStats=${JSON.stringify(syncStats || {})}`, eventId);

  return { ok: allOk, message, projectRoot, memberCount: members.length, errors, syncStats };
}

// ==================== 函数 3：fullReset — 全量重建 ====================

/**
 * 全量重建：等同于插件冷启动，彻底重建所有运行时状态
 *
 * 供 project-create、project-delete、project-switch 后调用。
 * 注意：此函数会销毁所有运行的 agent 状态，不应在 agent 运行期间从外部调用。
 *
 * @param cacheTtl 缓存 TTL 毫秒数，默认 0 表示强制绕过缓存直接读取文件
 */
export async function fullReset(cacheTtl: number = 0): Promise<CacheOperationResult> {
  const eventId = getEventId();
  const errors: string[] = [];

  info(MODULE, `[RESET] 全量重建开始（六层协调）`, eventId);

  // ====== Layer 1: 文件内容缓存 ======
  const cleared = clearLoaderCache();
  info(MODULE, `[RESET] L1 文件缓存已清除: ${cleared.cleared.join(", ") || "(空)"}`, eventId);

  let projectRoot: string;
  try {
    const coordclawJsonPath = getCoordClawJsonPath();
    projectRoot = await resolveProjectRoot(coordclawJsonPath, cacheTtl);
    info(MODULE, `[RESET] L1 激活项目路径已加载: ${projectRoot}`, eventId);
  } catch (err: any) {
    const errMsg = `解析 coordclaw.json 激活项目失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RESET] L1 ${errMsg}`, eventId);
    return { ok: false, message: `全量重建失败: ${errMsg}`, projectRoot: "", memberCount: 0, errors };
  }

  let teamData: any;
  try {
    teamData = await loadProjectTeamJson(projectRoot, cacheTtl) as any;
    info(MODULE, `[RESET] L1 team.json 已加载: ${teamData?.members?.length || 0} 个成员`, eventId);
  } catch (err: any) {
    const errMsg = `加载 team.json 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RESET] L1 ${errMsg}`, eventId);
    return { ok: false, message: `全量重建失败: ${errMsg}`, projectRoot, memberCount: 0, errors };
  }

  const members: any[] = Array.isArray(teamData?.members) ? teamData.members : [];

  // ====== Layer 5: 运行时配置热更新 ======
  try {
    const snapshot = applyRuntimeConfig(teamData);
    info(MODULE, `[RESET] L5 运行时配置已刷新: compaction=${snapshot.compaction?.enabled ? "on" : "off"} llm_error=${snapshot.llmError.enabled ? snapshot.llmError.endcodes.join(",") : "off"} ctx_opt=${snapshot.contextOptimization.enabled ? "on" : "off"} dump=${snapshot.llmInputDumpEnabled ? "on" : "off"}`, eventId);
  } catch (err: any) {
    const errMsg = `应用运行时配置失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RESET] L5 ${errMsg}`, eventId);
  }

  // ====== Layer 2: session-queue-tracker ======
  try {
    const sessionKeys = extractSessionKeys(members);
    getSessionQueueTracker().setTrackedSessionKeys(sessionKeys);
    info(MODULE, `[RESET] L2 session-queue-tracker 已重置: ${sessionKeys.length} 个 sessionKey`, eventId);
  } catch (err: any) {
    const errMsg = `重置 session-queue-tracker 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RESET] L2 ${errMsg}`, eventId);
  }

  // ====== Layer 3: sessionActivityCache（全量重建） ======
  try {
    rebuildFromMembers(members);
    info(MODULE, `[RESET] L3 sessionActivityCache 已重建: ${members.length} 个成员`, eventId);
  } catch (err: any) {
    const errMsg = `重建 sessionActivityCache 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RESET] L3 ${errMsg}`, eventId);
  }

  // ====== Layer 4: sessionSignals（清除旧信号状态） ======
  try {
    const oldSize = sessionSignals.size;
    sessionSignals.clear();
    info(MODULE, `[RESET] L4 sessionSignals 已清除: ${oldSize} → 0`, eventId);
  } catch (err: any) {
    const errMsg = `清除 sessionSignals 失败: ${err.message}`;
    errors.push(errMsg);
    warn(MODULE, `[RESET] L4 ${errMsg}`, eventId);
  }

  // ====== Layer 6: broadcast-v2 trackedKeys ======
  try {
    await syncBroadcastKeys(members);
  } catch (err: any) {
    warn(MODULE, `[RESET] L6 ${err.message}`, eventId);
  }

  const allOk = errors.length === 0;
  const message = allOk
    ? `全量重建成功 — projectRoot=${projectRoot}, members=${members.length}`
    : `全量重建部分完成 — ${errors.length} 个警告`;

  info(MODULE, `[RESET] 完成: ok=${allOk} projectRoot=${projectRoot} members=${members.length} errors=${errors.length}`, eventId);

  return { ok: allOk, message, projectRoot, memberCount: members.length, errors };
}

// ==================== 向后兼容导出 ====================

/**
 * @deprecated 使用 reloadFileCache() / syncTeamData() / fullReset() 替代
 */
export const fullRefresh = fullReset;