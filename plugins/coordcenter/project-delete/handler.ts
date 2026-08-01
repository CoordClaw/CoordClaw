/**
 * 删除项目核心逻辑
 *
 * 功能19: 基于 teamId + projectId 删除项目
 *
 * 流程：
 *   Step 1: 校验请求参数
 *   Step 2: 读取 coordclaw.json，定位团队及项目
 *   Step 3: 读取项目 .data/team.json，提取 members 及 sessionKeys
 *   Step 4: 遍历 members，调用 sessions.delete RPC 销毁会话
 *   Step 5: 从 coordclaw.json 中移除项目条目
 *   Step 6: 原子写入更新后的 coordclaw.json
 *   Step 7: 全量刷新缓存（三层缓存协调刷新）
 */

import fs from "fs";
import path from "path";
import { info, warn, error, getEventId } from "../shared/logger";
import {
  getCoordClawJsonPath,
  getTeamJsonPath,
  getCoordClawLogsDir,
  expandPath,
} from "../shared/paths";
import { fullReset } from "../shared/cache-coordinator";
import { writeJsonSafe, writeJsonSafeOrThrow } from "../shared/json-atomic";
import { readConfigRaw, readCoordClawJson, readTeamJson } from "../shared/config-store";
import type {
  DeleteProjectRequest,
  ProjectDeleteResult,
  SessionDeleteResult,
} from "./types";

const MODULE = "project-delete";

// ==================== 独立日志 ====================

let projectDeleteLogPath: string | null = null;

function getProjectDeleteLogPath(): string {
  if (!projectDeleteLogPath) {
    const logDir = getCoordClawLogsDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    projectDeleteLogPath = path.join(logDir, "project-delete.log");
  }
  return projectDeleteLogPath;
}

