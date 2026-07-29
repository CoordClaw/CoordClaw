import { info, error, warn, getEventId } from "../shared/logger";
import { callGatewayRpc } from "../shared/gateway-rpc";
import { loadTeamContext } from "../shared/team-loader";
import { updateSessionRecord } from "../message-routing/cache/manager";

export interface AbortResult {
  success: boolean;
  message: string;
  sessionKey: string;
}

export interface AbortMemberResult {
  name: string;
  agentId: string;
  sessionKey: string;
  aborted: boolean;
  error?: string;
}

export interface AbortAllResult {
  success: boolean;
  message: string;
  abortCount: number;
  totalMembers: number;
  details: AbortMemberResult[];
}

export interface AbortDebugResult {
  success: boolean;
  message: string;
  sessionKey: string;
  rpcResponse: any;
  abortedRunId: string | null;
  abortStatus: "aborted" | "no-active-run" | "unknown";
  abortedMarked: boolean;
  timestamp: string;
}

export async function abortSession(sessionKey: string): Promise<AbortResult> {
  if (!sessionKey || typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    warn("session-abort", `[ABORT] sessionKey 为空`, getEventId());
    return { success: false, message: "sessionKey 不能为空", sessionKey: sessionKey || "" };
  }

  const sessionKeyPreview = sessionKey.slice(0, 50);
  info("session-abort", `[ABORT] 正在停止会话 sessionKey=${sessionKeyPreview}`, getEventId());

  try {
    await callGatewayRpc({
      method: "sessions.abort",
      params: { key: sessionKey },
      timeoutMs: 10_000,
    });
    info("session-abort", `[ABORT] 会话已停止 sessionKey=${sessionKeyPreview}`, getEventId());
    return { success: true, message: `会话 ${sessionKeyPreview} 已停止`, sessionKey };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    error("session-abort", `[ABORT] 停止失败 sessionKey=${sessionKeyPreview}: ${errMsg}`, getEventId());
    return { success: false, message: `停止失败: ${errMsg}`, sessionKey };
  }
}

export async function abortAllTeamSessions(
  jsonPath: string,
  cacheTtl: number
): Promise<AbortAllResult> {
  const eventId = getEventId();
  info("session-abort", `[ABORT-ALL] === START === jsonPath=${jsonPath}`, eventId);

  try {
    const { members } = await loadTeamContext(jsonPath, cacheTtl, "session-abort");

    if (members.length === 0) {
      return {
        success: false,
        message: "team.json 中没有有效成员",
        abortCount: 0,
        totalMembers: 0,
        details: [],
      };
    }

    const details: AbortMemberResult[] = [];
    let abortCount = 0;

    for (const member of members) {
      const sessionKey = member.sessionKey;

      if (!sessionKey) {
        details.push({
          name: member.name,
          agentId: member.agent_id,
          sessionKey: "",
          aborted: false,
          error: "team.json 中该成员未配置 sessionKey",
        });
        continue;
      }

      const sessionKeyPreview = sessionKey.slice(0, 50);
      info("session-abort", `[ABORT-ALL] 正在停止 ${member.name} (${member.agent_id}) sessionKey=${sessionKeyPreview}`, eventId);

      const result = await abortSession(sessionKey);
      details.push({
        name: member.name,
        agentId: member.agent_id,
        sessionKey,
        aborted: result.success,
        error: result.success ? undefined : result.message,
      });
      if (result.success) abortCount++;
    }

    info("session-abort", `[ABORT-ALL] 完成: 成功 ${abortCount}/${details.length}`, eventId);

    return {
      success: abortCount > 0,
      message: `成功中止 ${abortCount} 个会话 (共 ${members.length} 成员)`,
      abortCount,
      totalMembers: members.length,
      details,
    };
  } catch (err: any) {
    error("session-abort", `[ABORT-ALL] 失败: ${err.message}\n${err.stack}`, eventId);
    return {
      success: false,
      message: `全部中止失败: ${err.message}`,
      abortCount: 0,
      totalMembers: 0,
      details: [],
    };
  }
}

export async function abortSessionDebug(sessionKey: string): Promise<AbortDebugResult> {
  const eventId = getEventId();
  const timestamp = new Date().toISOString();
  const sessionKeyPreview = sessionKey.slice(0, 50);

  if (!sessionKey || typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    warn("session-abort-debug", `[DEBUG] sessionKey 为空`, eventId);
    return {
      success: false,
      message: "sessionKey 不能为空",
      sessionKey: sessionKey || "",
      rpcResponse: null,
      abortedRunId: null,
      abortStatus: "unknown",
      abortedMarked: false,
      timestamp,
    };
  }

  info("session-abort-debug", `[DEBUG] === START === sessionKey=${sessionKeyPreview}`, eventId);

  let rpcResponse: any = null;
  let abortedRunId: string | null = null;
  let abortStatus: "aborted" | "no-active-run" | "unknown" = "unknown";
  let abortedMarked = false;

  try {
    rpcResponse = await callGatewayRpc({
      method: "sessions.abort",
      params: { key: sessionKey },
      timeoutMs: 10_000,
    });

    info("session-abort-debug", `[DEBUG] RPC 原始返回: ${JSON.stringify(rpcResponse)}`, eventId);

    if (rpcResponse && typeof rpcResponse === 'object') {
      abortedRunId = rpcResponse.abortedRunId ?? rpcResponse.runId ?? null;
      abortStatus = (rpcResponse.status === "aborted" || abortedRunId) ? "aborted"
        : (rpcResponse.status === "no-active-run") ? "no-active-run"
        : "unknown";
    }

    if (abortStatus === "aborted") {
      abortedMarked = false;
      info("session-abort-debug", `[DEBUG] ✅ 真正中止了 run, abortedRunId=${abortedRunId}, 已跳过设置 aborted 标记`, eventId);
    } else {
      info("session-abort-debug", `[DEBUG] ⚠️ 未中止任何 run, status=${abortStatus}, abortedRunId=${abortedRunId}, 不设置 aborted 标记`, eventId);
    }

    return {
      success: true,
      message: abortStatus === "aborted"
        ? `会话 ${sessionKeyPreview} 已中止 (runId=${abortedRunId})`
        : `会话 ${sessionKeyPreview} 未中止活跃运行 (${abortStatus})`,
      sessionKey,
      rpcResponse,
      abortedRunId,
      abortStatus,
      abortedMarked,
      timestamp,
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    error("session-abort-debug", `[DEBUG] RPC 调用异常: ${errMsg}`, eventId);
    return {
      success: false,
      message: `RPC 异常: ${errMsg}`,
      sessionKey,
      rpcResponse: { _error: errMsg },
      abortedRunId: null,
      abortStatus: "unknown",
      abortedMarked: false,
      timestamp,
    };
  }
}