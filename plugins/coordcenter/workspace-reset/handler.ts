import fs from "fs";
import path from "path";

import { info, error, warn, getEventId } from "../shared/logger";
import {
  getAgentScopeModule,
  getOpenClawResetModule,
  getOpenClawUserDir,
} from "../shared/paths";
import { loadTeamContext } from "../shared/team-loader";
import { resetAllTeamSessions } from "../session-reset";

import type {
  WorkspaceResetMemberResult,
  WorkspaceResetResult,
} from "./types";
import { rebuildAgentSoul } from "./soul-rebuild";

function isSafeWorkspaceDir(workspaceDir: string): boolean {
  const normalized = path.resolve(workspaceDir).toLowerCase();
  const userHome = getOpenClawUserDir().toLowerCase();
  const basename = path.basename(normalized);
  return (
    normalized.startsWith(userHome) &&
    (basename.startsWith("workspace-") || basename === "workspace")
  );
}

async function cleanWorkspaceContents(dirPath: string, eventId: string | null): Promise<boolean> {
  info("workspace-reset", `[CLEAN] 开始清空workspace内容: ${dirPath}`, eventId);

  try {
    if (!fs.existsSync(dirPath)) {
      info("workspace-reset", `[CLEAN] 目录不存在，视为清理成功`, eventId);
      return true;
    }

    let deletedFiles = 0;
    let failedFiles = 0;

    function cleanRecursive(currentPath: string): void {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        try {
          if (entry.isDirectory()) {
            cleanRecursive(fullPath);
            try {
              fs.rmdirSync(fullPath);
            } catch (dirErr: any) {
              warn("workspace-reset", `[CLEAN] 无法删除子目录: ${fullPath} (${dirErr.code})`, eventId);
              failedFiles++;
            }
          } else if (entry.isFile()) {
            fs.unlinkSync(fullPath);
            deletedFiles++;
          }
        } catch (err: any) {
          warn("workspace-reset", `[CLEAN] 无法删除: ${fullPath} (${err.code || err.message})`, eventId);
          failedFiles++;
        }
      }
    }

    cleanRecursive(dirPath);

    info("workspace-reset", `[CLEAN] 清理完成: 删除 ${deletedFiles} 个文件, ${failedFiles} 个失败 (保留workspace目录本身)`, eventId);
    return true;
  } catch (err: any) {
    error("workspace-reset", `[CLEAN] 清理过程异常: ${err.message}`, eventId);
    return false;
  }
}

let cachedResolveWs: ((cfg: any, agentId: string) => string) | null = null;
let cachedLoadConfig: (() => any) | null = null;

async function resolveWorkspaceDirForAgent(agentId: string, eventId: string | null): Promise<string | null> {
  try {
    if (!cachedResolveWs || !cachedLoadConfig) {
      const agentScopePath = getAgentScopeModule();
      info("workspace-reset", `[PATH] agentScopeModule=${agentScopePath}`, eventId);
      const agentScopeMod: any = await import(agentScopePath);

      cachedResolveWs =
        agentScopeMod.resolveAgentWorkspaceDir ||
        Object.values(agentScopeMod).find(
          (v: any) => typeof v === "function" && v.name === "resolveAgentWorkspaceDir"
        );

      if (typeof cachedResolveWs !== "function") {
        warn("workspace-reset", `[PATH] resolveAgentWorkspaceDir 不是函数，使用回退`, eventId);
        cachedResolveWs = null;
        return path.join(getOpenClawUserDir(), `workspace-${agentId}`);
      }
      const resetPath = getOpenClawResetModule();
      const resetMod: any = await import(resetPath);
      cachedLoadConfig = typeof resetMod.loadConfig === "function" ? resetMod.loadConfig : null;
    }
    const cfg = cachedLoadConfig ? cachedLoadConfig() : {};
    const wsDir = cachedResolveWs(cfg, agentId);
    if (!wsDir || typeof wsDir !== "string") return null;
    return path.resolve(wsDir);
  } catch (err: any) {
    warn("workspace-reset", `[PATH] resolveWorkspaceDirForAgent 回退到默认路径: ${err.message}`, eventId);
    return path.join(getOpenClawUserDir(), `workspace-${agentId}`);
  }
}

