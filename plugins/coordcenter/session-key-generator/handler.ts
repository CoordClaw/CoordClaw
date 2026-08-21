/**
 * 功能模块：批量创建SessionKey - Handler
 *
 * 通过 Gateway RPC sessions.create 为team.json中的agent创建sessionkey
 * 使用插件已有的 loadTeamContext 和 resolveProjectRoot 方法
 */

import fs from "node:fs";
import path from "node:path";
import { getEventId, info, warn, error } from "../shared/logger";
import { loadTeamContext, TeamContext } from "../shared/team-loader";
import { loadProjectTeamJson } from "../prompt-injection";
import { callGatewayRpc } from "../shared/gateway-rpc";
import { getTeamJsonPath } from "../shared/paths";
import { writeTeamJson } from "../shared/config-store";
import { HttpRouteConfig } from "../shared/types-http";

export interface CreateSessionKeyResult {
  success: boolean;
  agentId: string;
  agentName: string;
  oldSessionKey: string | null;
  newSessionKey: string | null;
  error?: string;
}

export interface BatchCreateSessionKeysConfig extends HttpRouteConfig {
  teamJsonPath?: string;
}

export interface BatchCreateSessionKeysRequest {
  teamJsonPath?: string;
  agentIds?: string[];
  force?: boolean;
  show?: boolean;
}

export interface BatchCreateSessionKeysResponse {
  success: boolean;
  message: string;
  results: CreateSessionKeyResult[];
  teamJsonPath: string;
  updated: number;
  failed: number;
  total: number;
}

