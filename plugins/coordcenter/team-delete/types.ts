/**
 * 删除团队 - 类型定义
 *
 * 功能21: 基于 teamId 删除团队
 *
 * 流程：
 *   Step 1: 校验请求参数
 *   Step 2: 读取 coordclaw.json，定位团队条目
 *   Step 3: 从团队 .data/team.json 提取成员 agent_id 列表
 *   Step 4: 从 openclaw.json 中移除对应 agents
 *   Step 5: 从 coordclaw.json 中移除团队注册
 *   Step 6: 原子写入更新后的 openclaw.json + coordclaw.json
 */

// ==================== 请求类型 ====================

/** 删除团队 HTTP 请求体 */
export interface DeleteTeamRequest {
  /** 团队 ID（如 "DataAnalysisTeam"，必须在 coordclaw.json 中已注册） */
  teamId: string;
}

// ==================== 结果类型 ====================

/** 单个 Agent 删除结果 */
export interface AgentDeleteResult {
  /** agent 标识符 */
  agentId: string;
  /** agent 名称 */
  name: string;
  /** 是否从 openclaw.json 中成功移除 */
  removed: boolean;
  /** 错误信息（失败时） */
  error?: string;
}

/** 激活状态转移结果 */
export interface ActivationTransferResult {
  /** 被激活的项目 ID（无剩余项目时不存在） */
  activatedProjectId?: string;
  /** 被激活的项目所属团队 ID */
  activatedTeamId?: string;
  /** 状态转移描述信息 */
  message: string;
}

/** 完整响应 */
export interface TeamDeleteResult {
  success: boolean;
  message: string;
  teamId?: string;
  teamName?: string;
  /** 成功从 openclaw.json 移除的 agent 数量 */
  agentsRemoved?: number;
  /** 团队成员总数 */
  totalAgents?: number;
  /** 每个 agent 的删除详情 */
  details?: AgentDeleteResult[];
  openclawJsonUpdated?: boolean;
  coordclawJsonUpdated?: boolean;
  /** 激活状态转移信息（被删除团队有激活项目时返回） */
  activationTransfer?: ActivationTransferResult;
  error?: string;
}
