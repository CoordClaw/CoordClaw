export interface WorkspaceResetMemberResult {
  name: string;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  sessionAborted: boolean;
  workspaceDeleted: boolean;
  soulRebuilt: boolean;
  sessionReset: boolean;
  error?: string;
}

export interface WorkspaceResetResult {
  success: boolean;
  message: string;
  reason: string;
  totalMembers: number;
  resetCount: number;
  details: WorkspaceResetMemberResult[];
}