async function createSessionKeyForAgent(
  agentId: string,
  caller: string = "session-key-generator"
): Promise<{ success: boolean; sessionKey?: string; error?: string }> {
  const eventId = getEventId();

  try {
    info(caller, `[RPC] 为 ${agentId} 创建sessionkey...`, eventId);

    const result = await callGatewayRpc({
      method: "sessions.create",
      params: {
        agentId: agentId,
      },
      timeoutMs: 10_000,
    });

    if (result && typeof result === "object" && result.key) {
      info(caller, `[RPC] ✅ ${agentId} 创建成功: ${(result.key as string).slice(0, 50)}...`, eventId);
      return {
        success: true,
        sessionKey: result.key as string,
      };
    }

    warn(caller, `[RPC] ⚠️ ${agentId} 响应无效: ${JSON.stringify(result).slice(0, 200)}`, eventId);
    return {
      success: false,
      error: "Invalid response from sessions.create",
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    error(caller, `[RPC] ❌ ${agentId} 创建失败: ${errMsg}`, eventId);
    return {
      success: false,
      error: errMsg,
    };
  }
}

export async function showTeamSessionKeys(
  config: BatchCreateSessionKeysConfig,
  caller: string = "session-key-generator"
): Promise<{
  success: boolean;
  members: Array<{
    name: string;
    agentId: string;
    hasSessionKey: boolean;
    sessionKeyPreview: string | null;
    authorityLevel: string | null;
  }>;
  total: number;
  hasSessionKeyCount: number;
  missingSessionKeyCount: number;
}> {
  const eventId = getEventId();

  try {
    const teamContext = await loadTeamContext(config.jsonPath, config.cacheTtl, caller);
    const { members } = teamContext;

    const resultMembers = members.map((member) => {
      const hasKey = Boolean(member.sessionKey && member.sessionKey.length > 0);
      return {
        name: member.name || member.agent_id,
        agentId: member.agent_id,
        hasSessionKey: hasKey,
        sessionKeyPreview: hasKey ? member.sessionKey.slice(0, 50) + "..." : null,
        authorityLevel: member.authority_level || null,
      };
    });

    const hasSessionKeyCount = resultMembers.filter(m => m.hasSessionKey).length;
    const missingSessionKeyCount = resultMembers.length - hasSessionKeyCount;

    info(caller, `[SHOW] team.json包含 ${members.length} 个成员, ${hasSessionKeyCount} 个已有sessionkey, ${missingSessionKeyCount} 个缺少`, eventId);

    return {
      success: true,
      members: resultMembers,
      total: members.length,
      hasSessionKeyCount,
      missingSessionKeyCount,
    };
  } catch (err: any) {
    error(caller, `[SHOW] ❌ 加载团队上下文失败: ${err.message}`, eventId);
    return {
      success: false,
      members: [],
      total: 0,
      hasSessionKeyCount: 0,
      missingSessionKeyCount: 0,
    };
  }
}

export async function batchCreateSessionKeys(
  config: BatchCreateSessionKeysConfig,
  request: BatchCreateSessionKeysRequest
): Promise<BatchCreateSessionKeysResponse> {
  const eventId = getEventId();
  const caller = "session-key-generator";

  info(caller, `[HTTP] 开始批量创建sessionkey, jsonPath=${config.jsonPath}`, eventId);

  let teamContext: TeamContext;
  try {
    teamContext = await loadTeamContext(config.jsonPath, config.cacheTtl, caller);
  } catch (err: any) {
    error(caller, `[HTTP] ❌ 加载团队上下文失败: ${err.message}`, eventId);
    return {
      success: false,
      message: `加载团队上下文失败: ${err.message}`,
      results: [],
      teamJsonPath: config.jsonPath,
      updated: 0,
      failed: 0,
      total: 0,
    };
  }

  const { projectRoot, members } = teamContext;
  const teamJsonPath = getTeamJsonPath(projectRoot);

  let teamData: any;
  try {
    teamData = await loadProjectTeamJson(projectRoot, config.cacheTtl);
  } catch (err: any) {
    error(caller, `[HTTP] ❌ 读取team.json失败: ${err.message}`, eventId);
    return {
      success: false,
      message: `读取team.json失败: ${err.message}`,
      results: [],
      teamJsonPath,
      updated: 0,
      failed: 0,
      total: 0,
    };
  }

  if (!Array.isArray(teamData.members)) {
    error(caller, `[HTTP] ❌ team.json中没有members数组`, eventId);
    return {
      success: false,
      message: "team.json中没有members数组",
      results: [],
      teamJsonPath,
      updated: 0,
      failed: 0,
      total: 0,
    };
  }

  const results: CreateSessionKeyResult[] = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of members) {
    if (!member.agent_id) continue;

    if (request.agentIds && request.agentIds.length > 0 && !request.agentIds.includes(member.agent_id)) {
      info(caller, `[HTTP] ⏭  跳过 ${member.agent_id} (不在指定列表中)`, eventId);
      results.push({
        success: true,
        agentId: member.agent_id,
        agentName: member.name || member.agent_id,
        oldSessionKey: member.sessionKey || null,
        newSessionKey: member.sessionKey || null,
      });
      skipped++;
      continue;
    }

    const hasSessionKey = Boolean(member.sessionKey && member.sessionKey.length > 0);
    if (hasSessionKey && !request.force) {
      info(caller, `[HTTP] ⏭  跳过 ${member.agent_id} (已有sessionkey: ${member.sessionKey.slice(0, 30)}...)`, eventId);
      results.push({
        success: true,
        agentId: member.agent_id,
        agentName: member.name || member.agent_id,
        oldSessionKey: member.sessionKey,
        newSessionKey: member.sessionKey,
      });
      skipped++;
      continue;
    }

    info(caller, `[HTTP] 🔄 为 ${member.agent_id} 创建sessionkey...`, eventId);
    const createResult = await createSessionKeyForAgent(member.agent_id, caller);

    if (createResult.success && createResult.sessionKey) {
      const oldSessionKey = member.sessionKey || null;
      
      const rawMember = teamData.members.find((m: any) => m.agent_id === member.agent_id);
      if (rawMember) {
        rawMember.sessionKey = createResult.sessionKey;
      }
      updated++;

      info(caller, `[HTTP] ✅ ${member.agent_id} 创建成功: ${createResult.sessionKey.slice(0, 50)}...`, eventId);
      results.push({
        success: true,
        agentId: member.agent_id,
        agentName: member.name || member.agent_id,
        oldSessionKey,
        newSessionKey: createResult.sessionKey,
      });
    } else {
      failed++;
      error(caller, `[HTTP] ❌ ${member.agent_id} 创建失败: ${createResult.error}`, eventId);
      results.push({
        success: false,
        agentId: member.agent_id,
        agentName: member.name || member.agent_id,
        oldSessionKey: member.sessionKey || null,
        newSessionKey: null,
        error: createResult.error,
      });
    }
  }

  let writeFailed = false;
  if (updated > 0) {
    // 统一走 writeTeamJson 单一出口：落盘后由 writeTeamJson 自动 syncTeamData，
    // 不再在此处手动同步（消除第二写路径的局部修订）
    const w = writeTeamJson(projectRoot, teamData);
    if (!w.ok) {
      error(caller, `[HTTP] ❌ 写入team.json失败: ${w.error ?? "unknown"}`, eventId);
      writeFailed = true;
    } else {
      info(caller, `[HTTP] ✅ team.json已更新（缓存由 writeTeamJson 自动同步）`, eventId);
    }
  }

  const message = `完成: 成功=${updated}, 跳过=${skipped}, 失败=${failed}, 总数=${members.length}`;
  info(caller, `[HTTP] ${message}`, eventId);

  return {
    success: failed === 0 && !writeFailed,
    message,
    results,
    teamJsonPath,
    updated,
    failed,
    total: members.length,
  };
}
