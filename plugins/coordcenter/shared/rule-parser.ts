/**
 * 共享：team RULE.md 解析器
 *
 * 从 team RULE.md 中提取成员信息（agent_id、name、role、authority_level、direct_supervisor、direct_subordinate）
 *
 * 复用场景：
 *   - 功能18（新建项目）：构建 members 数组写入项目 team.json
 *   - 功能17（新建团队）：构建 members 数组写入团队 team.json
 */

import fs from "fs";
import path from "path";
import { TEAM_RULE_MD_FILENAME } from "./paths";

// ==================== 类型定义 ====================

/** 从 team RULE.md 解析出的单个成员信息 */
export interface RuleAgentInfo {
  agent_id: string;
  name: string;
  role: string;
  authority_level: string;
  direct_supervisor: string;
  direct_subordinate: string;
}

/** 从 team RULE.md 解析出的单个人类成员信息（写入 team.json 的 humanmember） */
export interface RuleHumanInfo {
  enabled: boolean;
  human_id: string;
  name: string;
  role: string;
}

/** 解析结果 */
export interface RuleParseResult {
  agents: RuleAgentInfo[];
  humans: RuleHumanInfo[];
  /** RULE.md 是否声明了 HUMAN:START（用于决定 team.json 的 humanmember 是否按解析结果覆盖） */
  humanMemberDeclared: boolean;
  warnings: string[];
}

// ==================== 核心解析函数 ====================

/**
 * 从 team RULE.md 文件解析成员列表
 *
 * @param dataDir 团队/项目的 .data 目录路径
 * @returns 解析结果（agents + warnings）
 * @throws 当文件不存在或无法读取时抛出错误
 */
export function parseTeamRuleFile(dataDir: string): RuleParseResult {
  const rulePath = path.join(dataDir, path.basename(TEAM_RULE_MD_FILENAME));

  if (!fs.existsSync(rulePath)) {
    throw new Error(`文件不存在: ${rulePath}`);
  }

  const content = fs.readFileSync(rulePath, "utf-8");
  const base = parseTeamRuleContent(content);
  const hum = parseTeamRuleHumans(content);

  // H-Q：人类 id 不应与 agent id 冲突，冲突者视为配置错误，跳过并告警
  const agentIds = new Set(base.agents.map((a) => a.agent_id));
  const humans = hum.humans.filter((h) => {
    if (agentIds.has(h.human_id)) {
      hum.warnings.push(`human_id=${h.human_id} 与 agent 冲突，已跳过`);
      return false;
    }
    return true;
  });

  return {
    agents: base.agents,
    humans,
    humanMemberDeclared: hum.present,
    warnings: [...base.warnings, ...hum.warnings],
  };
}

/**
 * 从 team RULE.md 内容字符串解析成员列表
 *
 * @param content team RULE.md 的完整文本内容
 * @returns 解析结果（agents + warnings）
 */
/**
 * 按 id 在 RULE.md 中定位 SECTION，并提取标签上的 name/role。
 * 不抛错：找不到返回 null，由调用方决定 throw（agent）还是 warn（human）。
 * 注：id 后加 (?=[\s>]) 词边界，避免 "human-001" 误匹配 "human-0010"（H-AB）。
 */
