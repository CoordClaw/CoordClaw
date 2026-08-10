/**
 * 切换项目核心逻辑
 *
 * 功能23: 基于 teamId + projectId 切换激活项目
 *
 * 流程：
 *   Step 1: 校验请求参数
 *   Step 2: 读取 coordclaw.json，定位团队和项目条目
 *   Step 3: 将所有团队的所有项目置为 inactive，目标项目置为 active
 *   Step 4: 原子写入 coordclaw.json
 *   Step 5: 定位激活项目的 team.json，更新 gatewayUrl 和 openclawUserDir
 */

import fs from "fs";
import path from "path";
import { info, warn, error, getEventId } from "../shared/logger";
import {
  getCoordClawJsonPath,
  getOpenClawUserDir,
  resolveGatewayUrl,
  getCoordClawLogsDir,
  expandPath,
} from "../shared/paths";
import type {
  SwitchProjectRequest,
  SwitchProjectResult,
} from "./types";
import { writeJsonSafe, writeJsonSafeOrThrow } from "../shared/json-atomic";
import { readCoordClawJson, readJsonFile } from "../shared/config-store";
import { reconcileProjectSessionKeys } from "../shared/session-key";

const MODULE = "project-switch";

// ==================== 独立日志 ====================

let projectSwitchLogPath: string | null = null;

function getProjectSwitchLogPath(): string {
  if (!projectSwitchLogPath) {
    const logDir = getCoordClawLogsDir();
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    projectSwitchLogPath = path.join(logDir, "project-switch.log");
  }
  return projectSwitchLogPath!;
}

function writeProjectSwitchLog(msg: string): void {
  try {
    const line = `${new Date().toISOString()} [PROJECT-SWITCH] ${msg}\n`;
    fs.appendFileSync(getProjectSwitchLogPath(), line, "utf-8");
  } catch (_) {}
}

// ==================== 辅助函数 ====================

/** 原子写入 JSON 文件 */
// ==================== 主入口 ====================

