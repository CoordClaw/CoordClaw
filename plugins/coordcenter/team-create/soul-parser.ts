/**
 * teamsoul.md / team RULE.md 解析器
 *
 * 从 teamsoul.md 中提取：
 *   1. 所有 agent_id 列表（AGENTS:START 标签）
 *   2. 公共个性基底（id=common SECTION）
 *   3. 每个 agent 的元数据和私有人格内容
 *
 * 从 team RULE.md 中提取（回退）：
 *   4. 层级、直属上级、直属下级（从角色规则的 <!-- SECTION:START id={agentId} --> 下的基本信息块）
 *
 * teamsoul.md 格式：
 *   <!-- AGENTS:START agentId1,agentId2,... -->
 *   <!-- AGENTS:END -->
 *   ---
 *   <!-- SECTION:START id=common title=通用人格基底 -->
 *   ...（公共内容）...
 *   <!-- SECTION:END id=common -->
 *   ---
 *   <!-- SECTION:START id={agentId} role={roleLabel} name={name} -->
 *   # SOUL.md - {roleLabel}
 *   你是{roleLabel}，你的姓名是{name}。
 *   ## 元数据
 *   - agent_id: ...
 *   - 姓名：...
 *   - 层级: ...
 *   - 岗位: ...
 *   - 类型：...
 *   - 直属上级: ...
 *   ...
 *   <!-- SECTION:END id={agentId} -->
 */

import fs from "fs";
import { info, warn, getEventId } from "../shared/logger";
import type { AgentParseInfo } from "./types";

const MODULE = "soul-parser";

/**
 * 从 teamsoul.md 的 AGENTS:START 标签中提取 agent ID 列表
 *
 * 格式: <!-- AGENTS:START id1,id2,id3,... -->
 */
export function extractAgentIds(teamsoulContent: string): string[] {
  const re = /<!--\s*AGENTS:START\s+([\w,\-]+)\s*-->/;
  const m = teamsoulContent.match(re);
  if (!m) {
    warn(MODULE, `[PARSE] 未找到 AGENTS:START 标签`, getEventId());
    return [];
  }
  const ids = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  info(MODULE, `[PARSE] 从 AGENTS:START 提取到 ${ids.length} 个 agent_id`, getEventId());
  return ids;
}

/**
 * 从 teamsoul.md 中提取公共 SECTION（id=common）
 */
