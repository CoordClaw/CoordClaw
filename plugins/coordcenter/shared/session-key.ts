/**
 * SessionKey 创建 / 存在性检查 / 对账（L0 共享原语）
 *
 * 单一真相源：project-create（创建项目时）与 session-key reconcile
 * （启动 / 切换 / 删队激活转移时）共用同一套创建与存在性检查逻辑，避免私有副本分叉。
 */

import fs from "fs";
import path from "path";
import { info, warn, error, getEventId } from "./logger";
import { getTeamJsonPath, getOpenClawUserDir } from "./paths";
import { readTeamJson, writeTeamJson } from "./config-store";
import { getSessionApi } from "./session-api";

const MODULE = "session-key";

// ==================== SessionKey 创建（复用自 project-create/handler.ts:143-170） ====================

export async function createSessionKeyForAgent(
  agentId: string,
  label?: string,
  caller: string = "session-key"
): Promise<{ success: boolean; sessionKey?: string; error?: string }> {
  const eventId = getEventId();
  try {
    const { callGatewayRpc } = await import("./gateway-rpc");

    const result = await callGatewayRpc({
      method: "sessions.create",
      params: { agentId, label },
      timeoutMs: 10_000,
    });

    if (result && typeof result === "object" && result.key) {
      info(caller, `[RPC] ${agentId} sessionKey 创建成功`, eventId);
      return { success: true, sessionKey: result.key as string };
    }

    warn(caller, `[RPC] ${agentId} 响应无效: ${JSON.stringify(result).slice(0, 200)}`, eventId);
    return { success: false, error: "Invalid response from sessions.create" };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    error(caller, `[RPC] ${agentId} sessionKey 创建失败: ${errMsg}`, eventId);
    return { success: false, error: errMsg };
  }
}

// ==================== 存在性检查（以 Gateway 为唯一真相源，零网络本地读） ====================

function resolveSessionDir(agentId: string): string {
  return path.join(getOpenClawUserDir(), "agents", agentId, "sessions");
}

/**
 * 检查 sessionKey 是否在 Gateway 真实存在（含 phantom 守卫）。
 * 复用 token-stats/pool.ts:155-158 的 L1 逻辑：getSessionEntry 返回 sessionFile 绝对/相对路径，
 * 再加 fs.existsSync 防"entry 残留但文件被 prune"的 phantom 情况。
 */
function sessionKeyExistsOnGateway(sessionKey: string, agentId: string): boolean {
  try {
    const e = getSessionApi()?.getSessionEntry?.({ sessionKey });
    if (e?.sessionFile) {
      const p = path.isAbsolute(e.sessionFile)
        ? e.sessionFile
        : path.join(resolveSessionDir(agentId), e.sessionFile);
      return fs.existsSync(p);
    }
  } catch {}
  return false;
}

// ==================== 对账（逐成员、只补缺失） ====================

/**
 * 对账指定激活项目的所有成员 sessionKey：
 *   - 本地 key 为空  → 缺失，补建
 *   - Gateway 查无   → 僵尸 key，重建（sessionKeyExistsOnGateway 含 phantom 守卫）
 *   - 否则跳过（健康成员零触碰）
 * 仅当确有成员被补建时才原子写回 team.json。
 *
 * 防呆（fail-open，不毁 key）：api 未注入 / team.json 不存在 / 解析失败时直接返回。
 */
export async function reconcileProjectSessionKeys(projectRoot: string): Promise<void> {
  if (!getSessionApi()) return; // V1：api 未注入绝不误重建

  const teamJsonPath = getTeamJsonPath(projectRoot); // paths.ts:365，TEAM_JSON_FILENAME=".data/team.json"
  if (!fs.existsSync(teamJsonPath)) return; // V8：readTeamJson 对缺文件抛错，先守卫

  let teamJson: any;
  try {
    teamJson = readTeamJson(projectRoot);
  } catch {
    return;
  }

  const members: any[] = teamJson.members ?? [];
  let changed = false;

  for (const m of members) {
    const agentId = m.agent_id; // snake（project-create:346）
    const key = m.sessionKey; // camel（project-create:395 / session-whitelist）
    if (!agentId) continue; // V5：宽容跳过，不整体失败

    if (key && sessionKeyExistsOnGateway(key, agentId)) continue; // 两层：本地有 + Gateway 真在

    const r = await createSessionKeyForAgent(agentId, teamJson.project_name || "reconcile", "session-key-reconcile");
    if (r.success && r.sessionKey) {
      m.sessionKey = r.sessionKey;
      changed = true;
    }
  }

  if (changed) {
    writeTeamJson(projectRoot, teamJson); // V4：语义化封装（底层 writeJsonSafe 原子+重试）
  }
}