function writeProjectDeleteLog(msg: string): void {
  try {
    const logPath = getProjectDeleteLogPath();
    const line = `${new Date().toISOString()} [PROJECT-DELETE] ${msg}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (_) {
    // 日志写入失败不影响主流程
  }
}

// ==================== 辅助函数 ====================

/** 原子写入 JSON 文件 */
/** 调用 Gateway RPC 删除单个 session */
async function deleteSession(
  sessionKey: string,
  agentId: string
): Promise<{ success: boolean; error?: string }> {
  const eventId = getEventId();
  try {
    const { callGatewayRpc } = await import("../shared/gateway-rpc");

    const result = await callGatewayRpc({
      method: "sessions.delete",
      params: { key: sessionKey },
      timeoutMs: 10_000,
    });

    if (result && typeof result === "object" && result.ok === true) {
      info(MODULE, `[RPC] ${agentId} session 删除成功`, eventId);
      return { success: true };
    }

    warn(
      MODULE,
      `[RPC] ${agentId} 响应无效: ${JSON.stringify(result).slice(0, 200)}`,
      eventId
    );
    return {
      success: false,
      error: `Invalid response from sessions.delete: ${JSON.stringify(result).slice(0, 200)}`,
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    error(MODULE, `[RPC] ${agentId} session 删除失败: ${errMsg}`, eventId);
    return { success: false, error: errMsg };
  }
}

// ==================== 主入口 ====================

export async function deleteProject(
  req: DeleteProjectRequest
): Promise<ProjectDeleteResult> {
  const eventId = getEventId();
  const { teamId, projectId } = req;

  info(
    MODULE,
    `[DELETE] === PROJECT-DELETE START === teamId=${teamId} projectId=${projectId}`,
    eventId
  );
  writeProjectDeleteLog(
    `=== START === teamId=${teamId} projectId=${projectId}`
  );

  // ====== Step 1: 校验请求参数 ======
  if (!teamId || !projectId) {
    const errMsg = `缺少必填参数: teamId=${teamId} projectId=${projectId}`;
    warn(MODULE, `[Step1] ${errMsg}`, eventId);
    writeProjectDeleteLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  // ====== Step 2: 读取 coordclaw.json，定位团队及项目 ======
  const coordclawJsonPath = getCoordClawJsonPath();
  let coordclawData: any;
  let teamRecord: any;
  let projectRecord: any;
  let originalCoordClawRaw: string | null = null;

  try {
    const raw = readConfigRaw(coordclawJsonPath);
    originalCoordClawRaw = raw;
    coordclawData = readCoordClawJson();
    const teams = coordclawData.teams || [];
    teamRecord = teams.find((t: any) => t.id === teamId);
    if (!teamRecord) {
      const errMsg = `团队 "${teamId}" 未在 coordclaw.json 中注册`;
      warn(MODULE, `[Step2] ${errMsg}`, eventId);
      writeProjectDeleteLog(`FAIL: ${errMsg}`);
      return { success: false, message: errMsg, error: errMsg };
    }

    const projects = teamRecord.projects || [];
    projectRecord = projects.find((p: any) => p.id === projectId);
    if (!projectRecord) {
      const errMsg = `项目 "${projectId}" 未在团队 "${teamId}" 中注册`;
      warn(MODULE, `[Step2] ${errMsg}`, eventId);
      writeProjectDeleteLog(`FAIL: ${errMsg}`);
      return { success: false, message: errMsg, error: errMsg };
    }
  } catch (err: any) {
    const errMsg = `读取 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step2] ${errMsg}`, eventId);
    writeProjectDeleteLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  const projectPath = expandPath(projectRecord.root || "");
  info(
    MODULE,
    `[Step2] 定位成功: team=${teamRecord.name || teamId} project=${projectId} path=${projectPath}`,
    eventId
  );

  // ====== Step 3: 读取项目 .data/team.json，提取 members ======
  let members: any[] = [];
  try {
    const teamJsonPath = getTeamJsonPath(projectPath);
    if (fs.existsSync(teamJsonPath)) {
      const teamJson = readTeamJson(projectPath);
      members = Array.isArray(teamJson.members) ? teamJson.members : [];
    } else {
      warn(
        MODULE,
        `[Step3] team.json 不存在: ${teamJsonPath}，跳过 session 删除，继续移除 coordclaw.json 项目条目`,
        eventId
      );
      writeProjectDeleteLog(`SKIP: team.json 不存在，跳过 session 删除`);
    }
    info(MODULE, `[Step3] 提取到 ${members.length} 个成员`, eventId);
  } catch (err: any) {
    warn(
      MODULE,
      `[Step3] 读取 team.json 失败: ${err.message}，跳过 session 删除，继续移除 coordclaw.json 项目条目`,
      eventId
    );
    writeProjectDeleteLog(`SKIP: 读取 team.json 失败，跳过 session 删除`);
  }

  // ====== Step 4: 遍历 members，触发 sessions.delete RPC（fire-and-forget，不阻塞返回） ======
  const details: SessionDeleteResult[] = [];
  let sessionsDeleted = 0;

  for (const member of members) {
    const agentId = member.agent_id || "unknown";
    const agentName = member.name || agentId;
    const sessionKey = member.sessionKey || "";

    if (!sessionKey) {
      details.push({
        agentId,
        agentName,
        sessionKey: "",
        deleted: false,
        error: "team.json 中该成员未配置 sessionKey",
      });
      warn(MODULE, `[Step4] ${agentId} 无 sessionKey，跳过`, eventId);
      continue;
    }

    // fire-and-forget：仅触发删除，不 await，避免调用端因串行 RPC（每个最长 10s）长时间等待
    sessionsDeleted++;
    details.push({
      agentId,
      agentName,
      sessionKey,
      deleted: true,
      error: undefined,
    });

    deleteSession(sessionKey, agentId)
      .then((r) => {
        if (r.success) {
          info(MODULE, `[Step4] ${agentId} session 删除成功（后台）`, eventId);
        } else {
          warn(MODULE, `[Step4] ${agentId} session 删除失败（后台）: ${r.error}`, eventId);
        }
        writeProjectDeleteLog(`session delete ${agentId}: ${r.success ? "OK" : "FAIL " + (r.error || "")}`);
      })
      .catch((err: any) => {
        warn(MODULE, `[Step4] ${agentId} session 删除异常（后台）: ${err?.message || String(err)}`, eventId);
      });
  }

  info(
    MODULE,
    `[Step4] 已触发 ${sessionsDeleted}/${members.length} 个 session 删除（fire-and-forget，后台执行，不阻塞返回）`,
    eventId
  );
  writeProjectDeleteLog(
    `sessions delete triggered: ${sessionsDeleted}/${members.length} (fire-and-forget)`
  );

  // ====== Step 5: 从 coordclaw.json 中移除项目条目 ======
  try {
    const projects: any[] = teamRecord.projects || [];
    const idx = projects.findIndex((p: any) => p.id === projectId);
    if (idx !== -1) {
      projects.splice(idx, 1);
      teamRecord.projects = projects;
      info(
        MODULE,
        `[Step5] 已从 coordclaw.json 移除项目: ${projectId}`,
        eventId
      );
    } else {
      warn(
        MODULE,
        `[Step5] 项目 ${projectId} 在 coordclaw.json 中已不存在`,
        eventId
      );
    }
  } catch (err: any) {
    const errMsg = `从 coordclaw.json 移除项目失败: ${err.message}`;
    error(MODULE, `[Step5] ${errMsg}`, eventId);
    writeProjectDeleteLog(`FAIL: ${errMsg}`);
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      teamId,
      projectId,
      projectPath,
      sessionsDeleted,
      totalMembers: members.length,
      details,
    };
  }

  // ====== Step 6: 原子写入更新后的 coordclaw.json ======
  try {
    writeJsonSafeOrThrow(coordclawJsonPath, coordclawData, "[Step6] 写 coordclaw.json");
    info(MODULE, `[Step6] coordclaw.json 更新成功`, eventId);
    writeProjectDeleteLog(`coordclaw.json updated: removed ${projectId}`);
  } catch (err: any) {
    const errMsg = `写入 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step6] ${errMsg}`, eventId);
    writeProjectDeleteLog(`FAIL: ${errMsg}`);
    // 尝试回滚
    if (originalCoordClawRaw) {
      try {
        const rb = writeJsonSafe(coordclawJsonPath, JSON.parse(originalCoordClawRaw));
        if (!rb.ok) throw new Error(rb.error);
        warn(MODULE, `[Step6] coordclaw.json 已回滚`, eventId);
      } catch (rbErr: any) {
        error(MODULE, `[Step6] 回滚失败: ${rbErr.message}`, eventId);
      }
    }
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      teamId,
      projectId,
      projectPath,
      sessionsDeleted,
      totalMembers: members.length,
      details,
    };
  }

  // ====== Step 7: 全量重建缓存（六层协调） ======
  try {
    const resetResult = await fullReset();
    info(MODULE, `[Step7] ${resetResult.message}`, eventId);
    writeProjectDeleteLog(`cache fullReset: ${resetResult.message}`);
  } catch (err: any) {
    const errMsg = `缓存重建失败: ${err.message}`;
    warn(MODULE, `[Step7] ${errMsg}`, eventId);
    writeProjectDeleteLog(`WARN: ${errMsg}`);
    // 缓存重建失败不影响删除成功的主流程
  }

  // ====== 完成 ======
  const message = `项目 ${projectId} 删除成功: ${sessionsDeleted}/${members.length} 个 session 已销毁`;
  info(MODULE, `[DELETE] === DONE === ${message}`, eventId);
  writeProjectDeleteLog(`=== DONE === ${message}`);

  return {
    success: true,
    message,
    teamId,
    projectId,
    projectPath,
    sessionsDeleted,
    totalMembers: members.length,
    details,
  };
}