export function extractCommonSection(teamsoulContent: string): string {
  const re = /<!--\s*SECTION:START\s+id=["']?common["']?[^>]*-->[\s\S]*?<!--\s*SECTION:END\s+id=["']?common["']?\s*-->/;
  const m = teamsoulContent.match(re);
  if (m) {
    const section = m[0]
      .replace(/<!--\s*SECTION:START[^>]*-->/g, "")
      .replace(/<!--\s*SECTION:END[^>]*-->/g, "")
      .trim();
    info(MODULE, `[PARSE] 公共 SECTION 提取成功 (${section.length} chars)`, getEventId());
    return section;
  }
  warn(MODULE, `[PARSE] 未找到 id=common SECTION`, getEventId());
  return "";
}

/**
 * 从 teamsoul.md 中提取指定 agent 的私有 SECTION 内容（去除标签）
 */
export function extractAgentPrivateSection(teamsoulContent: string, agentId: string): string {
  const esc = agentId.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<!--\\s*SECTION:START\\s+id=["']?${esc}["']?\\b[^>]*-->[\\s\\S]*?<!--\\s*SECTION:END\\s+id=["']?${esc}["']?\\b\\s*-->`,
    "i"
  );
  const m = teamsoulContent.match(re);
  if (m) {
    const section = m[0]
      .replace(/<!--\s*SECTION:START[^>]*-->/g, "")
      .replace(/<!--\s*SECTION:END[^>]*-->/g, "")
      .trim();
    info(MODULE, `[PARSE] agentId=${agentId} 私有人格提取成功 (${section.length} chars)`, getEventId());
    return section;
  }
  warn(MODULE, `[PARSE] 未找到 agentId=${agentId} 的 SECTION`, getEventId());
  return "";
}

/**
 * 从 SECTION:START 标签属性中提取 agent_id 和 name
 *
 * 标签格式: <!-- SECTION:START id={agentId} role={roleLabel} name={name} -->
 *   例: <!-- SECTION:START id=chenmo-pm role=产品经理 name=陈默 -->
 *
 * @param teamsoulContent teamsoul.md 全文内容
 * @param agentId 要查找的 agent ID
 * @returns { agentId, name, roleLabel } 从标签属性提取的值
 */
export function parseAgentMetadataFromTag(
  teamsoulContent: string,
  agentId: string
): { agentId: string; name: string; roleLabel: string } {
  // 使用字符串查找定位标签行，兼容引号包裹的 id 属性
  let tagStartIdx = -1;
  for (const prefix of [
    `<!-- SECTION:START id=${agentId}`,
    `<!-- SECTION:START id="${agentId}"`,
    `<!-- SECTION:START id='${agentId}'`,
  ]) {
    const idx = teamsoulContent.indexOf(prefix);
    if (idx !== -1) { tagStartIdx = idx; break; }
  }
  if (tagStartIdx === -1) {
    return { agentId, name: "", roleLabel: "" };
  }

  // 提取完整标签行（从 <!-- 到 -->）
  const tagEndIdx = teamsoulContent.indexOf("-->", tagStartIdx);
  if (tagEndIdx === -1) {
    return { agentId, name: "", roleLabel: "" };
  }
  const tagLine = teamsoulContent.substring(tagStartIdx, tagEndIdx + 3);

  // 从标签属性中提取 name（支持引号包裹含空格的值）
  const nameMatch = tagLine.match(/name=("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/);
  const name = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, '') : "";

  // 从标签属性中提取 role（作为 roleLabel，支持引号包裹含空格的值）
  let roleLabel = "";
  const roleMatch = tagLine.match(/role=("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/);
  if (roleMatch) {
    roleLabel = roleMatch[1].replace(/^["']|["']$/g, '');
  }

  // 如果标签中没有 role=，则从元数据块中回退提取
  // 尝试顺序: 1) 岗位:  2) **角色**：  3) agent_id 后缀
  if (!roleLabel) {
    const sectionContent = extractAgentPrivateSection(teamsoulContent, agentId);
    if (sectionContent) {
      // 尝试 "岗位: xxx" 或 "岗位：xxx"
      const metaRoleMatch = sectionContent.match(/岗位[：:]\s*(.+)/);
      if (metaRoleMatch) {
        roleLabel = metaRoleMatch[1].trim();
      } else {
        // 尝试 "**角色**：xxx" 或 "- 角色：xxx"
        const roleLineMatch = sectionContent.match(/\*\*角色\*\*[：:]\s*(.+)/);
        if (roleLineMatch) {
          // 提取斜杠前的部分，如 "项目经理 / Product Manager" → "项目经理"
          roleLabel = roleLineMatch[1].split("/")[0].trim();
        }
      }
    }
    // 最后回退到 agent_id 后缀
    if (!roleLabel) {
      roleLabel = deriveRoleFromAgentId(agentId);
    }
  }

  return { agentId, name, roleLabel };
}

/**
 * 从 agent_id 中派生出角色代码
 * 例: "chenmo-pm" → "pm", "zhongyuan-architect" → "architect"
 */
export function deriveRoleFromAgentId(agentId: string): string {
  const parts = agentId.split("-");
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return "";
}

/**
 * 从 agent 私有人格内容中提取元数据字段
 *
 * 支持的字段（按优先级匹配）：
 *   - 层级 / authority_level / 权限等级 → authorityLevel
 *   - 直属上级 / 上级 / manager / direct_supervisor → manager
 *   - 直属下级 / 下级 / subordinate / direct_subordinate → subordinates
 */
function extractAgentMetadata(sectionContent: string): {
  authorityLevel: string;
  manager: string | null;
  subordinates: string | null;
} {
  let authorityLevel = "";
  let manager: string | null = null;
  let subordinates: string | null = null;

  if (!sectionContent) {
    return { authorityLevel, manager, subordinates };
  }

  // 1) 层级 — 匹配 "- **层级**：L4（决策者）" 或 "- 层级: L4"
  const levelMatch = sectionContent.match(/\*\*层级\*\*\s*[：:]\s*(.+)/);
  if (levelMatch) {
    authorityLevel = levelMatch[1].trim();
  }

  // 2) 直属上级 / 上级 — 匹配 "- **直属上级**：xxx" 或 "- **上级**：xxx"
  //    也匹配 team RULE.md 格式 "- 直属上级: xxx"
  const supervisorMatch =
    sectionContent.match(/\*\*直属上级\*\*\s*[：:]\s*(.+)/) ||
    sectionContent.match(/\*\*上级\*\*\s*[：:]\s*(.+)/) ||
    sectionContent.match(/直属上级\s*[：:]\s*(.+)/) ||
    sectionContent.match(/上级\s*[：:]\s*(.+)/);
  if (supervisorMatch) {
    manager = supervisorMatch[1].trim();
  }

  // 3) 直属下级 / 下级 — 匹配 "- **直属下级**：xxx" 或 "- **下级**：xxx"
  //    也匹配 team RULE.md 格式 "- 直属下级: xxx" 或 "- 直属下级：xxx"
  const subordinateMatch =
    sectionContent.match(/\*\*直属下级\*\*\s*[：:]\s*(.+)/) ||
    sectionContent.match(/\*\*下级\*\*\s*[：:]\s*(.+)/) ||
    sectionContent.match(/直属下级\s*[：:]\s*(.+)/) ||
    sectionContent.match(/下级\s*[：:]\s*(.+)/);
  if (subordinateMatch) {
    subordinates = subordinateMatch[1].trim();
  }

  return { authorityLevel, manager, subordinates };
}

/**
 * 从 team RULE.md 的 agent 私有人格 SECTION 中提取层级、上级、下级信息
 *
 * 匹配格式（team RULE.md 中的角色规则基本信息）：
 * #### 基本信息
 * - agent_id: chenmo-pm-grdft
 * - 姓名：陈默
 * - 层级: L4
 * - 岗位: 首席金融分析师
 * - 类型：决策者
 * - 直属上级: 用户
 * - 直属下级：钟远、方衡、苏晓
 *
 * @param ruleContent team RULE.md 全文内容
 * @param agentId 要查找的 agent ID
 * @returns { authorityLevel, manager, subordinates }
 */
function extractOrganizationInfoFromRule(
  ruleContent: string,
  agentId: string
): { authorityLevel: string; manager: string | null; subordinates: string | null } {
  let authorityLevel = "";
  let manager: string | null = null;
  let subordinates: string | null = null;

  if (!ruleContent) {
    return { authorityLevel, manager, subordinates };
  }

  // 定位 agent 的 SECTION:START 标签
  const esc = agentId.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `<!--\\s*SECTION:START\\s+id=["']?${esc}["']?\\b[^>]*-->[\\s\\S]*?<!--\\s*SECTION:END\\s+id=["']?${esc}["']?\\b\\s*-->`,
    "i"
  );
  const sectionMatch = ruleContent.match(sectionRe);
  if (!sectionMatch) {
    return { authorityLevel, manager, subordinates };
  }

  const sectionContent = sectionMatch[0];

  // 从基本信息块中提取
  // 层级: L4
  const levelMatch = sectionContent.match(/层级\s*[：:]\s*(.+)/);
  if (levelMatch) {
    authorityLevel = levelMatch[1].trim();
  }

  // 直属上级: 用户
  const supervisorMatch = sectionContent.match(/直属上级\s*[：:]\s*(.+)/);
  if (supervisorMatch) {
    manager = supervisorMatch[1].trim();
  }

  // 直属下级：钟远、方衡、苏晓
  const subordinateMatch = sectionContent.match(/直属下级\s*[：:]\s*(.+)/);
  if (subordinateMatch) {
    subordinates = subordinateMatch[1].trim();
  }

  return { authorityLevel, manager, subordinates };
}

/**
 * 解析 teamsoul.md 文件，返回完整的 Agent 列表
 *
 * @param teamsoulPath teamsoul.md 文件的完整路径
 */
export function parseTeamsoulFile(teamsoulPath: string, rulePath?: string): AgentParseInfo[] {
  const eventId = getEventId();
  info(MODULE, `[PARSE] === START === teamsoulPath=${teamsoulPath} rulePath=${rulePath || ""}`, eventId);

  const teamsoulContent = fs.readFileSync(teamsoulPath, "utf-8");

  // 如果提供了 rulePath，则读取 team RULE.md 内容
  let ruleContent = "";
  if (rulePath && fs.existsSync(rulePath)) {
    ruleContent = fs.readFileSync(rulePath, "utf-8");
    info(MODULE, `[PARSE] 已加载 team RULE.md: ${rulePath}`, eventId);
  }

  // Step 1: 提取公共 SECTION
  const soulCommon = extractCommonSection(teamsoulContent);

  // Step 2: 提取 agent_id 列表
  const agentIds = extractAgentIds(teamsoulContent);
  if (agentIds.length === 0) {
    warn(MODULE, `[PARSE] 未找到任何 agent_id，解析中止`, eventId);
    return [];
  }

  // Step 3: 逐个解析 agent 信息
  const agents: AgentParseInfo[] = [];
  for (const agentId of agentIds) {
    const soulPrivate = extractAgentPrivateSection(teamsoulContent, agentId);
    if (!soulPrivate) {
      warn(MODULE, `[PARSE] 跳过 agentId=${agentId}: 未找到 SECTION 内容`, eventId);
      continue;
    }

    // name 和 roleLabel 统一从 team RULE.md 标签提取（两文件已做一致性检查）
    let name = "";
    let roleLabel = "";
    if (ruleContent) {
      const ruleEsc = agentId.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
      const ruleTagRe = new RegExp(`<!--\\s*SECTION:START\\s+id=${ruleEsc}[^>]*-->`, "i");
      const ruleTagMatch = ruleContent.match(ruleTagRe);
      if (ruleTagMatch) {
        const ruleNameMatch = ruleTagMatch[0].match(/name=([^\s>]+)/);
        if (ruleNameMatch) name = ruleNameMatch[1].trim().replace(/^["']|["']$/g, '');
        const ruleRoleMatch = ruleTagMatch[0].match(/role=([^\s>]+)/);
        if (ruleRoleMatch) roleLabel = ruleRoleMatch[1].trim().replace(/^["']|["']$/g, '');
        info(MODULE, `[PARSE] agentId=${agentId} name/roleLabel 从 team RULE.md 标签提取: name=${name}, roleLabel=${roleLabel}`, eventId);
      }
    }
    // 回退到 teamsoul.md 标签
    if (!name || !roleLabel) {
      const soulMeta = parseAgentMetadataFromTag(teamsoulContent, agentId);
      if (!name && soulMeta.name) name = soulMeta.name;
      if (!roleLabel && soulMeta.roleLabel) roleLabel = soulMeta.roleLabel;
    }

    // 从元数据块提取 authorityLevel、manager、subordinates
    const { authorityLevel, manager, subordinates } = extractAgentMetadata(soulPrivate);

    // 如果元数据块中未提取到，则从 team RULE.md 回退提取
    let finalAuthorityLevel = authorityLevel;
    let finalManager = manager;
    let finalSubordinates = subordinates;

    if (ruleContent && (!finalAuthorityLevel || !finalManager || !finalSubordinates)) {
      const orgInfo = extractOrganizationInfoFromRule(ruleContent, agentId);
      if (!finalAuthorityLevel && orgInfo.authorityLevel) {
        finalAuthorityLevel = orgInfo.authorityLevel;
      }
      if (!finalManager && orgInfo.manager) {
        finalManager = orgInfo.manager;
      }
      if (!finalSubordinates && orgInfo.subordinates) {
        finalSubordinates = orgInfo.subordinates;
      }
    }

    agents.push({
      agentId,
      name,
      roleLabel,
      roleType: "",       // 不依赖元数据块
      role: deriveRoleFromAgentId(agentId),
      authorityLevel: finalAuthorityLevel,
      manager: finalManager,
      subordinates: finalSubordinates,
      soulCommon,
      soulPrivate,
    });

    info(MODULE, `[PARSE] agentId=${agentId} name=${name} roleLabel=${roleLabel} authorityLevel=${finalAuthorityLevel} manager=${finalManager || ""} subordinates=${finalSubordinates || ""}`, eventId);
  }

  info(MODULE, `[PARSE] 完成: 共解析 ${agents.length} 个 agent`, eventId);
  return agents;
}