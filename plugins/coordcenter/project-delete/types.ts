/**
 * 功能19: 删除项目 - 类型定义
 *
 * 流程：校验参数 → 定位项目 → 删除成员 session → 移除 coordclaw.json 注册 → 刷新缓存
 */

export interface DeleteProjectRequest {
  /** 团队ID（必须在 coordclaw.json 中已注册） */
  teamId: string;
  /** 项目ID（如 "DataAnalysisTeam_0001"） */
  projectId: string;
}

export interface SessionDeleteResult {
  agentId: string;
  agentName: string;
  sessionKey: string;
  deleted: boolean;
  error?: string;
}

export interface ProjectDeleteResult {
  success: boolean;
  message: string;
  teamId?: string;
  projectId?: string;
  projectPath?: string;
  sessionsDeleted?: number;
  totalMembers?: number;
  details?: SessionDeleteResult[];
  error?: string;
}
