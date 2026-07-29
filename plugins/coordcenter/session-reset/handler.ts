/**
 * 功能模块：会话重置（session-reset handler）
 *
 * 通过动态导入 OpenClaw 内部的 performGatewaySessionReset 函数，
 * 直接清除所有团队成员的 AI 会话上下文（等同于 /reset 命令）。
 *
 * 不使用 Gateway RPC，因为本地连接没有设备身份时 operator.admin scope 会被清除。
 * 详细分析见 server-D2GasoUS.js L26740-L26789 的 clearUnboundScopes / handleMissingDeviceIdentity。
 */

import { info, error, warn, getEventId } from "../shared/logger";
import { loadTeamContext, TeamMember } from "../shared/team-loader";
import { getOpenClawResetModule } from "../shared/paths";

export interface MemberResetResult {
  name: string;
  agentId: string;
  sessionKey: string;
  reset: boolean;
  error?: string;
}

export interface SessionResetResult {
  success: boolean;
  message: string;
  resetCount: number;
  totalMembers: number;
  details: MemberResetResult[];
}

/**
 * 重置单个会话（通过 sessionKey）
 */
const resettingPromises = new Map<string, Promise<void>>();

/** 带等待守卫的 reset：dispatch 前 await getResettingPromise 可防止 session 文件冲突 */
export function resetWithGuard(sessionKey: string): Promise<void> {
  const promise = resetSingleSession(sessionKey)
    .then(() => {})
    .finally(() => resettingPromises.delete(sessionKey));
  resettingPromises.set(sessionKey, promise);
  return promise;
}

/** 返回正在执行的 reset Promise（null 表示没有进行中的 reset） */
export function getResettingPromise(sessionKey: string): Promise<void> | undefined {
  return resettingPromises.get(sessionKey);
}

export async function resetSingleSession(sessionKey: string): Promise<SessionResetResult> {
  const eventId = getEventId();
  info("session-reset", `[RESET-SINGLE] === START === sessionKey=${sessionKey.slice(0, 50)}...`, eventId);

  try {
    const resetModulePath = getOpenClawResetModule();
    info("session-reset", `[PATH] 使用动态解析的 reset 模块: ${resetModulePath}`, eventId);
    const { performGatewaySessionReset } = await import(resetModulePath);

    const result = await performGatewaySessionReset({
      key: sessionKey,
      reason: "reset",
      commandSource: "coordclawcenter:session-reset:single",
    });

    const ok = result?.ok === true;
    info(
      "session-reset",
      `[RESET-SINGLE] ${ok ? "OK" : "FAIL"} result=${JSON.stringify(result).slice(0, 100)}`,
      eventId
    );

    return {
      success: ok,
      message: ok ? "成功重置指定会话" : `重置失败: ${JSON.stringify(result).slice(0, 100)}`,
      resetCount: ok ? 1 : 0,
      totalMembers: 1,
      details: [{
        name: "single",
        agentId: "single",
        sessionKey,
        reset: ok,
        error: ok ? undefined : `performGatewaySessionReset 返回异常: ${JSON.stringify(result).slice(0, 100)}`,
      }],
    };
  } catch (err: any) {
    error("session-reset", `[RESET-SINGLE] 失败: ${err.message}\n${err.stack}`, eventId);
    return {
      success: false,
      message: `重置失败: ${err.message}`,
      resetCount: 0,
      totalMembers: 1,
      details: [{
        name: "single",
        agentId: "single",
        sessionKey,
        reset: false,
        error: err.message,
      }],
    };
  }
}

export async function resetAllTeamSessions(
  jsonPath: string,
  cacheTtl: number,
  targetSessionKey?: string
): Promise<SessionResetResult> {
  const eventId = getEventId();
  info("session-reset", `[RESET] === START === jsonPath=${jsonPath}`, eventId);

  try {
    const { members } = await loadTeamContext(jsonPath, cacheTtl, "session-reset");

    if (members.length === 0) {
      return {
        success: false,
        message: "team.json 中没有有效成员(agentId 为空)",
        resetCount: 0,
        totalMembers: 0,
        details: [],
      };
    }

    const resetModulePath = getOpenClawResetModule();
    info("session-reset", `[PATH] 使用动态解析的 reset 模块: ${resetModulePath}`, eventId);
    const { performGatewaySessionReset } = await import(resetModulePath);

    const details: MemberResetResult[] = [];
    let resetCount = 0;

    for (const member of members) {
      const sessionKey = member.sessionKey;

      // 如果指定了 targetSessionKey，只处理匹配的会话
      if (targetSessionKey && sessionKey !== targetSessionKey) {
        continue;
      }

      if (!sessionKey) {
        details.push({
          name: member.name,
          agentId: member.agent_id,
          sessionKey: "",
          reset: false,
          error: "team.json 中该成员未配置 sessionKey",
        });
        continue;
      }

      const sessionKeyPreview = sessionKey.slice(0, 50);
      info(
        "session-reset",
        `[RESET] 正在重置 ${member.name} (${member.agent_id}) sessionKey=${sessionKeyPreview}...`,
        getEventId()
      );

      try {
        const result = await performGatewaySessionReset({
          key: sessionKey,
          reason: "reset",
          commandSource: "coordclawcenter:session-reset",
        });

        const ok = result?.ok === true;
        details.push({
          name: member.name,
          agentId: member.agent_id,
          sessionKey,
          reset: ok,
          error: ok
            ? undefined
            : `performGatewaySessionReset 返回异常: ${JSON.stringify(result).slice(0, 100)}`,
        });
        if (ok) resetCount++;
        info(
          "session-reset",
          `[RESET] ${member.name}: ${ok ? "OK" : "FAIL"} result=${JSON.stringify(result).slice(0, 100)}`,
          getEventId()
        );
      } catch (err: any) {
        details.push({
          name: member.name,
          agentId: member.agent_id,
          sessionKey,
          reset: false,
          error: err.message,
        });
        warn(
          "session-reset",
          `[RESET] ${member.name}: 重置失败: ${err.message}`,
          getEventId()
        );
      }
    }

    info("session-reset", `[RESET] 完成: 成功 ${resetCount}/${details.length}`, getEventId());

    return {
      success: resetCount > 0,
      message: `成功重置 ${resetCount} 个会话 (共 ${members.length} 成员)`,
      resetCount,
      totalMembers: members.length,
      details,
    };
  } catch (err: any) {
    error("session-reset", `[RESET] 失败: ${err.message}\n${err.stack}`, getEventId());
    return {
      success: false,
      message: `重置失败: ${err.message}`,
      resetCount: 0,
      totalMembers: 0,
      details: [],
    };
  }
}