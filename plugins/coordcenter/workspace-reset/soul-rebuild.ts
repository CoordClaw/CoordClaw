/**
 * SOUL.md 重建工具
 *
 * 从 teamsoul.md 提取指定 agent 的 SECTION 内容，
 * 写入其 workspace 目录，确保 workspace-reset 后人格定义不丢失。
 *
 * teamsoul.md 格式：
 *   <!-- SECTION:START id={agentId} name={displayName} -->
 *   # SOUL.md - {displayName}
 *   ...（完整人格内容）...
 *   <!-- SECTION:END id={agentId} -->
 */

import fs from "fs";
import path from "path";

import { info, warn, getEventId } from "../shared/logger";
import { resolveProjectRoot } from "../prompt-injection";
import { TEAMSOUL_FILENAME } from "../shared/paths";

interface SoulRebuildResult {
  rebuilt: boolean;
  soulPath: string;
  error?: string;
}

/**
 * 从 teamsoul.md 中提取指定 agent 的 SOUL section 内容
 */
export function extractAgentSoulSection(teamsoulContent: string, agentId: string): string | null {
  const eventId = getEventId();

  // 兼容引号包裹的 id 属性
  let startIndex = -1;
  for (const tag of [
    `<!-- SECTION:START id=${agentId} `,
    `<!-- SECTION:START id="${agentId}" `,
    `<!-- SECTION:START id='${agentId}' `,
  ]) {
    const idx = teamsoulContent.indexOf(tag);
    if (idx !== -1) { startIndex = idx; break; }
  }
  if (startIndex === -1) {
    warn("soul-rebuild", `[SOUL] 未找到 agentId=${agentId} 的 SECTION:START 标签`, eventId);
    return null;
  }

  // 跳过整行 START 标签，从下一行开始取内容
  const contentStart = teamsoulContent.indexOf("\n", startIndex) + 1;

  let endIndex = -1;
  for (const tag of [
    `<!-- SECTION:END id=${agentId} -->`,
    `<!-- SECTION:END id="${agentId}" -->`,
    `<!-- SECTION:END id='${agentId}' -->`,
  ]) {
    const idx = teamsoulContent.indexOf(tag, contentStart);
    if (idx !== -1) { endIndex = idx; break; }
  }
  if (endIndex === -1) {
    warn("soul-rebuild", `[SOUL] agentId=${agentId} 找到 START 但缺少 END 标签`, eventId);
    return null;
  }

  return teamsoulContent.slice(contentStart, endIndex).trimEnd();
}

/**
 * 为单个 agent 从 teamsoul.md 重建 workspace/SOUL.md
 */
export async function rebuildAgentSoul(
  jsonPath: string,
  cacheTtl: number,
  agentId: string,
  workspaceDir: string
): Promise<SoulRebuildResult> {
  const eventId = getEventId();

  try {
    const projectRoot = await resolveProjectRoot(jsonPath, cacheTtl);
    const teamsoulPath = path.join(projectRoot, TEAMSOUL_FILENAME);

    info("soul-rebuild", `[SOUL] projectRoot=${projectRoot} teamsoulPath=${teamsoulPath} agentId=${agentId}`, eventId);

    if (!fs.existsSync(teamsoulPath)) {
      return {
        rebuilt: false,
        soulPath: teamsoulPath,
        error: `${TEAMSOUL_FILENAME} 不存在: ${teamsoulPath}`,
      };
    }

    const teamsoulContent = fs.readFileSync(teamsoulPath, "utf-8");
    const soulContent = extractAgentSoulSection(teamsoulContent, agentId);

    if (!soulContent) {
      return {
        rebuilt: false,
        soulPath: teamsoulPath,
        error: `${TEAMSOUL_FILENAME} 中未找到 agentId=${agentId} 的 SECTION`,
      };
    }

    fs.mkdirSync(workspaceDir, { recursive: true });
    const targetPath = path.join(workspaceDir, "SOUL.md");
    fs.writeFileSync(targetPath, soulContent + "\n", "utf-8");

    info(
      "soul-rebuild",
      `[SOUL] ${agentId}: SOUL.md 已重建 (${soulContent.length} chars) → ${targetPath}`,
      eventId
    );

    return { rebuilt: true, soulPath: targetPath };
  } catch (err: any) {
    return {
      rebuilt: false,
      soulPath: "",
      error: err.message,
    };
  }
}
