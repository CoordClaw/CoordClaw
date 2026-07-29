/**
 * 功能模块：sessionKey 白名单校验（session-whitelist handler）

 * 负责 before_tool_call 信号中的 sessions_send 白名单校验：
 * 检查目标 sessionKey 是否在 team.json 的 members 列表中
 */

import { info, warn, getEventId } from "../shared/logger";
import {
  extractSessionKeys,
} from "../prompt-injection";
import { loadTeamContext } from "../shared/team-loader";

export interface SessionWhitelistConfig {
  jsonPath: string;
  cacheTtl: number;
}

/**
 * 校验 sessionKey 是否在白名单中
 */
async function checkSessionKeyWhitelist(
  sessionKey: string,
  config: SessionWhitelistConfig
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const { members } = await loadTeamContext(config.jsonPath, config.cacheTtl, "session-whitelist");
    const sessionKeySet = extractSessionKeys(members);
    if (!sessionKeySet.has(sessionKey)) {
      return { allowed: false, reason: "ERR_SESSION_KEY_NOT_IN_WHITELIST: 请从项目 team.json 的 members[].sessionKey 获取正确值" };
    }
    return { allowed: true };
  } catch (err: any) {
    warn('session-whitelist', `[FUNC: checkSessionKeyWhitelist] 配置加载异常，拒绝会话: ${err.message}`, getEventId());
    return { allowed: false, reason: "ERR_CONFIG_LOAD_FAILED: 无法加载 team.json 配置" };
  }
}

/**
 * 处理 before_tool_call 信号中的白名单校验
 * 返回 undefined 表示放行，返回 block 对象表示拦截
 */
export async function handleSessionWhitelist(
  toolName: string,
  params: Record<string, unknown> | undefined,
  config: SessionWhitelistConfig
): Promise<{ block: boolean; blockReason?: string } | undefined> {
  if (toolName !== "sessions_send") return undefined;

  const sessionKey = (params?.sessionKey as string) || "";
  if (!sessionKey) return undefined;

  const check = await checkSessionKeyWhitelist(sessionKey, config);
  if (!check.allowed) {
    warn('session-whitelist', `[FUNC: handleSessionWhitelist] sessionKey=${sessionKey.slice(0, 16)}... BLOCKED: ${check.reason}`, getEventId());
    return { block: true, blockReason: check.reason };
  }
  return undefined;
}