export async function switchProject(
  req: SwitchProjectRequest
): Promise<SwitchProjectResult> {
  const eventId = getEventId();
  const { teamId, projectId } = req;

  info(MODULE, `[SWITCH] === PROJECT-SWITCH START === teamId=${teamId} projectId=${projectId}`, eventId);
  writeProjectSwitchLog(`=== START === teamId=${teamId} projectId=${projectId}`);

  // ====== Step 1: 校验请求参数 ======
  if (!teamId || !projectId) {
    const errMsg = `缺少必填参数: teamId=${teamId} projectId=${projectId}`;
    warn(MODULE, `[Step1] ${errMsg}`, eventId);
    writeProjectSwitchLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  // ====== Step 2: 读取 coordclaw.json，定位团队和项目条目 ======
  const coordclawJsonPath = getCoordClawJsonPath();
  let coordclawData: any;
  let teamRecord: any;
  let targetProject: any;

  try {
    coordclawData = readCoordClawJson();

    const teams = coordclawData.teams || [];
    teamRecord = teams.find((t: any) => t.id === teamId);

    if (!teamRecord) {
      const errMsg = `团队 "${teamId}" 未在 coordclaw.json 中注册`;
      warn(MODULE, `[Step2] ${errMsg}`, eventId);
      writeProjectSwitchLog(`FAIL: ${errMsg}`);
      return { success: false, message: errMsg, error: errMsg, teamId, projectId };
    }

    const projects = teamRecord.projects || [];
    targetProject = projects.find((p: any) => p.id === projectId);

    if (!targetProject) {
      const errMsg = `项目 "${projectId}" 未在团队 "${teamId}" 中找到`;
      warn(MODULE, `[Step2] ${errMsg}`, eventId);
      writeProjectSwitchLog(`FAIL: ${errMsg}`);
      return { success: false, message: errMsg, error: errMsg, teamId, projectId };
    }

    info(
      MODULE,
      `[Step2] 定位成功: teamId=${teamId} projectId=${projectId} name=${targetProject.name} root=${targetProject.root}`,
      eventId
    );
  } catch (err: any) {
    const errMsg = `读取 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step2] ${errMsg}`, eventId);
    writeProjectSwitchLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg, teamId, projectId };
  }

  // ====== Step 3: 全局切换激活状态 ======
  let deactivatedCount = 0;
  let wasAlreadyActive = false;

  try {
    const allTeams = coordclawData.teams || [];
    for (const team of allTeams) {
      const teamProjects = team.projects || [];
      for (const p of teamProjects) {
        if (p.id === projectId && team.id === teamId) {
          if (p.status === "active") {
            wasAlreadyActive = true;
          }
          p.status = "active";
        } else if (p.status === "active") {
          p.status = "inactive";
          deactivatedCount++;
        }
      }
    }

    info(
      MODULE,
      `[Step3] 激活状态切换完成: 目标=${teamId}/${projectId}, 停用=${deactivatedCount} 个${wasAlreadyActive ? "(目标已是active)" : ""}`,
      eventId
    );
  } catch (err: any) {
    const errMsg = `切换激活状态失败: ${err.message}`;
    error(MODULE, `[Step3] ${errMsg}`, eventId);
    writeProjectSwitchLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg, teamId, projectId };
  }

  // ====== Step 4: 原子写入 coordclaw.json ======
  try {
    writeJsonSafeOrThrow(coordclawJsonPath, coordclawData, "[Step4] 写 coordclaw.json");
    info(MODULE, `[Step4] coordclaw.json 写入成功`, eventId);
    writeProjectSwitchLog(`coordclaw.json updated: active=${teamId}/${projectId}, deactivated=${deactivatedCount}`);
  } catch (err: any) {
    const errMsg = `写入 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step4] ${errMsg}`, eventId);
    writeProjectSwitchLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg, teamId, projectId };
  }

  // ====== Step 5: 更新激活项目的 team.json（gatewayUrl + openclawUserDir） ======
  let teamJsonUpdated = false;
  const accurateGatewayUrl = resolveGatewayUrl();
  const accurateUserDir = getOpenClawUserDir().replace(/\\/g, "/");  // 归一化分隔符

  try {
    const projectRoot = expandPath(targetProject.root);
    if (projectRoot) {
      // 支持 root 以 / 结尾或不含 .data 的路径，自动补全到 .data/team.json
      let teamJsonCandidate = path.join(projectRoot.replace(/\/$/, ""), ".data", "team.json");

      // 如果路径不存在，尝试直接在 root 下查找
      if (!fs.existsSync(teamJsonCandidate)) {
        const altPath = path.join(projectRoot.replace(/\/$/, ""), "team.json");
        if (fs.existsSync(altPath)) {
          teamJsonCandidate = altPath;
        }
      }

      if (fs.existsSync(teamJsonCandidate)) {
        const teamJsonData = readJsonFile(teamJsonCandidate);

        let changed = false;
        if (teamJsonData.gatewayUrl !== accurateGatewayUrl) {
          teamJsonData.gatewayUrl = accurateGatewayUrl;
          changed = true;
        }
        if (teamJsonData.openclawUserDir !== accurateUserDir) {
          teamJsonData.openclawUserDir = accurateUserDir;
          changed = true;
        }

        if (changed) {
          const r5 = writeJsonSafe(teamJsonCandidate, teamJsonData);
          if (!r5.ok) {
            warn(MODULE, `[Step5] 更新 team.json 失败(非致命): ${r5.error}`, eventId);
          } else {
            teamJsonUpdated = true;
            info(
              MODULE,
              `[Step5] team.json 已更新: ${teamJsonCandidate} (gatewayUrl=${accurateGatewayUrl}, openclawUserDir=${accurateUserDir})`,
              eventId
            );
          }
        } else {
          info(MODULE, `[Step5] team.json 无需更新(值已准确): ${teamJsonCandidate}`, eventId);
        }
      } else {
        warn(MODULE, `[Step5] team.json 不存在: ${teamJsonCandidate}，跳过更新`, eventId);
        writeProjectSwitchLog(`WARN: team.json not found at ${teamJsonCandidate}`);
      }
    } else {
      warn(MODULE, `[Step5] 项目无 root 路径，无法定位 team.json`, eventId);
    }
  } catch (err: any) {
    // team.json 更新失败不影响切换主流程，仅记录警告
    warn(MODULE, `[Step5] 更新 team.json 失败(非致命): ${err.message}`, eventId);
    writeProjectSwitchLog(`WARN: team.json update failed: ${err.message}`);
  }

  // ====== Step 6: 对账激活项目成员 sessionKey（非致命，best-effort） ======
  try {
    const reconcileRoot = expandPath(targetProject.root);
    if (reconcileRoot) {
      await reconcileProjectSessionKeys(reconcileRoot);
      info(MODULE, `[Step6] 激活项目 sessionKey 对账完成: ${reconcileRoot}`, eventId);
    }
  } catch (step6Err: any) {
    warn(MODULE, `[Step6] sessionKey 对账失败(非致命): ${step6Err.message}`, eventId);
  }

  // ====== 完成 ======
  const baseMessage = wasAlreadyActive
    ? `项目 ${targetProject.name || projectId} (${projectId}) 已是激活状态（已刷新 gatewayUrl/openclawUserDir）`
    : `已切换至项目 ${targetProject.name || projectId} (${projectId}): 停用 ${deactivatedCount} 个项目`;

  const message = `${baseMessage}, gatewayUrl=${accurateGatewayUrl}`;
  info(MODULE, `[SWITCH] === DONE === ${message}`, eventId);
  writeProjectSwitchLog(`=== DONE === ${message}`);

  return {
    success: true,
    message,
    teamId,
    projectId,
    projectName: targetProject.name,
    projectPath: targetProject.root,
    deactivatedCount,
    teamJsonUpdated,
    gatewayUrl: accurateGatewayUrl,
    openclawUserDir: accurateUserDir,
  };
}
