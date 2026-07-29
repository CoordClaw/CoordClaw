export { createTeam, repairTeamAgents, registerCoordAgents } from "./handler";
export type { TeamRepairResult } from "./handler";
export type {
  CreateTeamRequest,
  TeamCreateResult,
  TeamCreatePhase1Result,
  TeamCreatePhase2Result,
  AgentCreateResult,
  AgentParseInfo,
} from "./types";
export { registerTeamCreateRoute, registerTeamRepairRoute } from "./http-route";
export {
  parseTeamsoulFile,
  extractAgentIds,
  extractCommonSection,
  extractAgentPrivateSection,
  parseAgentMetadataFromTag,
  deriveRoleFromAgentId,
} from "./soul-parser";