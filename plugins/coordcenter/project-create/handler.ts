/**
 * 新建项目核心逻辑
 *
 * 功能18 (v19.34): 基于团队模板创建新项目
 *
 * 流程：
 *   Step 1: 校验请求参数
 *   Step 2: 检查团队是否在 coordclaw.json 中注册
 *   Step 3: 生成项目 ID（team_name_{4位顺序码}）
 *   Step 4: 注册项目到 coordclaw.json（设置唯一激活状态）
 *   Step 5: 复制团队模板到项目路径
 *   Step 6: 从复制过来的 team.json 读取成员列表
 *   Step 7: 为每个成员创建 sessionKey
 *   Step 8: 写入 team.json（仅填入 project_name 和 sessionKey）
 *   Step 9: 全量刷新缓存
 */

import fs from "fs";
import os from "os";
import path from "path";
import { info, warn, error, getEventId } from "../shared/logger";
import {
  getCoordClawJsonPath,
  getTeamDir,
  getTeamJsonPath,
  getOpenClawUserDir,
  resolveGatewayUrl,
  getCoordClawLogsDir,
  expandPath,
} from "../shared/paths";
import { fullReset } from "../shared/cache-coordinator";
import { writeJsonSafe, writeFileWithRetry } from "../shared/json-atomic";
import { readConfigRaw, readCoordClawJson, readTeamJson } from "../shared/config-store";
import { createSessionKeyForAgent } from "../shared/session-key";
import type {
  CreateProjectRequest,
  ProjectCreateResult,
  SessionKeyCreateResult,
} from "./types";

const MODULE = "project-create";

// ==================== 独立日志 ====================

let projectCreateLogPath: string | null = null;

function getProjectCreateLogPath(): string {
  if (!projectCreateLogPath) {
    const logDir = getCoordClawLogsDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    projectCreateLogPath = path.join(logDir, "project-create.log");
  }
  return projectCreateLogPath;
}

