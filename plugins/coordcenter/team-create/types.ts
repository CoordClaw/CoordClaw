/**
 * 新建团队 HTTP API 类型定义
 *
 * 功能17 (v19.35): 两阶段团队创建流程
 *   Phase 1: 校验目录 → 一致性校验（门禁）→ 补充模板文件
 *   Phase 2: 解析 teamsoul.md → 注册 coordclaw.json → 扩展 openclaw.json（含 teamId）→ 创建 workspace → 写入 team.json
 */

// ==================== 请求类型 ====================

/** 新建团队 HTTP 请求体 */
export interface CreateTeamRequest {
  /** 团队 ID（如 "team-c"，对应 coordclaw-teams/{teamId}/ 目录） */
  teamId: string;
}

// ==================== Agent 解析结果 ====================

/** 从 teamsoul.md 解析出的单个 Agent 信息 */
export interface AgentParseInfo {
  /** agent 标识符（如 "chenmo-pm"） */
  agentId: string;
  /** 姓名（如 "陈默"） */
  name: string;
  /** 岗位（如 "产品经理"） */
  roleLabel: string;
  /** 角色类型（如 "决策者"/"执行者"） */
  roleType: string;
  /** 岗位代码（如 "pm"/"architect"） */
  role: string;
  /** 权限等级 L1-L4 */
  authorityLevel: string;
  /** 直属上级 agent_id（可为 null） */
  manager: string | null;
  /** 直属下级 agent_id 列表（可为 null） */
  subordinates: string | null;
  /** 公共 SOUL 个性基底（来自 common SECTION） */
  soulCommon: string;
  /** 私有 SOUL 人格定义（来自 agent SECTION） */
  soulPrivate: string;
}

// ==================== 响应类型 ====================

/** Phase 1 结果 */
export interface TeamCreatePhase1Result {
  success: boolean;
  teamId: string;
  teamDir: string;
  dataDir: string;
  templateCopied: boolean;
  copiedFiles: string[];
  error?: string;
}

/** Phase 2 单个 Agent 创建结果 */
export interface AgentCreateResult {
  agentId: string;
  name: string;
  workspaceDir: string;
  soulWritten: boolean;
  error?: string;
}

/** Phase 2 结果 */
export interface TeamCreatePhase2Result {
  success: boolean;
  agentsCreated: number;
  totalAgents: number;
  agents: AgentCreateResult[];
  openclawJsonUpdated: boolean;
  coordclawJsonUpdated: boolean;
  teamJsonWritten: boolean;
  /** 尽力而为步骤的非致命提示（如 RULE 解析告警、roleprompt 注入失败），不影響 success */
  warnings: string[];
  error?: string;
}

/** 完整响应 */
export interface TeamCreateResult {
  success: boolean;
  message: string;
  phase1: TeamCreatePhase1Result;
  phase2: TeamCreatePhase2Result | null;
}