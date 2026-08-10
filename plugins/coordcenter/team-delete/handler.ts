/**
 * 删除团队核心逻辑
 *
 * 功能21: 基于 teamId 删除团队（含成员清理 + 配置注销）
 *
 * 流程：
 *   Step 1: 校验请求参数
 *   Step 2: 读取 coordclaw.json，定位团队条目
 *   Step 3: 从团队 .data/team.json 提取成员 agent_id 列表
 *   Step 4: 从 openclaw.json 中移除对应 agents
 *   Step 5: 从 coordclaw.json 中移除团队注册
 *   Step 6: 原子写入更新后的配置文件
 */

import fs from "fs";
import path from "path";
import { info, warn, error, getEventId } from "../shared/logger";
import {
  getCoordClawJsonPath,
  getOpenClawJsonPath,
  getTeamDataDir,
  getCoordClawLogsDir,
} from "../shared/paths";
import {
  removeAgentWorkspace,
  removeFromAutoClawCompat,
  removeFromLobsterAIDB,
} from "../shared/agent-artifacts";
import { writeJsonSafe, writeFileWithRetry } from "../shared/json-atomic";
import { readConfigRaw, readCoordClawJson, readOpenClawJson, readTeamJsonByTeam } from "../shared/config-store";
import { reconcileProjectSessionKeys } from "../shared/session-key";
import type {
  DeleteTeamRequest,
  TeamDeleteResult,
  AgentDeleteResult,
} from "./types";

const MODULE = "team-delete";

// ==================== 独立日志 ====================

let teamDeleteLogPath: string | null = null;

function getTeamDeleteLogPath(): string {
  if (!teamDeleteLogPath) {
    const logDir = getCoordClawLogsDir();
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    teamDeleteLogPath = path.join(logDir, "team-delete.log");
  }
  return teamDeleteLogPath;
}

function writeTeamDeleteLog(msg: string): void {
  try {
    const line = `${new Date().toISOString()} [TEAM-DELETE] ${msg}\n`;
    fs.appendFileSync(getTeamDeleteLogPath(), line, "utf-8");
  } catch (_) {}
}

// ==================== 辅助函数 ====================

/** 写入 JSON 文件（优先原子写入，EPERM 时回退到直接覆盖） */
// ==================== 主入口 ====================