function writeProjectCreateLog(msg: string): void {
  try {
    const logPath = getProjectCreateLogPath();
    const line = `${new Date().toISOString()} [PROJECT-CREATE-V1] ${msg}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (_) {
    // 日志写入失败不影响主流程
  }
}

// ==================== 辅助函数 ====================
// ==================== 错误处理辅助函数 ====================

/** 原子写入 JSON 文件，防止进程中断导致文件损坏 */
/** 回滚 coordclaw.json 到原始内容 */
function rollbackCoordClaw(coordclawJsonPath: string, originalRaw: string | null): void {
  if (!originalRaw) return;
  try {
    writeFileWithRetry(coordclawJsonPath, originalRaw);
  } catch (e: any) {
    warn("project-create", `[ROLLBACK] 恢复 coordclaw.json 失败: ${e?.message || String(e)}`, getEventId());
  }
}

/** 清理已创建的项目目录 */
function cleanupProjectDir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (e: any) {
    warn("project-create", `[ROLLBACK] 清理项目目录失败: ${e?.message || String(e)}`, getEventId());
  }
}

/**
 * 递归复制模板目录到项目路径
 * 策略：同名文件替换；无法替换则跳过并记录日志
 */
function copyTemplateWithOverwrite(
  srcDir: string,
  destDir: string,
  eventId: string
): { copied: number; skipped: number; errors: string[] } {
  const result = { copied: 0, skipped: 0, errors: [] as string[] };

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      const sub = copyTemplateWithOverwrite(srcPath, destPath, eventId);
      result.copied += sub.copied;
      result.skipped += sub.skipped;
      result.errors.push(...sub.errors);
    } else {
      try {
        if (fs.existsSync(destPath)) {
          // 目标文件已存在：尝试覆盖（先解除只读等限制）
          try {
            fs.chmodSync(destPath, 0o755);
          } catch (_) {
            // chmod 失败继续尝试复制
          }
        }
        fs.copyFileSync(srcPath, destPath);
        result.copied++;
      } catch (err: any) {
        const errMsg = `跳过文件 ${entry.name}: ${err.message}`;
        warn(MODULE, `[Step5] ${errMsg}`, eventId);
        writeProjectCreateLog(`SKIP: ${errMsg}`);
        result.skipped++;
        result.errors.push(errMsg);
      }
    }
  }

  return result;
}

// ==================== SessionKey 创建（已提升至 ../shared/session-key.ts，project-create 直接复用） ====================

// ==================== 主入口 ====================

export async function createProject(req: CreateProjectRequest): Promise<ProjectCreateResult> {
  const eventId = getEventId();
  const { teamId, projectName, projectPath } = req;

  // 确保项目路径以正斜杠结尾
  const normalizedProjectPath = projectPath.replace(/\\/g, "/").replace(/\/$/, "") + "/";

  // 路径安全护栏：仅拒绝路径遍历（.. 段），不限制用户自选位置（已移除 base-dir 白名单）
  if (normalizedProjectPath.split("/").some((seg) => seg === "..")) {
    const errMsg = `无效的项目路径: ${projectPath}（不允许路径遍历）`;
    warn(MODULE, `[Step1] ${errMsg}`, eventId);
    return { success: false, message: errMsg, error: errMsg };
  }

  info(MODULE, `[CREATE] === PROJECT-CREATE START === teamId=${teamId} projectName=${projectName} projectPath=${normalizedProjectPath}`, eventId);
  writeProjectCreateLog(`=== START === teamId=${teamId} projectName=${projectName} projectPath=${normalizedProjectPath}`);

  // ====== Step 1: 校验请求参数 ======
  if (!teamId || !projectName || !projectPath) {
    const errMsg = `缺少必填参数: teamId=${teamId} projectName=${projectName} projectPath=${projectPath}`;
    warn(MODULE, `[Step1] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  // ====== Step 2: 检查团队是否已注册 ======
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
      writeProjectCreateLog(`FAIL: ${errMsg}`);
      return { success: false, message: errMsg, error: errMsg };
    }
  } catch (err: any) {
    const errMsg = `读取 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step2] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  const teamName = teamRecord.name || teamId;
  info(MODULE, `[Step2] 团队校验通过: ${teamName} (agents=${(teamRecord.agents || []).length})`, eventId);

  // ====== Step 3: 生成项目 ID ======
  const projects = teamRecord.projects || [];
  let maxSeq = 0;
  for (const p of projects) {
    const match = p.id?.match(/_(\d{4})$/);
    if (match) {
      const seq = parseInt(match[1], 10);
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  const nextSeq = maxSeq + 1;
  const projectId = `${teamId}_${String(nextSeq).padStart(4, "0")}`;
  info(MODULE, `[Step3] 生成项目ID: ${projectId}`, eventId);

  // ====== Step 4: 注册项目到 coordclaw.json（唯一激活状态） ======
  try {
    // 将所有团队的所有项目状态设为非激活（全局唯一激活）
    const allTeams = coordclawData.teams || [];
    for (const team of allTeams) {
      const teamProjects = team.projects || [];
      for (const p of teamProjects) {
        p.status = "inactive";
      }
    }
    // 添加新项目为激活状态
    // Anchor root to ~ if under home (P2a #19: cross-platform root path)
    const resolvedRoot = expandPath(normalizedProjectPath).replace(/\\/g, "/");
    const homeDir = os.homedir().replace(/\\/g, "/");
    const anchoredRoot = (resolvedRoot.startsWith(homeDir + "/") || resolvedRoot === homeDir)
      ? "~/" + resolvedRoot.slice(homeDir.length).replace(/^\//, "")
      : normalizedProjectPath;
    projects.push({
      id: projectId,
      name: projectName,
      root: anchoredRoot,
      status: "active",
      deployedAt: new Date().toISOString(),
    });
    teamRecord.projects = projects;

    const coordclawWrite = writeJsonSafe(coordclawJsonPath, coordclawData);
    if (!coordclawWrite.ok) {
      throw new Error(coordclawWrite.error || "未知错误");
    }
    info(MODULE, `[Step4] coordclaw.json 更新成功: ${projectId} status=active`, eventId);
    writeProjectCreateLog(`coordclaw.json updated: projectId=${projectId}`);
  } catch (err: any) {
    const errMsg = `注册项目到 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Step4] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    return { success: false, message: errMsg, error: errMsg };
  }

  // ====== Step 5: 复制团队模板到项目路径 ======
  const teamDir = teamRecord.templatePath ? expandPath(teamRecord.templatePath) : getTeamDir(teamId);
  let projectDirCreated = false;
  try {
    if (!fs.existsSync(normalizedProjectPath)) {
      fs.mkdirSync(normalizedProjectPath, { recursive: true });
      projectDirCreated = true;
      info(MODULE, `[Step5] 创建项目目录: ${normalizedProjectPath}`, eventId);
    }
    // 复制团队目录全部内容（含 .data/ scripts/ 等），同名文件替换，无法替换则跳过
    const copyResult = copyTemplateWithOverwrite(teamDir, normalizedProjectPath, eventId);
    info(
      MODULE,
      `[Step5] 模板复制完成: ${teamDir} → ${normalizedProjectPath} (copied=${copyResult.copied}, skipped=${copyResult.skipped})`,
      eventId
    );
    writeProjectCreateLog(
      `template copied: ${teamDir} → ${normalizedProjectPath} (copied=${copyResult.copied}, skipped=${copyResult.skipped})`
    );
    if (copyResult.errors.length > 0) {
      warn(MODULE, `[Step5] 复制过程中跳过 ${copyResult.skipped} 个文件`, eventId);
    }
  } catch (err: any) {
    const errMsg = `复制团队模板失败: ${err.message}`;
    error(MODULE, `[Step5] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    // 回滚 coordclaw.json 并清理已创建目录
    rollbackCoordClaw(coordclawJsonPath, originalCoordClawRaw);
    if (projectDirCreated) {
      cleanupProjectDir(normalizedProjectPath);
    }
    return { success: false, message: errMsg, error: errMsg, projectId, teamId, teamName };
  }

  // ====== Step 6: 从复制过来的 team.json 读取成员列表 ======
  const teamJsonPath = getTeamJsonPath(normalizedProjectPath);
  let teamJson: any;
  try {
    if (!fs.existsSync(teamJsonPath)) {
      throw new Error(`team.json 不存在: ${teamJsonPath}（请确保团队模板中包含 .data/team.json）`);
    }
    teamJson = readTeamJson(normalizedProjectPath);
    info(MODULE, `[Step6] 已加载 team.json: ${teamJsonPath}`, eventId);
  } catch (err: any) {
    const errMsg = `读取 team.json 失败: ${err.message}`;
    error(MODULE, `[Step6] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    rollbackCoordClaw(coordclawJsonPath, originalCoordClawRaw);
    cleanupProjectDir(normalizedProjectPath);
    return { success: false, message: errMsg, error: errMsg, projectId, teamId, teamName };
  }

  // 从已有 members 中提取 agent_id 列表
  const members = teamJson.members || [];
  if (members.length === 0) {
    const errMsg = `team.json 中 members 数组为空`;
    error(MODULE, `[Step6] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    rollbackCoordClaw(coordclawJsonPath, originalCoordClawRaw);
    cleanupProjectDir(normalizedProjectPath);
    return { success: false, message: errMsg, error: errMsg, projectId, teamId, teamName };
  }
  info(MODULE, `[Step6] 从 team.json 读取到 ${members.length} 个成员`, eventId);

  // ====== Step 7: 为每个成员创建 sessionKey ======
  const sessionKeyResults: SessionKeyCreateResult[] = [];
  for (const member of members) {
    const agentId = member.agent_id;
    if (!agentId) {
      const errMsg = `成员缺少 agent_id 字段: ${JSON.stringify(member).slice(0, 100)}`;
      error(MODULE, `[Step7] ${errMsg}`, eventId);
      writeProjectCreateLog(`FAIL: ${errMsg}`);
      rollbackCoordClaw(coordclawJsonPath, originalCoordClawRaw);
      cleanupProjectDir(normalizedProjectPath);
      return {
        success: false,
        message: errMsg,
        error: errMsg,
        projectId,
        teamId,
        teamName,
        totalMembers: members.length,
      };
    }
    const result = await createSessionKeyForAgent(agentId, projectName);
    if (!result.success) {
      const errMsg = `为 ${agentId} 创建 sessionKey 失败: ${result.error}`;
      error(MODULE, `[Step7] ${errMsg}`, eventId);
      writeProjectCreateLog(`FAIL: ${errMsg}`);
      rollbackCoordClaw(coordclawJsonPath, originalCoordClawRaw);
      cleanupProjectDir(normalizedProjectPath);
      return {
        success: false,
        message: errMsg,
        error: errMsg,
        projectId,
        teamId,
        teamName,
        totalMembers: members.length,
      };
    }
    sessionKeyResults.push({
      agentId,
      agentName: member.name || agentId,
      success: true,
      sessionKey: result.sessionKey,
    });
    info(MODULE, `[Step7] ${agentId} sessionKey 创建成功`, eventId);
  }
  info(MODULE, `[Step7] 全部 ${sessionKeyResults.length} 个 sessionKey 创建成功`, eventId);

  // ====== Step 8: 写入 team.json（project_name + sessionKey + gatewayUrl + openclawUserDir） ======
  try {
    // 修改字段：项目名称、各成员的 sessionKey、网关地址、用户目录
    teamJson.project_name = projectName;
    for (let i = 0; i < members.length && i < sessionKeyResults.length; i++) {
      members[i].sessionKey = sessionKeyResults[i].sessionKey;
    }

    // 写入运行时准确的网关地址和用户目录，确保项目脚本可找到正确的网关
    const accurateGatewayUrl = resolveGatewayUrl();
    const accurateUserDir = getOpenClawUserDir();
    teamJson.gatewayUrl = accurateGatewayUrl;
    teamJson.openclawUserDir = accurateUserDir.replace(/\\/g, "/");

    const teamJsonWrite = writeJsonSafe(teamJsonPath, teamJson);
    if (!teamJsonWrite.ok) {
      throw new Error(teamJsonWrite.error || "未知错误");
    }
    info(MODULE, `[Step8] team.json 写入成功: ${teamJsonPath} (project_name=${projectName}, sessionKeys=${sessionKeyResults.length}, gatewayUrl=${accurateGatewayUrl}, openclawUserDir=${accurateUserDir})`, eventId);
    writeProjectCreateLog(`team.json written: ${teamJsonPath} (gatewayUrl=${accurateGatewayUrl})`);
  } catch (err: any) {
    const errMsg = `写入 team.json 失败: ${err.message}`;
    error(MODULE, `[Step8] ${errMsg}`, eventId);
    writeProjectCreateLog(`FAIL: ${errMsg}`);
    rollbackCoordClaw(coordclawJsonPath, originalCoordClawRaw);
    cleanupProjectDir(normalizedProjectPath);
    return {
      success: false,
      message: errMsg,
      error: errMsg,
      projectId,
      teamId,
      teamName,
      sessionKeysCreated: sessionKeyResults.length,
      totalMembers: members.length,
    };
  }

  // ====== Step 9: 全量刷新缓存 ======
  try {
    const resetResult = await fullReset();
    info(MODULE, `[Step9] ${resetResult.message}`, eventId);
    writeProjectCreateLog(`cache fullReset: ${resetResult.message}`);
  } catch (err: any) {
    const errMsg = `缓存重建失败: ${err.message}`;
    warn(MODULE, `[Step9] ${errMsg}`, eventId);
    writeProjectCreateLog(`WARN: ${errMsg}`);
    // 缓存重建失败不影响项目创建成功的主流程，仅记录警告
  }

  // ====== 完成 ======
  const message = `项目 ${projectName} (${projectId}) 创建成功: 路径=${normalizedProjectPath}, 成员=${members.length}, sessionKey=${sessionKeyResults.length}`;
  info(MODULE, `[CREATE] === DONE === ${message}`, eventId);
  writeProjectCreateLog(`=== DONE === ${message}`);

  return {
    success: true,
    message,
    projectId,
    projectName,
    projectPath: normalizedProjectPath,
    teamId,
    teamName,
    sessionKeysCreated: sessionKeyResults.length,
    totalMembers: members.length,
  };
}