export async function resetProjectWorkspaces(
  jsonPath: string,
  cacheTtl: number,
  reason: string = "manual"
): Promise<WorkspaceResetResult> {
  const eventId = getEventId();
  info("workspace-reset", `[RESET] === START === jsonPath=${jsonPath} reason=${reason}`, eventId);

  try {
    const { members } = await loadTeamContext(jsonPath, cacheTtl, "workspace-reset");

    if (members.length === 0) {
      return {
        success: false,
        message: "team.json 中没有有效成员",
        reason,
        totalMembers: 0,
        resetCount: 0,
        details: [],
      };
    }

    // === 步骤1: 复用 session-reset 模块重置所有成员会话 ===
    info("workspace-reset", `[STEP-4] 调用resetAllTeamSessions批量重置session...`, eventId);
    const sessionResult = await resetAllTeamSessions(jsonPath, cacheTtl);
    info("workspace-reset", `[STEP-5] session-reset完成: success=${sessionResult.success}, count=${sessionResult.resetCount}/${sessionResult.totalMembers}`, eventId);

    const details: WorkspaceResetMemberResult[] = [];
    let resetCount = 0;

    for (const member of members) {
      const memberResult: WorkspaceResetMemberResult = {
        name: member.name,
        agentId: member.agent_id,
        sessionKey: member.sessionKey,
        workspaceDir: "",
        sessionAborted: false,
        workspaceDeleted: false,
        soulRebuilt: false,
        sessionReset: false,
      };

      // 从session-reset结果中查找该成员的reset状态
      const memberSessionResult = sessionResult.details.find(
        (s: any) => s.agentId === member.agent_id
      );
      memberResult.sessionReset = memberSessionResult?.reset === true;
      memberResult.sessionAborted = memberSessionResult?.reset === true;

      try {
        info("workspace-reset", `[STEP-1] ${member.name}: 开始处理`, eventId);
        const workspaceDir = await resolveWorkspaceDirForAgent(member.agent_id, eventId);
        memberResult.workspaceDir = workspaceDir || "";
        info("workspace-reset", `[STEP-2] ${member.name}: workspaceDir=${workspaceDir}`, eventId);

        if (workspaceDir && !isSafeWorkspaceDir(workspaceDir)) {
          memberResult.error = `路径安全检查未通过: ${workspaceDir}`;
          warn("workspace-reset", `[RESET] ${member.name}: ${memberResult.error}`, eventId);
          details.push(memberResult);
          continue;
        }
        info("workspace-reset", `[STEP-3] ${member.name}: 路径安全检查通过`, eventId);
        info("workspace-reset", `[STEP-6] ${member.name}: session reset结果: ${memberResult.sessionReset}`, eventId);

        // === 步骤2: 清空workspace内容（保留文件夹本身，不删目录） ===
        info("workspace-reset", `[STEP-7] ${member.name}: 检查workspace存在性...`, eventId);
        if (workspaceDir && fs.existsSync(workspaceDir)) {
          info("workspace-reset", `[STEP-8] ${member.name}: workspace存在，清空内容...`, eventId);
          const cleaned = await cleanWorkspaceContents(workspaceDir, eventId);
          memberResult.workspaceDeleted = cleaned;
          info("workspace-reset", `[STEP-9] ${member.name}: 内容清空${cleaned ? "成功" : "失败"} (保留workspace目录)`, eventId);
        } else {
          memberResult.workspaceDeleted = true;
          info("workspace-reset", `[STEP-8] ${member.name}: workspace不存在，跳过清空`, eventId);
        }

        // === 步骤3: 重建 SOUL.md ===
        if (workspaceDir) {
          info("workspace-reset", `[STEP-10] ${member.name}: 准备重建SOUL.md...`, eventId);
          info("workspace-reset", `[STEP-11] ${member.name}: 调用rebuildAgentSoul...`, eventId);
          const soulResult = await rebuildAgentSoul(jsonPath, cacheTtl, member.agent_id, workspaceDir);
          info("workspace-reset", `[STEP-12] ${member.name}: rebuildAgentSoul返回, rebuilt=${soulResult.rebuilt}`, eventId);
          memberResult.soulRebuilt = soulResult.rebuilt;
          if (!soulResult.rebuilt) {
            warn("workspace-reset", `[RESET] ${member.name}: SOUL.md 重建失败: ${soulResult.error}`, eventId);
          }
        } else {
          info("workspace-reset", `[STEP-10] ${member.name}: 无workspaceDir，跳过SOUL重建`, eventId);
        }

        resetCount++;
        info("workspace-reset", `[STEP-13] ${member.name}: OK (abort=${memberResult.sessionAborted}, workspace=${memberResult.workspaceDeleted}, soul=${memberResult.soulRebuilt}, session=${memberResult.sessionReset})`, eventId);
      } catch (err: any) {
        memberResult.error = err.message;
        error("workspace-reset", `[RESET] ${member.name}: 异常: ${err.message}`, eventId);
      }

      details.push(memberResult);
    }

    const message = `团队重置完成: 成功 ${resetCount}/${members.length} 个成员 (reason=${reason})`;
    info("workspace-reset", `[RESET] === END === ${message}`, eventId);

    return {
      success: resetCount > 0,
      message,
      reason,
      totalMembers: members.length,
      resetCount,
      details,
    };
  } catch (err: any) {
    error("workspace-reset", `[RESET] 失败: ${err.message}\n${err.stack}`, eventId);
    return {
      success: false,
      message: `团队重置失败: ${err.message}`,
      reason,
      totalMembers: 0,
      resetCount: 0,
      details: [],
    };
  }
}