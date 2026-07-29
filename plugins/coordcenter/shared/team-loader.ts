import { info, getEventId } from "./logger";
import { resolveProjectRoot, loadProjectTeamJson } from "../prompt-injection";

export interface TeamMember {
  name: string;
  agent_id: string;
  sessionKey: string;
  authority_level?: string;
}

export interface TeamContext {
  projectRoot: string;
  members: TeamMember[];
}

export async function loadTeamContext(
  jsonPath: string,
  cacheTtl: number,
  caller: string = "team-loader",
): Promise<TeamContext> {
  const eventId = getEventId();
  info(caller, `[TEAM] 加载团队上下文 path=${jsonPath}`, eventId);

  const projectRoot = await resolveProjectRoot(jsonPath, cacheTtl);
  info(caller, `[TEAM] projectRoot=${projectRoot}`, eventId);

  const teamData = await loadProjectTeamJson(projectRoot, cacheTtl);

  const rawMembers = Array.isArray(teamData?.members) ? teamData.members : [];
  const members: TeamMember[] = rawMembers
    .filter((m: any) => typeof m?.agent_id === "string")
    .map((m: any) => ({
      name: m.name || m.agent_id,
      agent_id: m.agent_id,
      sessionKey: m.sessionKey || "",
      authority_level: m.authority_level,
    }));

  info(caller, `[TEAM] 加载完成: ${members.length} 成员`, eventId);
  return { projectRoot, members };
}