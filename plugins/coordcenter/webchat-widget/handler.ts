/**
 * WebChat Widget - 后端 Handler
 *
 * 功能24: 提供 Widget 配置信息（WS 地址、可用 session 列表）
 *
 * 复用 shared/paths 的网关解析逻辑，复用 shared/team-loader 加载 session 信息。
 */

import fs from "fs";
import path from "path";
import { info, warn } from "../shared/logger";
import {
  getOpenClawUserDir,
  resolveGatewayUrl,
} from "../shared/paths";
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

/** 尝试从 team.json 加载 session 列表 */
function loadSessionsFromTeamJson(): WidgetSessionInfo[] {
  try {
    // 遍历可能的 team.json 路径
    const candidates = [
      path.join(process.cwd(), ".data", "team.json"),
      path.join(process.cwd(), "team.json"),
    ];

    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      const members = data?.members || [];
      if (members.length > 0) {
        return members
          .filter((m: any) => m.sessionKey)
          .map((m: any) => ({
            sessionKey: m.sessionKey,
            agentId: m.agentId || m.id,
            displayName: m.displayName || m.name || m.agentId || m.id,
            role: m.role || "member",
          }));
      }
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * 从 openclaw.json 加载 Gateway Token（与 broadcast-v2/loadTokenFromRuntime 一致）
 */
function loadGatewayToken(): string | undefined {
  try {
    // 单一真源：宿主运行时注入的用户目录（与网关保持一致，避免 ~/.qclaw 分歧）
    const userDir = getOpenClawUserDir();
    if (userDir) {
      const configPath = path.join(userDir, "openclaw.json");
      if (fs.existsSync(configPath)) {
        const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const token = content?.gateway?.auth?.token;
        if (token) return token;
      }
    }

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
export function getWidgetConfig(): WidgetConfigResponse {
  try {
    const httpUrl = resolveGatewayUrl();
    const wsUrl = resolveWsUrl(httpUrl);
    const sessions = loadSessionsFromTeamJson();
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