function findSectionById(content: string, id: string): { sectionContent: string; name: string; role: string } | null {
  const esc = id.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<!--\\s*SECTION:START\\s+id=["']?${esc}["']?(?=[\\s>])[^>]*-->[\\s\\S]*?<!--\\s*SECTION:END\\s+id=["']?${esc}["']?(?=[\\s>])[^>]*-->`,
    "i"
  );
  const m = content.match(re);
  if (!m) return null;
  const sc = m[0];
  const name = (sc.match(/<!--\s*SECTION:START\s+id=[^>]*name=("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/) || [])[1]?.replace(/^["']|["']$/g, "") || "";
  const role = (sc.match(/<!--\s*SECTION:START\s+id=[^>]*role=("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/) || [])[1]?.replace(/^["']|["']$/g, "") || "";
  return { sectionContent: sc, name, role };
}

// ==================== body 字段多语言提取（中英文兼容） ====================

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// E12：分隔符外置为 const → 加语言若用 = / — 仅追加一词，零改逻辑
const FIELD_SEPARATORS = [":", "："];
const SEP_CLASS = FIELD_SEPARATORS.map(escapeRegExp).join("") + "\uFF1A"; // 含全角冒号

type BodyField = "authority_level" | "direct_supervisor" | "direct_subordinate";
interface FieldDef { key: BodyField; labels: string[]; warnText: string; }

// 加字段=此处加一项；加语言=对应 labels 追加一词。提取/告警逻辑零重复。
const FIELD_DEFS: FieldDef[] = [
  { key: "authority_level",    labels: ["层级", "Level", "Authority Level"],                     warnText: "authority_level（层级）" },
  { key: "direct_supervisor",  labels: ["直属上级", "Direct Superior", "Direct Superiors"],       warnText: "direct_supervisor（直属上级）" },
  { key: "direct_subordinate", labels: ["直属下级", "Direct Subordinate", "Direct Subordinates"], warnText: "direct_subordinate（直属下级）" },
];

// 盲试所有语言同义词、无语言探测分支；容忍 列表项/加粗、全半角冒号、单复数、尾随**
function extractField(sectionContent: string, labels: string[]): string {
  for (const raw of labels) {
    const label = escapeRegExp(raw);
    const re = new RegExp(
      `^\\s*(?:[-*]\\s*)?\\*{0,2}\\s*${label}\\s*\\*{0,2}\\s*[${SEP_CLASS}]\\s*(.+?)\\s*\\*{0,2}\\s*$`,
      "im"
    );
    const m = sectionContent.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

export function parseTeamRuleContent(content: string): RuleParseResult {
  const agents: RuleAgentInfo[] = [];
  const warnings: string[] = [];

  // 1) 从 AGENTS:START 标签提取 agent_id 列表
  const agentIdMatch = content.match(/<!--\s*AGENTS:START\s+([\w,\-]+)\s*-->/);
  if (!agentIdMatch) {
    throw new Error("未找到 AGENTS:START 标签");
  }
  const agentIds = agentIdMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (agentIds.length === 0) {
    throw new Error("AGENTS:START 标签中未找到任何 agent_id");
  }

  // 2) 遍历每个 agent_id，从对应 SECTION 中提取详细信息
  for (const agentId of agentIds) {
    const s = findSectionById(content, agentId);
    if (!s) {
      throw new Error(`未找到 agentId="${agentId}" 的 SECTION`);
    }
    const sectionContent = s.sectionContent;
    const name = s.name;
    const role = s.role;

    // 从基本信息块中提取 层级/直属上级/直属下级（中英文兼容，多语言同义词盲试）
    const agent: RuleAgentInfo = {
      agent_id: agentId,
      name,
      role,
      authority_level: "",
      direct_supervisor: "",
      direct_subordinate: "",
    };
    for (const def of FIELD_DEFS) {
      const v = extractField(sectionContent, def.labels);
      agent[def.key] = v; // def.key 是 RuleAgentInfo 的 string 键联合，类型安全（E14）
      if (!v) {
        warnings.push(`agentId=${agentId} 未匹配到 ${def.warnText}`);
      }
    }

    agents.push(agent);
  }

  return { agents, humans: [], humanMemberDeclared: false, warnings };
}

/**
 * 从 team RULE.md 内容解析人类成员（HUMAN:START 列表 + 对应 SECTION）。
 * 与 agent 解析的区别：
 *   - 找不到 SECTION / 缺字段 仅 warn，绝不 throw（人类可选，H1/H-A）
 *   - 只取标签上的 name/role，不解析 body 的 层级/上级/下级（humanmember 仅 4 字段，防过度工程）
 *   - HUMAN:START 缺失时 present=false，由调用方决定是否保留既有 humanmember（H-R/H-AC）
 */
export function parseTeamRuleHumans(content: string): {
  humans: RuleHumanInfo[];
  warnings: string[];
  present: boolean;
} {
  const humans: RuleHumanInfo[] = [];
  const warnings: string[] = [];

  const m = content.match(/<!--\s*HUMAN:START\s+([\w,\-\s]+)\s*-->/); // H-P 容忍逗号后空格
  if (!m) {
    return { humans, warnings, present: false };
  }

  const ids = [...new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean))]; // H-I 去重
  for (const hid of ids) {
    const s = findSectionById(content, hid);
    if (!s) {
      warnings.push(`humanId=${hid} 未找到 SECTION`);
      continue;
    }
    if (!s.name) {
      warnings.push(`humanId=${hid} 未匹配到 name`); // H-AE
    }
    if (!s.role) {
      warnings.push(`humanId=${hid} 未匹配到 role`); // H-AE
    }
    humans.push({ enabled: true, human_id: hid, name: s.name, role: s.role });
  }

  return { humans, warnings, present: true };
}

// ==================== 一致性校验 ====================

/** 一致性校验结果 */
export interface ConsistencyCheckResult {
  /** 是否完全一致 */
  consistent: boolean;
  /** 详细警告信息 */
  warnings: string[];
}

/**
 * 校验两个来源的 agent_id 列表是否一致
 *
 * @param soulAgentIds 来自 teamsoul.md 的 agent_id 列表
 * @param ruleAgentIds 来自 team RULE.md 的 agent_id 列表
 * @returns 一致性结果（不一致时返回详细差异，不抛错）
 */
export function checkAgentIdConsistency(
  soulAgentIds: string[],
  ruleAgentIds: string[]
): ConsistencyCheckResult {
  const warnings: string[] = [];
  const soulSet = new Set(soulAgentIds);
  const ruleSet = new Set(ruleAgentIds);

  // 数量不一致
  if (soulAgentIds.length !== ruleAgentIds.length) {
    warnings.push(
      `agent 数量不一致: teamsoul.md=${soulAgentIds.length}, team RULE.md=${ruleAgentIds.length}`
    );
  }

  // 找出仅在 teamsoul.md 中存在的 ID
  const onlyInSoul = soulAgentIds.filter((id) => !ruleSet.has(id));
  if (onlyInSoul.length > 0) {
    warnings.push(`仅存在于 teamsoul.md: [${onlyInSoul.join(", ")}]`);
  }

  // 找出仅在 team RULE.md 中存在的 ID
  const onlyInRule = ruleAgentIds.filter((id) => !soulSet.has(id));
  if (onlyInRule.length > 0) {
    warnings.push(`仅存在于 team RULE.md: [${onlyInRule.join(", ")}]`);
  }

  return {
    consistent: warnings.length === 0,
    warnings,
  };
}
