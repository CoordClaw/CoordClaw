/**
 * WebChat Widget - 后端 Handler
 *
 * 功能24: 提供 Widget 配置信息（WS 地址、可用 session 列表）
 *
 * 复用 shared/paths 的网关解析逻辑，复用 shared/team-loader 加载 session 信息。
 */

import { info, warn } from "../shared/logger";
import {
  resolveGatewayUrl,
} from "../shared/paths";
import {
  readActiveTeamJson,
  readOpenClawJson,
} from "../shared/config-store";
import type {
  WidgetConfigResponse,
  WidgetSessionInfo,
} from "./types";

const MODULE = "webchat-widget";

/** 解析 WS URL（从 HTTP URL 替换协议） */
function resolveWsUrl(httpUrl: string): string {
  try {
    const u = new URL(httpUrl);
    return `ws://${u.host}`;
  } catch {
    return "ws://127.0.0.1:28789";
  }
}

/** 尝试从当前激活项目的 team.json 加载 session 列表（单一真源：coordclaw.json active → resolveProjectRoot） */
async function loadSessionsFromTeamJson(): Promise<WidgetSessionInfo[]> {
  try {
    const teamData = await readActiveTeamJson();
    const members = teamData?.members || [];
    if (members.length === 0) return [];
    return members
      .filter((m: any) => m.sessionKey)
      .map((m: any) => ({
        sessionKey: m.sessionKey,
        agentId: m.agentId || m.id,
        displayName: m.displayName || m.name || m.agentId || m.id,
        role: m.role || "member",
      }));
  } catch {
    return [];
  }
}

/**
 * 从 openclaw.json 加载 Gateway Token（与 broadcast-v2/loadTokenFromRuntime 一致）
 */
function loadGatewayToken(): string | undefined {
  try {
    const content = readOpenClawJson();
    const token = content?.gateway?.auth?.token;
    if (token) return token;
    return undefined;
  } catch {
    return undefined;
  }
}

// ==================== 主入口 ====================

/**
 * 获取 Widget 配置
 *
 * 返回 Gateway WS/HTTP 地址 + 可用 session 列表，
 * 前端 SDK 用此信息建立 WebSocket 连接。
 */
export async function getWidgetConfig(): Promise<WidgetConfigResponse> {
  try {
    const httpUrl = resolveGatewayUrl();
    const wsUrl = resolveWsUrl(httpUrl);
    const sessions = await loadSessionsFromTeamJson();
    const token = loadGatewayToken();

    info(MODULE, `[CONFIG] httpUrl=${httpUrl}, wsUrl=${wsUrl}, sessions=${sessions.length}, hasToken=${!!token}`);

    return {
      success: true,
      wsUrl,
      httpUrl,
      token,
      sessions,
    };
  } catch (err: any) {
    warn(MODULE, `[CONFIG] 获取配置失败: ${err.message}`);
    return {
      success: false,
      wsUrl: "ws://127.0.0.1:28789",
      httpUrl: "http://127.0.0.1:28789",
      sessions: [],
      error: err.message,
    };
  }
}
