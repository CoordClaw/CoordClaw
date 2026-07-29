/**
 * 功能18 (v19.34): 新建项目 - 类型定义
 *
 * 流程：校验团队 → 生成项目ID → 注册到 coordclaw.json → 复制模板 → 从 team.json 读取成员 → 创建 sessionKey → 填入 project_name + sessionKey
 */

export interface CreateProjectRequest {
  /** 团队ID（必须在 coordclaw.json 中已注册） */
  teamId: string;
  /** 项目名称 */
  projectName: string;
  /** 项目根目录绝对路径（不存在则自动创建） */
  projectPath: string;
}

export interface ProjectCreateResult {
  success: boolean;
  message: string;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  teamId?: string;
  teamName?: string;
  sessionKeysCreated?: number;
  totalMembers?: number;
  error?: string;
}

export interface SessionKeyCreateResult {
  agentId: string;
  agentName: string;
  success: boolean;
  sessionKey?: string;
  error?: string;
}