export async function deleteTeam(
  req: DeleteTeamRequest
): Promise<TeamDeleteResult> {
  const eventId = getEventId();
  const { teamId } = req;

  info(MODULE, `[DELETE] === TEAM-DELETE START === teamId=${teamId}`, eventId);
  writeTeamDeleteLog(`=== START === teamId=${teamId}`);

  // ====== Step 1: 校验请求参数 ======
  if (!teamId) {
    const errMsg = "缺少必填参数 teamId";
    warn(MODULE, `[Step1] ${errMsg}`, eventId);
    writeTeamDeleteLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  // ====== Step 2: 读取 coordclaw.json，定位团队条目 ======
  const coordclawJsonPath = getCoordClawJsonPath();
  let coordclawData: any;
  let teamRecord: any;
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
      writeTeamDeleteLog(`FAIL: ${errMsg}`);
      return { success: false, message: errMsg, error: errMsg };
    }
  } catch (err: any) {
    const errMsg = `读取 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step2] ${errMsg}`, eventId);
    writeTeamDeleteLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  const teamName = teamRecord.name || teamId;
  info(
    MODULE,
    `[Step2] 定位成功: teamId=${teamId} name=${teamName}`,
    eventId
  );

  // ====== Step 3: 合并成员 agent_id 列表（team.json 成员 ∪ coordclaw teamRecord.agents） ======
  let memberAgentIds: string[] = [];
  try {
    const teamDataDir = getTeamDataDir(teamId);
    const teamJsonPath = path.join(teamDataDir, "team.json");

    const fromTeamJson: string[] = [];
    if (fs.existsSync(teamJsonPath)) {
      const teamJson = readTeamJsonByTeam(teamId);
      const members = Array.isArray(teamJson.members) ? teamJson.members : [];
      for (const m of members) {
        const aid = m.agent_id || "";
        if (aid) fromTeamJson.push(aid);
      }
    } else {
      writeTeamDeleteLog(`WARN: 团队 team.json 不存在: ${teamJsonPath}，回退 coordclaw.agents`);
    }

    // V30: 并集去重，幂等更安全；agentId 全局唯一，不会误伤别的 team
    const fromCoord = Array.isArray(teamRecord.agents) ? teamRecord.agents : [];
    memberAgentIds = [...new Set([...fromTeamJson, ...fromCoord])].filter(Boolean);

    if (memberAgentIds.length > 0) {
      info(
        MODULE,
        `[Step3] 合并得到 ${memberAgentIds.length} 个成员 agent_id (team.json=${fromTeamJson.length}, coordclaw=${fromCoord.length})`,
        eventId
      );
    } else {
      warn(
        MODULE,
        `[Step3] team.json 与 coordclaw.agents 均无成员，将跳过 agent 产物清理`,
        eventId
      );
      writeTeamDeleteLog(`WARN: 无成员 agent_id，跳过 agent 产物清理`);
    }
  } catch (err: any) {
    warn(
      MODULE,
      `[Step3] 读取成员失败: ${err.message}，将跳过 agent 产物清理`,
      eventId
    );
    writeTeamDeleteLog(`WARN: 读取成员失败，跳过 agent 产物清理`);
  }

  // ====== Step 4: 从 openclaw.json 中移除对应 agents ======
  const openclawJsonPath = getOpenClawJsonPath();
  let openclawData: any;
  let originalOpenclawRaw: string | null = null;
  let details: AgentDeleteResult[] = [];
  let agentsRemoved = 0;

  try {
    const raw = readConfigRaw(openclawJsonPath);
    originalOpenclawRaw = raw;
    openclawData = readOpenClawJson();

    const agentList = openclawData.agents?.list || [];
    const targetIds = new Set(memberAgentIds);

    // 遍历当前 openclaw.json agents.list，匹配目标 agent_id 并移除
    const remaining: any[] = [];
    for (const agent of agentList) {
      const aid = agent.id || "";
      if (targetIds.has(aid)) {
        details.push({
          agentId: aid,
          name: agent.name || aid,
          removed: true,
        });
        info(MODULE, `[Step4] 标记移除 agent: id=${aid} name=${agent.name}`, eventId);
      } else {
        remaining.push(agent);
      }
    }

    agentsRemoved = details.length;
    openclawData.agents.list = remaining;

    info(
      MODULE,
      `[Step4] openclaw.json agents 处理完成: 移除=${agentsRemoved} 保留=${remaining.length}`,
      eventId
    );
  } catch (err: any) {
    const errMsg = `处理 openclaw.json agents 失败: ${err.message}`;
    error(MODULE, `[Step4] ${errMsg}`, eventId);
    writeTeamDeleteLog(`FAIL: ${errMsg}`);
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      teamId,
      teamName,
      details,
    };
  }

  // ====== Step 5: 从 coordclaw.json 中移除团队注册 ======
  let hadActiveProject = false;
  let activationTransfer: { activatedProjectId?: string; activatedTeamId?: string; message: string } | null = null;

  try {
    const teams: any[] = coordclawData.teams || [];
    const idx = teams.findIndex((t: any) => t.id === teamId);
    if (idx !== -1) {
      const removedTeam = teams[idx];

      // 检查被删除团队是否有激活状态的项目
      const removedProjects: any[] = removedTeam.projects || [];
      for (const p of removedProjects) {
        if (p.status === "active") {
          hadActiveProject = true;
          info(MODULE, `[Step5] 被删除团队包含激活项目: ${p.id}`, eventId);
          break;
        }
      }

      teams.splice(idx, 1);
      coordclawData.teams = teams;
      info(
        MODULE,
        `[Step5] 已从 coordclaw.json 移除团队: ${teamId}`,
        eventId
      );
    } else {
      warn(
        MODULE,
        `[Step5] 团队 ${teamId} 在 coordclaw.json 中已不存在`,
        eventId
      );
    }

    // 如果被删除团队有激活项目，需要将激活状态转移到剩余团队的第一个项目
    if (hadActiveProject) {
      const remainingTeams: any[] = coordclawData.teams || [];

      // 先将所有剩余项目的 status 设为非激活
      for (const rt of remainingTeams) {
        const projs: any[] = rt.projects || [];
        for (const p of projs) {
          if (p.status === "active") p.status = "inactive";
        }
      }

      // 找到第一个剩余团队的第一个项目，设为激活
      let transferred = false;
      for (const rt of remainingTeams) {
        const projs: any[] = rt.projects || [];
        if (projs.length > 0) {
          projs[0].status = "active";
          activationTransfer = {
            activatedProjectId: projs[0].id,
            activatedTeamId: rt.id,
            message: `激活状态已转移: ${rt.id}/${projs[0].id}`,
          };
          info(
            MODULE,
            `[Step5] 激活状态转移 → 团队=${rt.id} 项目=${projs[0].id} (status=active)`,
            eventId
          );
          transferred = true;
          break;
        }
      }

      if (!transferred) {
        activationTransfer = { message: "无剩余项目可激活" };
        warn(MODULE, `[Step5] 所有团队均无项目，无法转移激活状态`, eventId);
      }
    }
  } catch (err: any) {
    const errMsg = `从 coordclaw.json 移除团队失败: ${err.message}`;
    error(MODULE, `[Step5] ${errMsg}`, eventId);
    writeTeamDeleteLog(`FAIL: ${errMsg}`);
    // 回滚 openclaw.json
    if (originalOpenclawRaw) {
      try {
        writeFileWithRetry(openclawJsonPath, originalOpenclawRaw);
        warn(MODULE, `[Step5] openclaw.json 已回滚`, eventId);
      } catch (rbErr: any) {
        error(MODULE, `[Step5] 回滚 openclaw.json 失败: ${rbErr.message}`, eventId);
      }
    }
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      teamId,
      teamName,
      agentsRemoved,
      totalAgents: memberAgentIds.length,
      details,
    };
  }

  // ====== Step 6: 写入两个配置文件（EPERM 时自动回退到直接覆盖） ======

  // 6a: 写入 openclaw.json
  const ocResult = writeJsonSafe(openclawJsonPath, openclawData);
  if (!ocResult.ok) {
    const errMsg = `写入 openclaw.json 失败: ${ocResult.error}`;
    error(MODULE, `[Step6a] ${errMsg}`, eventId);
    writeTeamDeleteLog(`FAIL: ${errMsg}`);
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      teamId,
      teamName,
      agentsRemoved: 0,
      totalAgents: memberAgentIds.length,
      details,
    };
  }
  info(MODULE, `[Step6a] openclaw.json 写入成功 (agents 移除=${agentsRemoved})`, eventId);
  writeTeamDeleteLog(`openclaw.json updated: removed ${agentsRemoved} agents`);

  // 6b: 写入 coordclaw.json
  const ccResult = writeJsonSafe(coordclawJsonPath, coordclawData);
  if (!ccResult.ok) {
    const errMsg = `写入 coordclaw.json 失败: ${ccResult.error}`;
    error(MODULE, `[Step6b] ${errMsg}`, eventId);
    writeTeamDeleteLog(`FAIL: ${errMsg}`);
    // openclaw.json 已写入了但 coordclaw.json 失败，回滚 openclaw.json
    if (originalOpenclawRaw) {
      try { writeFileWithRetry(openclawJsonPath, originalOpenclawRaw); } catch {}
      warn(MODULE, `[Step6b] openclaw.json 已回滚（coordclaw 写入失败）`, eventId);
    }
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      teamId,
      teamName,
      agentsRemoved: 0,
      totalAgents: memberAgentIds.length,
      details,
    };
  }
  info(MODULE, `[Step6b] coordclaw.json 写入成功 (团队 ${teamId} 已移除)`, eventId);
  writeTeamDeleteLog(`coordclaw.json updated: removed team ${teamId}`);

  // ====== Step 7: 清理 agent 级运行时产物（registry 已提交后 best-effort，与注册侧对称） ======
  // 包含 workspace-<id> / AutoClaw settings+runtime / LobsterAI agents。
  // worklog 与 .data 源文件属团队配置内容，保留给用户后悔，不在此清理。
  if (memberAgentIds.length > 0) {
    removeAgentWorkspace(memberAgentIds);
    removeFromAutoClawCompat(memberAgentIds);
    removeFromLobsterAIDB(memberAgentIds);
    info(MODULE, `[Step7] agent 级产物清理已触发: ${memberAgentIds.length} 个 agent`, eventId);
    writeTeamDeleteLog(`agent artifacts cleanup triggered: ${memberAgentIds.length} agents`);
  }

  // ====== Step 6c: 激活转移后对账 sessionKey（非致命，best-effort） ======
  if (activationTransfer?.activatedProjectId && activationTransfer?.activatedTeamId) {
    try {
      const atTeam = (coordclawData.teams || []).find((t: any) => t.id === activationTransfer.activatedTeamId);
      const atProject = atTeam?.projects?.find((p: any) => p.id === activationTransfer.activatedProjectId);
      if (atProject?.root) {
        await reconcileProjectSessionKeys(atProject.root);
        info(MODULE, `[Step6c] 激活转移项目 sessionKey 对账完成: ${atProject.root}`, eventId);
      }
    } catch (recErr: any) {
      warn(MODULE, `[Step6c] 激活转移项目 sessionKey 对账失败(非致命): ${recErr.message}`, eventId);
    }
  }

  // ====== 完成 ======
  const baseMessage = `团队 ${teamName} (${teamId}) 删除成功: ${agentsRemoved}/${memberAgentIds.length} 个 agent 已从 openclaw.json 移除`;
  const message = activationTransfer
    ? `${baseMessage}, ${activationTransfer.message}`
    : baseMessage;
  info(MODULE, `[DELETE] === DONE === ${message}`, eventId);
  writeTeamDeleteLog(`=== DONE === ${message}`);

  return {
    success: true,
    message,
    teamId,
    teamName,
    agentsRemoved,
    totalAgents: memberAgentIds.length,
    details,
    openclawJsonUpdated: true,
    coordclawJsonUpdated: true,
    ...(activationTransfer ? { activationTransfer } : {}),
  };
}
