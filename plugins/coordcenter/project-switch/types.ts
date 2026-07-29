/**
 * 切换项目 - 类型定义
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

// ==================== 请求类型 ====================

/** 切换项目 HTTP 请求体 */
export interface SwitchProjectRequest {
  /** 团队 ID（如 "team-c"，必须在 coordclaw.json 中已注册） */
  teamId: string;
  /** 项目 ID（如 "CoordClawTeam_0001"，必须属于该团队） */
  projectId: string;
}

// ==================== 结果类型 ====================

/** 完整响应 */
export interface SwitchProjectResult {
  success: boolean;
  message: string;
  teamId?: string;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  /** 被停用的项目数量 */
  deactivatedCount?: number;
  /** 更新的 team.json 路径 */
  teamJsonUpdated?: boolean;
  /** 写入的 gatewayUrl */
  gatewayUrl?: string;
  /** 写入的 openclawUserDir */
  openclawUserDir?: string;
  error?: string;
}
