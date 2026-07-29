/**
 * 新建团队核心逻辑
 *
 * 功能17 (v19.35): 两阶段团队创建流程
 *
 * Phase 1: 团队目录初始化
 *   Step 1: teamId 格式校验
 *   Step 2: coordclaw.json teams[].id 去重
 *   Step 3: .data/teamsoul.md + team RULE.md 存在性校验
 *   Step 4: teamsoul.md 与 team RULE.md 的 agent_id 一致性校验（门禁）
 *   Step 5: 模板文件补充（跳过已有）
 *
 * Phase 2: Agent 创建与注册
 *   Step 6: 解析 teamsoul.md 提取 Agent 列表
 *   Step 7: openclaw.json 已有 agentId 去重校验（门禁）
 *   Step 8: 注册团队到 coordclaw.json（门禁操作，失败则中止 Phase 2）
 *   Step 9: 扩展 openclaw.json agents.list（teamId 放入 params 兜底字段）
 *   Step 10: 批量创建 workspace + 写入 SOUL.md
 *   Step 11: 解析 team RULE.md 获取成员详细信息
 *   Step 12: 写入 .data/team.json
 */

import fs from "fs";
import os from "os";
import path from "path";
import { info, warn, error, getEventId } from "../shared/logger";
import {
  getCoordClawTeamsDir,
  getTeamDir,
  getTeamDataDir,
  getTeamTemplateDataDir,
  getOpenClawJsonPath,
  getCoordClawJsonPath,
  getWorkspaceDirForAgent,
  getOpenClawUserDir,
  getCoordClawLogsDir,
  expandPath,
  TEAM_RULE_MD_FILENAME,
  TEAMSOUL_FILENAME,
} from "../shared/paths";
import { isAutoClaw, findAutoClawSettingsPath, getLobsterAIDbPath } from "../shared/agent-artifacts";
import { writeJsonSafe, writeJsonSafeOrThrow } from "../shared/json-atomic";
import { parseTeamsoulFile, extractCommonSection, extractAgentPrivateSection } from "./soul-parser";
import { parseTeamRuleFile, type RuleAgentInfo, type RuleHumanInfo, type RuleParseResult } from "../shared/rule-parser";
import type {
  CreateTeamRequest,
  TeamCreateResult,
  TeamCreatePhase1Result,
  TeamCreatePhase2Result,
  AgentCreateResult,
  AgentParseInfo,
} from "./types";

const MODULE = "team-create";

// AutoClaw 兼容层（isAutoClaw / findAutoClawSettingsPath 已迁至 shared/agent-artifacts）

/** 统一构造 agent 条目，供 openclaw.json / settings.json / runtime.json 复用 */
function buildAgentEntry(agent: AgentParseInfo, teamId: string) {
  const identityName = agent.roleLabel ? `${agent.name}-${agent.roleLabel}` : agent.name;
  return {
    id: agent.agentId,
    name: agent.name,
    identity: { name: identityName },
    workspace: path.join(getOpenClawUserDir(), `workspace-${agent.agentId}`),
    params: { teamId },
  };
}

// ==================== 独立日志 ====================

let teamCreateLogPath: string | null = null;

function getTeamCreateLogPath(): string {
  if (!teamCreateLogPath) {
    const logDir = getCoordClawLogsDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    teamCreateLogPath = path.join(logDir, "team-create.log");
  }
  return teamCreateLogPath;
}

function writeTeamCreateLog(msg: string): void {
  try {
    const logPath = getTeamCreateLogPath();
    const line = `${new Date().toISOString()} [TEAM-CREATE-V1] ${msg}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (_) {
    // 日志写入失败不影响主流程
  }
}

// ==================== Phase 1: 团队目录初始化 ====================

async function phase1ValidateAndPrepare(
  teamId: string,
  eventId: string | null
): Promise<TeamCreatePhase1Result> {
  const teamsDir = getCoordClawTeamsDir();
  const teamDir = getTeamDir(teamId);
  const dataDir = getTeamDataDir(teamId);

  info(MODULE, `[Phase1] === START === teamId=${teamId}`, eventId);
  writeTeamCreateLog(`PHASE1 START teamId=${teamId}`);

  // Step 1: teamId 格式校验
  if (!teamId || !/^[a-zA-Z][\w_-]*$/.test(teamId)) {
    const errMsg = `teamId 格式无效: "${teamId}"，仅允许字母开头、字母数字下划线连字符`;
    warn(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir: "",
      dataDir: "",
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }
  info(MODULE, `[Phase1] Step1 teamId 格式校验通过`, eventId);

  // Step 2: coordclaw.json ID 去重
  const jsonPath = getCoordClawJsonPath();
  if (!fs.existsSync(jsonPath)) {
    const errMsg = `coordclaw.json 不存在: ${jsonPath}`;
    warn(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }

  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(raw);
    const existingIds = (data.teams || []).map((t: any) => t.id);
    if (existingIds.includes(teamId)) {
      const errMsg = `teamId "${teamId}" 已存在于 coordclaw.json teams 列表中 (现有: ${existingIds.join(", ")})`;
      warn(MODULE, `[Phase1] ${errMsg}`, eventId);
      writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
      return {
        success: false,
        teamId,
        teamDir,
        dataDir,
        templateCopied: false,
        copiedFiles: [],
        error: errMsg,
      };
    }
  } catch (err: any) {
    const errMsg = `读取/解析 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }
  info(MODULE, `[Phase1] Step2 ID 唯一性校验通过`, eventId);

  // Step 3: .data/teamsoul.md 存在性校验
  if (!fs.existsSync(dataDir)) {
    const errMsg = `团队数据目录不存在: ${dataDir}/ (请确保前端已创建 ${teamDir}/.data/ 目录，并放入 ${TEAMSOUL_FILENAME} 和 ${path.basename(TEAM_RULE_MD_FILENAME)})`;
    warn(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }

  const teamsoulPath = path.join(dataDir, TEAMSOUL_FILENAME);
  if (!fs.existsSync(teamsoulPath)) {
    const errMsg = `缺少必需文件: ${teamsoulPath} (请确保前端已将 ${TEAMSOUL_FILENAME} 放入 .data/ 目录)`;
    warn(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }

  const teamRulePath = path.join(dataDir, path.basename(TEAM_RULE_MD_FILENAME));
  if (!fs.existsSync(teamRulePath)) {
    const errMsg = `缺少必需文件: ${teamRulePath} (请确保前端已将 ${path.basename(TEAM_RULE_MD_FILENAME)} 放入 .data/ 目录)`;
    warn(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }
  info(MODULE, `[Phase1] Step3 目录结构校验通过 (${TEAMSOUL_FILENAME} + ${path.basename(TEAM_RULE_MD_FILENAME)})`, eventId);

  // ====== Step 4: teamsoul.md 与 team RULE.md 的 agent_id 一致性校验（门禁）======
  try {
    const soulResult = parseTeamsoulFile(teamsoulPath, teamRulePath);
    const ruleResult = parseTeamRuleFile(dataDir);
    const soulIds = soulResult.map((a: any) => a.agentId);
    const ruleIds = ruleResult.agents.map((a: any) => a.agent_id);

    info(MODULE, `[Phase1] Step4 teamsoul.md=${soulIds.length} 个 agent, team RULE.md=${ruleIds.length} 个成员`, eventId);

    // 数量校验
    if (soulIds.length !== ruleIds.length) {
      const errMsg = `agent 数量不一致: teamsoul.md 有 ${soulIds.length} 个 (${soulIds.join(", ")}), team RULE.md 有 ${ruleIds.length} 个 (${ruleIds.join(", ")})`;
      warn(MODULE, `[Phase1] Step4 ${errMsg}`, eventId);
      writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
      return {
        success: false,
        teamId,
        teamDir,
        dataDir,
        templateCopied: false,
        copiedFiles: [],
        error: errMsg,
      };
    }

    // agent_id 集合一致性校验
    const soulSet = new Set(soulIds.map((id: string) => id.toLowerCase()));
    const ruleSet = new Set(ruleIds.map((id: string) => id.toLowerCase()));
    const onlyInSoul = soulIds.filter((id: string) => !ruleSet.has(id.toLowerCase()));
    const onlyInRule = ruleIds.filter((id: string) => !soulSet.has(id.toLowerCase()));

    if (onlyInSoul.length > 0 || onlyInRule.length > 0) {
      const details = [];
      if (onlyInSoul.length > 0) details.push(`teamsoul.md 独有: [${onlyInSoul.join(", ")}]`);
      if (onlyInRule.length > 0) details.push(`team RULE.md 独有: [${onlyInRule.join(", ")}]`);
      const errMsg = `agent_id 不一致: ${details.join("; ")}`;
      warn(MODULE, `[Phase1] Step4 ${errMsg}`, eventId);
      writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
      return {
        success: false,
        teamId,
        teamDir,
        dataDir,
        templateCopied: false,
        copiedFiles: [],
        error: errMsg,
      };
    }

    info(MODULE, `[Phase1] Step4 agent_id 一致性校验通过 (${soulIds.length} 个完全匹配)`, eventId);
  } catch (err: any) {
    const errMsg = `agent_id 一致性校验失败: ${err.message}`;
    error(MODULE, `[Phase1] Step4 ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }

  // Step 5: 模板文件补充（仅复制指定文件/文件夹，同名跳过）
  const templateDataDir = getTeamTemplateDataDir();
  if (!templateDataDir || !fs.existsSync(templateDataDir)) {
    const errMsg = `团队模板目录不存在: ${templateDataDir || "C:/Program Files/CoordClaw/teamstemplate/.data"}`;
    warn(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles: [],
      error: errMsg,
    };
  }

  const copiedFiles: string[] = [];
  try {
    // 仅复制指定的模板项：team.json、data/、scripts/
    const templateItems = ["team.json", "data", "scripts"];
    for (const item of templateItems) {
      const src = path.join(templateDataDir, item);
      if (!fs.existsSync(src)) {
        info(MODULE, `[Phase1] Step5 模板中不存在，跳过: ${item}`, eventId);
        continue;
      }
      const dst = path.join(dataDir, item);

      if (fs.statSync(src).isDirectory()) {
        // 目录：合并复制，已有文件覆盖，新增文件补上
        fs.cpSync(src, dst, { recursive: true, force: true });
      } else {
        // 文件：直接覆盖
        fs.copyFileSync(src, dst);
      }
      copiedFiles.push(item);
      info(MODULE, `[Phase1] Step5 已复制(合并): ${item}`, eventId);
    }
  } catch (err: any) {
    const errMsg = `模板文件复制失败: ${err.message}`;
    error(MODULE, `[Phase1] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE1 FAIL: ${errMsg}`);
    return {
      success: false,
      teamId,
      teamDir,
      dataDir,
      templateCopied: false,
      copiedFiles,
      error: errMsg,
    };
  }

  info(MODULE, `[Phase1] Step5 模板复制完成: ${copiedFiles.length} 个文件`, eventId);
  writeTeamCreateLog(`PHASE1 OK: copied ${copiedFiles.length} files`);

  return {
    success: true,
    teamId,
    teamDir,
    dataDir,
    templateCopied: true,
    copiedFiles,
  };
}

// ==================== Phase 2: Agent 创建与注册 ====================

async function phase2CreateAgents(
  teamId: string,
  dataDir: string,
  eventId: string | null
): Promise<TeamCreatePhase2Result> {
  info(MODULE, `[Phase2] === START === teamId=${teamId}`, eventId);
  writeTeamCreateLog(`PHASE2 START teamId=${teamId}`);

  // 非致命提示收集器：尽力而为步骤（RULE 解析告警、roleprompt 注入失败）写入此处，
  // 随结果返回，确保"非核心失败"也可见，而非被静默吞掉。
  const warnings: string[] = [];

  const teamsoulPath = path.join(dataDir, TEAMSOUL_FILENAME);
  const teamRulePath = path.join(dataDir, path.basename(TEAM_RULE_MD_FILENAME));

  // Step 6: 解析 teamsoul.md
  let agents: AgentParseInfo[];
  try {
    agents = parseTeamsoulFile(teamsoulPath, teamRulePath);
  } catch (err: any) {
    const errMsg = `解析 ${TEAMSOUL_FILENAME} 失败: ${err.message}`;
    error(MODULE, `[Phase2] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 FAIL: ${errMsg}`);
    return {
      success: false,
      agentsCreated: 0,
      totalAgents: 0,
      agents: [],
      openclawJsonUpdated: false,
      coordclawJsonUpdated: false,
      teamJsonWritten: false,
      warnings: [],
      error: errMsg,
    };
  }

  if (agents.length === 0) {
    const errMsg = `${TEAMSOUL_FILENAME} 中未找到任何 agent`;
    warn(MODULE, `[Phase2] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 FAIL: ${errMsg}`);
    return {
      success: false,
      agentsCreated: 0,
      totalAgents: 0,
      agents: [],
      openclawJsonUpdated: false,
      coordclawJsonUpdated: false,
      teamJsonWritten: false,
      warnings: [],
      error: errMsg,
    };
  }

  const agentIds = agents.map((a) => a.agentId);
  info(MODULE, `[Phase2] Step6 解析完成: ${agents.length} 个 agent [${agentIds.join(", ")}]`, eventId);

  // ====== Step 7: openclaw.json agentId 去重（仅警告，不阻断）======
  // agent 已存在属"尽力而为"场景：不失败，仅警告并由 registerCoordAgents 幂等跳过。
  try {
    const openclawJsonPath = getOpenClawJsonPath();
    if (!fs.existsSync(openclawJsonPath)) {
      throw new Error(`openclaw.json 不存在: ${openclawJsonPath}`);
    }
    const raw = fs.readFileSync(openclawJsonPath, "utf-8");
    const data = JSON.parse(raw);
    const existingAgentIds = new Set((data.agents?.list || []).map((a: any) => a.id));

    const duplicates = agentIds.filter((id) => existingAgentIds.has(id));
    if (duplicates.length > 0) {
      const dupMsg = `以下 agentId 已存在于 openclaw.json，将跳过注册（不失败）: [${duplicates.join(", ")}]`;
      warn(MODULE, `[Phase2] Step7 ${dupMsg}`, eventId);
      writeTeamCreateLog(`PHASE2 WARN (Step7): ${dupMsg}`);
      warnings.push(dupMsg);
      // 不阻断：下游 registerCoordAgents 对已有项本就幂等跳过
    } else {
      info(MODULE, `[Phase2] Step7 agentId 去重校验通过 (${agentIds.length} 个均不冲突)`, eventId);
    }
  } catch (err: any) {
    const errMsg = `agentId 去重校验失败（不阻断，继续尝试注册）: ${err.message}`;
    warn(MODULE, `[Phase2] Step7 ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 WARN (Step7): ${errMsg}`);
    warnings.push(errMsg);
    // 校验异常不阻断注册（尽力而为）：openclaw.json 不存在时 registerCoordAgents 会自行创建
  }

  // ==================== Step 11: 解析 team RULE.md 获取成员详细信息（前置工作，必须在注册 agent 前完成）====================
  let ruleAgents: RuleAgentInfo[] = [];
  let ruleHumans: RuleHumanInfo[] = [];
  let ruleResult: RuleParseResult | null = null;
  try {
    ruleResult = parseTeamRuleFile(dataDir);
    ruleAgents = ruleResult.agents;
    ruleHumans = ruleResult.humans;
    ruleResult.warnings.forEach((w) => warn(MODULE, `[Phase2] Step11 ${w}`, eventId)); // H-D 上报解析警告
    info(MODULE, `[Phase2] Step11 team RULE.md 解析完成: ${ruleAgents.length} 个成员, ${ruleHumans.length} 个人类`, eventId); // H-U
  } catch (err: any) {
    // RULE.md 解析属"尽力而为"：解析不出成员信息时，team.json 以空 members 写入并继续，
    // 不阻断 agent 注册与团队发布（保留原韧性）。原因记入 warnings，绝不静默。
    const errMsg = `解析 team RULE.md 失败（team.json 将以空 members 写入）: ${err.message}`;
    warn(MODULE, `[Phase2] Step11 ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 WARN (Step11): ${errMsg}`);
    warnings.push(errMsg);
    // ruleAgents 保持 []，继续走 Step12 写 team.json（前置工作不因此中断）
  }

  // ==================== Step 12: 写入 .data/team.json（前置工作，必须在注册 agent 前完成）====================
  let teamJsonWritten = false;
  try {
    const teamJsonPath = path.join(dataDir, "team.json");
    let teamJson: any = {};
    if (fs.existsSync(teamJsonPath)) {
      teamJson = JSON.parse(fs.readFileSync(teamJsonPath, "utf-8"));
    }

    // 填入字段：team_name 使用注册名称，project_name 为空（团队阶段无项目概念）
    teamJson.team_name = teamId;
    teamJson.project_name = "";

    // 构建 members 数组：从 team RULE.md 解析的 ruleAgents
    // role_prompt、append_message_prompts 复制模板参考成员的值
    const referenceRolePrompt = Array.isArray(teamJson.members?.[0]?.role_prompt)
      ? teamJson.members[0].role_prompt
      : [""];
    const referenceAppendMessagePrompts = teamJson.members?.[0]?.append_message_prompts || {
      enabled: false,
      behind: false,
      message: [""],
    };

    teamJson.members = ruleAgents.map((agent: RuleAgentInfo) => ({
      agent_id: agent.agent_id,
      name: agent.name,
      role: agent.role,
      authority_level: agent.authority_level,
      direct_supervisor: agent.direct_supervisor,
      direct_subordinate: agent.direct_subordinate,
      sessionKey: "",       // 团队阶段无 sessionKey
      description: agent.role,
      role_prompt: referenceRolePrompt,
      append_message_prompts: referenceAppendMessagePrompts,
    }));

    // 注入 rolepormpt.json 个性化提示词
    const rolePromptPath = path.join(dataDir, "roleprompt.json");
    if (fs.existsSync(rolePromptPath)) {
      try {
        const rolePromptJson = JSON.parse(fs.readFileSync(rolePromptPath, "utf-8"));
        const promptMembers = rolePromptJson?.members || [];
        for (const member of teamJson.members) {
          const matched = promptMembers.find((pm: any) => pm.agent_id === member.agent_id);
          if (matched?.role_prompt) member.role_prompt = [matched.role_prompt];
          if (matched?.append_message) member.append_message_prompts.message = [matched.append_message];
        }
        info(MODULE, `[Phase2] Step12 roleprompt.json 注入完成 (${promptMembers.length} 条)`, eventId);
        try { fs.unlinkSync(rolePromptPath); } catch {}  // 注入后清理
      } catch (rpErr: any) {
        const rpMsg = `roleprompt.json 注入失败(已跳过): ${rpErr.message}`;
        warn(MODULE, `[Phase2] Step12 ${rpMsg}`, eventId);
        warnings.push(rpMsg);
      }
    }

    // 同步 humanmember：仅当 RULE.md 声明了 HUMAN:START 才覆盖（H-R/H-AC，非破坏）
    if (ruleResult?.humanMemberDeclared) {
      teamJson.humanmember = ruleHumans;
    }

    // 原子写入
    writeJsonSafeOrThrow(teamJsonPath, teamJson, "[Phase2] Step12 写 team.json");
    teamJsonWritten = true;

    info(MODULE, `[Phase2] Step12 team.json 写入成功: ${teamJsonPath} (${ruleAgents.length} 个成员)`, eventId);
    writeTeamCreateLog(`PHASE2 OK (Step12): team.json written with ${ruleAgents.length} members`);
  } catch (err: any) {
    // 核心步骤（写 team.json）失败：不再静默降级为 success:true。
    // 记 ERROR 级日志 + 收集 warnings，然后向上抛出，由 createTeam 顶层统一处理为诚实的失败。
    // 此时尚未注册 agent、尚未写 coordclaw.json，抛出即干净回退，无孤儿副作用。
    const errMsg = `写入 team.json 失败: ${err.message}`;
    error(MODULE, `[Phase2] Step12 ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 FAIL (Step12): ${errMsg}`);
    warnings.push(errMsg);
    throw new Error(errMsg);
  }

  // registerCoordAgents 已处理 workspace + SOUL.md，直接构建结果列表
  const agentResults: AgentCreateResult[] = agents.map((agent) => {
    const workspaceDir = getWorkspaceDirForAgent(agent.agentId);
    const displayName = agent.roleLabel ? `${agent.name}-${agent.roleLabel}` : agent.name;
    return { agentId: agent.agentId, name: displayName, workspaceDir, soulWritten: true };
  });
  const createdCount = agentResults.length;

  // ==================== Step 9: 扩展 openclaw.json agents.list（注册 agent，前置工作全部完成后才执行）====================
  let openclawJsonUpdated = false;
  let openclawBackup: string | null = null;
  try {
    const jsonPath = getOpenClawJsonPath();
    info(MODULE, `[Phase2] Step9 开始扩展 openclaw.json: path=${jsonPath}`, eventId);
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`openclaw.json 不存在: ${jsonPath}`);
    }
    // Step 7 已校验过无重复，registerCoordAgents 幂等，一次读写 openclaw.json
    const r = await registerCoordAgents(agents.map(a => ({ teamId, parsedAgent: a })));
    openclawBackup = r.before;  // 写前原文，供 catch 回滚（复用，避免冗余预读）
    const registeredCount = r.repaired;
    const skippedCount = r.skipped;

    openclawJsonUpdated = registeredCount > 0 || agents.length === 0;
    info(MODULE, `[Phase2] Step9 openclaw.json 扩展完成: 新增=${registeredCount}, 跳过=${skippedCount}, 失败=${r.failed}`, eventId);
    writeTeamCreateLog(`PHASE2 openclaw.json updated: added=${registeredCount} skipped=${skippedCount} total=${agents.length}`);
    if (registeredCount > 0) writeTeamCreateLog(`PHASE2 AutoClaw sync: agents=${agents.length}`);
  } catch (err: any) {
    const errMsg = `扩展 openclaw.json 失败: ${err.message}`;
    error(MODULE, `[Phase2] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 FAIL: ${errMsg}`);
    // 回滚 openclaw.json（此时 coordclaw.json 尚未写入，无需回滚，无孤儿副作用）
    if (openclawBackup) {
      try {
        const rb = writeJsonSafe(getOpenClawJsonPath(), JSON.parse(openclawBackup));
        if (!rb.ok) throw new Error(rb.error);
        info(MODULE, `[Phase2] Step9 openclaw.json 已回滚`, eventId);
      } catch (rbErr: any) {
        error(MODULE, `[Phase2] Step9 回滚 openclaw.json 失败: ${rbErr.message}`, eventId);
      }
    }
    return {
      success: false,
      agentsCreated: 0,
      totalAgents: agents.length,
      agents: [],
      openclawJsonUpdated: false,
      coordclawJsonUpdated: false,
      teamJsonWritten,
      warnings: [],
      error: errMsg,
    };
  }

  // ==================== Step 8: 注册团队到 coordclaw.json（最后一步：agent 已注册、team.json 已写，再发布团队）====================
  let coordclawJsonUpdated = false;
  let coordclawBackup: string | null = null;
  try {
    const jsonPath = getCoordClawJsonPath();
    const raw = fs.readFileSync(jsonPath, "utf-8");
    coordclawBackup = raw;
    const data = JSON.parse(raw);

    data.teams = data.teams || [];
    // Anchor templatePath to ~ if under home (P2a #20: cross-platform templatePath)
    const teamDirAbs = getTeamDir(teamId).replace(/\\/g, "/");
    const homeDir = os.homedir().replace(/\\/g, "/");
    const anchoredTemplatePath = (teamDirAbs.startsWith(homeDir + "/") || teamDirAbs === homeDir)
      ? "~/" + teamDirAbs.slice(homeDir.length).replace(/^\//, "")
      : teamDirAbs;
    data.teams.push({
      id: teamId,
      name: teamId,
      templatePath: anchoredTemplatePath,
      agents: agentIds,
      projects: [],
    });

    writeJsonSafeOrThrow(jsonPath, data, "[Phase2] Step8 注册 coordclaw.json");
    coordclawJsonUpdated = true;
    info(MODULE, `[Phase2] Step8 coordclaw.json 注册成功: teamId=${teamId}`, eventId);
    writeTeamCreateLog(`PHASE2 coordclaw.json updated: teamId=${teamId} agents=[${agentIds.join(",")}]`);
  } catch (err: any) {
    const errMsg = `注册团队到 coordclaw.json 失败: ${err.message}`;
    error(MODULE, `[Phase2] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 FAIL: ${errMsg}`);
    // 回滚 coordclaw.json（agent 已注册，属较难撤销的持久副作用，保留并如实上报失败）
    if (coordclawBackup) {
      try {
        const rb = writeJsonSafe(getCoordClawJsonPath(), JSON.parse(coordclawBackup));
        if (!rb.ok) throw new Error(rb.error);
        info(MODULE, `[Phase2] Step8 coordclaw.json 已回滚`, eventId);
      } catch (rbErr: any) {
        error(MODULE, `[Phase2] Step8 回滚 coordclaw.json 失败: ${rbErr.message}`, eventId);
      }
    }
    return {
      success: false,
      agentsCreated: createdCount,
      totalAgents: agents.length,
      agents: agentResults,
      openclawJsonUpdated,
      coordclawJsonUpdated: false,
      teamJsonWritten,
      warnings: [],
      error: errMsg,
    };
  }

  return {
    success: true,
    agentsCreated: createdCount,
    totalAgents: agents.length,
    agents: agentResults,
    openclawJsonUpdated,
    coordclawJsonUpdated,
    teamJsonWritten,
    warnings,
  };
}

// ==================== Agent 修复/初始化 ====================

// ==================== 批量注册 & 同步（公共 helper） ====================

/**
 * 批量写 openclaw.json：读一次 → push 所有新 agent → 原子写一次。
 * 幂等：已存在的 agentId 记为 skipped，不重复写。
 * 返回 before（写前原文），供调用方回滚 & AutoClaw 快照复用。
 */
function applyAgentsToOpenClaw(
  candidates: Array<{ teamId: string; parsedAgent: AgentParseInfo }>
): {
  repaired: number;
  skipped: number;
  failed: number;
  details: TeamRepairResult["details"];
  before: string | null;
} {
  const details: TeamRepairResult["details"] = [];
  let repaired = 0, skipped = 0, failed = 0;
  let before: string | null = null;
  try {
    const op = getOpenClawJsonPath();
    before = fs.readFileSync(op, "utf-8");
    const data = JSON.parse(before);
    data.agents = data.agents || { defaults: {}, list: [] };
    data.agents.list = data.agents.list || [];
    const existing = new Set(data.agents.list.map((a: any) => a.id));
    let dirty = false;
    for (const { teamId, parsedAgent: agent } of candidates) {
      if (existing.has(agent.agentId)) {
        details.push({ teamId, agentId: agent.agentId, status: "skipped" });
        skipped++;
      } else {
        data.agents.list.push(buildAgentEntry(agent, teamId));
        existing.add(agent.agentId);
        dirty = true;
        details.push({ teamId, agentId: agent.agentId, status: "repaired" });
        repaired++;
      }
    }
    if (dirty) writeJsonSafeOrThrow(op, data, "写 openclaw.json");  // 写一次（安全）
  } catch (err: any) {
    // openclaw.json 读写失败：全部计为 failed（before 可能已持有原文供回滚）
    for (const { teamId, parsedAgent: agent } of candidates) {
      details.push({ teamId, agentId: agent.agentId, status: "failed", error: err.message });
      failed++;
    }
    repaired = 0; skipped = 0;
  }
  return { repaired, skipped, failed, details, before };
}

/** 默认工作日志模板内容（与脚本 worklog_default_content 一致） */
const DEFAULT_WORKLOG_PREFIX = "WorkLog";
const DEFAULT_WORKLOG_CONTENT =
  "# 当你阅读此工作日志时，表示新任务已开始。你必须在每条消息任务完成后编写工作日志，并基于最新日期的工作日志完成后续任务。\n";

/**
 * 解析团队 .data/worklog.md 模板（front matter 取 filename_prefix，正文作默认内容）。
 * 文件缺失/解析失败则回退默认。镜像脚本 parse_worklog_template。
 */
function parseWorklogTemplate(dataDir: string): { prefix: string; content: string } {
  const file = path.join(dataDir, "worklog.md");
  if (!fs.existsSync(file)) return { prefix: DEFAULT_WORKLOG_PREFIX, content: DEFAULT_WORKLOG_CONTENT };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { prefix: DEFAULT_WORKLOG_PREFIX, content: DEFAULT_WORKLOG_CONTENT };
  }
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
  if (!m) return { prefix: DEFAULT_WORKLOG_PREFIX, content: raw };
  const front = m[1];
  const body = m[2];
  let prefix = DEFAULT_WORKLOG_PREFIX;
  for (const line of front.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes(":")) continue;
    const idx = s.indexOf(":");
    const k = s.slice(0, idx).trim();
    if (k === "filename_prefix") {
      prefix = s.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { prefix, content: body };
}

/**
 * 只建 workspace + 写 SOUL.md（不碰 openclaw.json）。
 * 另按团队模板为每个 agent 创建默认工作日志（teamDir/worklog/<name>/，镜像脚本 createteam.py setup_worklog_directory）。
 * 无条件覆盖 SOUL.md，幂等；写失败不阻断注册（与旧行为一致）。
 */
function ensureAgentWorkspace(agent: AgentParseInfo, worklogTpl: { prefix: string; content: string }, teamDir: string): void {
  try {
    const ws = getWorkspaceDirForAgent(agent.agentId);
    if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
    const sc = agent.soulCommon ? `${agent.soulCommon}\n\n---\n\n${agent.soulPrivate}\n` : `${agent.soulPrivate}\n`;
    fs.writeFileSync(path.join(ws, "SOUL.md"), sc, "utf-8");

    // 默认工作日志（基于团队 .data/worklog.md 模板，幂等）—— 落团队级目录，镜像脚本 createteam.py setup_worklog_directory
    const wlDir = path.join(teamDir, "worklog", agent.name);
    if (!fs.existsSync(wlDir)) fs.mkdirSync(wlDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const wlFile = path.join(wlDir, `${worklogTpl.prefix}-${agent.name}-${today}-001.md`);
    if (!fs.existsSync(wlFile)) fs.writeFileSync(wlFile, worklogTpl.content, "utf-8");
  } catch { /* workspace/SOUL/工作日志 写入非致命 */ }
}

/**
 * 将新增 agent 同步到 AutoClaw 的 settings.json 与 openclaw.runtime.json。
 * 供 createTeam Step9 和 repairTeamAgents 复用。
 */
function syncAutoClawCompat(
  agents: Array<{ teamId: string; parsedAgent: AgentParseInfo }>,
  baseConfig?: any
): void {
  if (!isAutoClaw()) return;
  const eventId = getEventId();
  const settingsPath = findAutoClawSettingsPath();
  const runtimePath = path.join(getOpenClawUserDir(), "openclaw.runtime.json");

  // --- settings.json ---
  if (settingsPath) {
    try {
      const d = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      d.agents = d.agents || [];
      const ids = new Set(d.agents.map((a: any) => a.id));
      let n = 0;
      for (const { teamId, parsedAgent: a } of agents) {
        if (ids.has(a.agentId)) continue;
        d.agents.push({ ...buildAgentEntry(a, teamId), runtimeTarget: "local" });
        ids.add(a.agentId);
        n++;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(d, null, 2), "utf-8");
      if (n > 0) info(MODULE, `[AutoClaw] settings.json 同步: ${n} agents`, eventId);
    } catch (e: any) {
      warn(MODULE, `[AutoClaw] settings.json 同步失败: ${e.message}`, eventId);
    }
  }

  // --- runtime.json ---
  try {
    let d: any;
    if (fs.existsSync(runtimePath)) {
      d = JSON.parse(fs.readFileSync(runtimePath, "utf-8"));
    } else if (baseConfig) {
      d = JSON.parse(JSON.stringify(baseConfig));
    } else {
      d = JSON.parse(fs.readFileSync(getOpenClawJsonPath(), "utf-8"));
    }
    d.agents = d.agents || { defaults: {}, list: [] };
    d.agents.list = d.agents.list || [];
    const ids = new Set(d.agents.list.map((a: any) => a.id));
    let n = 0;
    for (const { teamId, parsedAgent: a } of agents) {
      if (ids.has(a.agentId)) continue;
      d.agents.list.push(buildAgentEntry(a, teamId));
      ids.add(a.agentId);
      n++;
    }
    fs.writeFileSync(runtimePath, JSON.stringify(d, null, 2), "utf-8");
    if (n > 0) info(MODULE, `[AutoClaw] runtime.json 同步: ${n} agents`, eventId);
  } catch (e: any) {
    warn(MODULE, `[AutoClaw] runtime.json 同步失败: ${e.message}`, eventId);
  }
}

/** 共享的 Agent 发现逻辑，供 registerMissingAgents 和 repairTeamAgents 复用 */
function discoverMissingAgents(existingIds: Set<string>): Array<{
  teamId: string;
  parsedAgent: AgentParseInfo;
  dataDir: string;
}> {
  const result: Array<{ teamId: string; parsedAgent: AgentParseInfo; dataDir: string }> = [];

  const coordPath = getCoordClawJsonPath();
  if (!fs.existsSync(coordPath)) return result;
  const coordData = JSON.parse(fs.readFileSync(coordPath, "utf-8"));
  const teams = coordData.teams || [];
  if (teams.length === 0) return result;

  for (const team of teams) {
    const teamId: string = team.id;
    const agentIds: string[] = team.agents || [];
    const dataDir = team.templatePath ? path.join(expandPath(team.templatePath), ".data") : getTeamDataDir(teamId);

    for (const agentId of agentIds) {
      if (existingIds.has(agentId)) continue;

      const soulPath = path.join(dataDir, TEAMSOUL_FILENAME);
      if (!fs.existsSync(soulPath)) continue;
      const rulePath = path.join(dataDir, TEAM_RULE_MD_FILENAME);
      const soul = parseTeamsoulFile(soulPath, fs.existsSync(rulePath) ? rulePath : undefined);
      const pa = soul.find((a: AgentParseInfo) => a.agentId === agentId);
      if (!pa) continue;

      result.push({ teamId, parsedAgent: pa, dataDir });
      existingIds.add(agentId); // 去重
    }
  }
  return result;
}

/**
 * 将 agent 写入 LobsterAI SQLite，使后续 sync() 包含 CoordClaw agent。
 * 仅在数据库文件存在时执行（自动兼容标准 openclaw / AutoClaw）。
 */
function syncToLobsterAIDB(agents: Array<{ teamId: string; parsedAgent: AgentParseInfo }>) {
  if (agents.length === 0) return;
  try {
    const dbPath = getLobsterAIDbPath();
    if (!fs.existsSync(dbPath)) return;

    const { DatabaseSync } = require("node:sqlite") as any;
    const db = new DatabaseSync(dbPath, { open: true });
    const now = Date.now();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, model, working_directory, enabled, is_default, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, 'custom', ?, ?)`
    );
    for (const { parsedAgent: pa } of agents) {
      try { insert.run(pa.agentId, pa.name, "", getWorkspaceDirForAgent(pa.agentId), now, now); } catch {}
    }
    db.close();
  } catch {}
}

/**
 * 扫描 coordclaw.json 全量 team，注册缺失的 agent 到 openclaw.json。
 * 兼容性分支（AutoClaw / LobsterAI）由 registerCoordAgents 内部自检测。
 * （原名 registerAgentsViaRpc，已无 RPC，纯文件写，故更名）
 */
export async function registerMissingAgents(): Promise<TeamRepairResult> {
  const eventId = getEventId();
  info(MODULE, `[REGISTER-MISSING] === START ===`, eventId);

  const candidates = discoverMissingAgents(new Set());
  if (candidates.length === 0) {
    info(MODULE, `[REGISTER-MISSING] 无候选 agent`, eventId);
    return { success: true, teamsProcessed: 0, agentsMissing: 0, agentsRepaired: 0, agentsFailed: 0, details: [] };
  }

  let teamsCount = 0;
  try {
    const cp = getCoordClawJsonPath();
    if (fs.existsSync(cp)) {
      teamsCount = (JSON.parse(fs.readFileSync(cp, "utf-8")).teams || []).length;
    }
  } catch {}

  const { repaired, failed, details } = await registerCoordAgents(candidates);

  info(MODULE, `[REGISTER-MISSING] done candidates=${candidates.length} r=${repaired} f=${failed}`, eventId);
  return { success: failed === 0, teamsProcessed: teamsCount, agentsMissing: candidates.length, agentsRepaired: repaired, agentsFailed: failed, details };
}

export interface TeamRepairResult {
  success: boolean;
  teamsProcessed: number;
  agentsMissing: number;
  agentsRepaired: number;
  agentsFailed: number;
  details: Array<{
    teamId: string;
    agentId: string;
    status: string;
    error?: string;
  }>;
}

// ==================== Agent 注册统一入口 ====================

/**
 * 注册 CoordClaw agent 的唯一公共入口。
 * 公用层：写 openclaw.json + workspace SOUL.md。
 * 兼容性分支：isAutoClaw() → settings.json + openclaw.runtime.json；LobsterAI → SQLite。
 * 所有注册路径（createTeam / registerMissingAgents / repairTeamAgents）统一走此函数。
 */
export async function registerCoordAgents(
  candidates: Array<{ teamId: string; parsedAgent: AgentParseInfo }>
): Promise<{
  repaired: number; skipped: number; failed: number;
  details: TeamRepairResult["details"];
  before: string | null;
}> {
  const eventId = getEventId();
  const t0 = performance.now();
  info(MODULE, `[REGISTER] === START: candidates=${candidates.length}`, eventId);

  // ① 公用层：一次读写 openclaw.json（before = 写前原文，供回滚 & AutoClaw 快照复用）
  const tOpenClaw = performance.now();
  const result = applyAgentsToOpenClaw(candidates);
  const tAfterOpenClaw = performance.now();

  // ② 逐个建 workspace + 写 SOUL.md + 默认工作日志（不同文件，必须逐个）
  const worklogTpl = candidates.length
    ? parseWorklogTemplate(getTeamTemplateDataDir())
    : { prefix: DEFAULT_WORKLOG_PREFIX, content: DEFAULT_WORKLOG_CONTENT };
  const teamDir = candidates.length ? getTeamDir(candidates[0].teamId) : "";
  for (const { parsedAgent } of candidates) ensureAgentWorkspace(parsedAgent, worklogTpl, teamDir);
  const tAfterWorkspace = performance.now();

  // ③ 兼容性分支（各自内部自检）
  //    AutoClaw 需 openclaw.json 写前状态区分新/旧 agent，直接复用 before 快照
  if (isAutoClaw() && result.before) {
    let snapshot: any = null;
    try { snapshot = JSON.parse(result.before); } catch {}
    if (snapshot) syncAutoClawCompat(candidates, snapshot);
  }
  const tAfterAutoClaw = performance.now();
  syncToLobsterAIDB(candidates);
  const tAfterLobster = performance.now();

  info(MODULE, `[PERF] registerCoordAgents: total=${(tAfterLobster - t0).toFixed(1)}ms | openclaw=${(tAfterOpenClaw - tOpenClaw).toFixed(1)}ms workspace=${(tAfterWorkspace - tAfterOpenClaw).toFixed(1)}ms autoclaw=${(tAfterAutoClaw - tAfterWorkspace).toFixed(1)}ms lobster=${(tAfterLobster - tAfterAutoClaw).toFixed(1)}ms (candidates=${candidates.length})`, eventId);
  info(MODULE, `[REGISTER] done: r=${result.repaired} s=${result.skipped} f=${result.failed}`, eventId);
  return result;
}

export async function repairTeamAgents(teamIds?: string[]): Promise<TeamRepairResult> {
  const eventId = getEventId();
  info(MODULE, `[REPAIR] === AGENT-REPAIR START ===`, eventId);

  const oc = getOpenClawJsonPath();
  if (!fs.existsSync(oc)) {
    return { success: false, teamsProcessed: 0, agentsMissing: 0, agentsRepaired: 0, agentsFailed: 0, details: [] };
  }
  const ocData = JSON.parse(fs.readFileSync(oc, "utf-8"));
  const existingIds = new Set<string>((ocData.agents?.list || []).map((a: any) => a.id));

  const missing = discoverMissingAgents(existingIds);
  const { repaired, failed, details } = await registerCoordAgents(missing);

  info(MODULE, `[REPAIR] 完成: missing=${missing.length} repaired=${repaired} failed=${failed}`, eventId);
  return { success: true, teamsProcessed: 0, agentsMissing: missing.length, agentsRepaired: repaired, agentsFailed: failed, details };
}

// ==================== 主入口 ====================

export async function createTeam(req: CreateTeamRequest): Promise<TeamCreateResult> {
  const eventId = getEventId();
  const { teamId } = req;

  info(MODULE, `[CREATE] === TEAM-CREATE START === teamId=${teamId}`, eventId);
  writeTeamCreateLog(`=== START === teamId=${teamId}`);

  // ====== Phase 1: 团队目录初始化 ======
  const tPhase1 = performance.now();
  const phase1 = await phase1ValidateAndPrepare(teamId, eventId);
  info(MODULE, `[PERF] Phase1 (团队目录初始化/模板复制): ${(performance.now() - tPhase1).toFixed(1)}ms`, eventId);
  if (!phase1.success) {
    return {
      success: false,
      message: `Phase 1 失败: ${phase1.error}`,
      phase1,
      phase2: null,
    };
  }

  // ====== Phase 2: Agent 创建与注册 ======
  // 顶层唯一兜底：phase2 内部的核心步骤（如写 team.json）失败会向上抛出，
  // 此处统一转成诚实的失败响应，确保任何异常都不会再被静默降级为 success:true。
  let phase2: TeamCreatePhase2Result;
  const tPhase2 = performance.now();
  try {
    phase2 = await phase2CreateAgents(teamId, phase1.dataDir, eventId);
  } catch (err: any) {
    const errMsg = `Phase2 执行异常（团队目录与 agent 已创建，但后续步骤失败）: ${err.message}`;
    error(MODULE, `[CREATE] ${errMsg}`, eventId);
    writeTeamCreateLog(`PHASE2 EXCEPTION: ${errMsg}`);
    return {
      success: false,
      message: errMsg,
      phase1,
      phase2: null,
    };
  }

  info(MODULE, `[PERF] Phase2 (Agent 创建与注册): ${(performance.now() - tPhase2).toFixed(1)}ms`, eventId);

  const message = phase2.success
    ? `团队 ${teamId} 创建成功: Phase1 模板补充完成, Phase2 创建 ${phase2.agentsCreated}/${phase2.totalAgents} 个 agent, openclaw.json=${phase2.openclawJsonUpdated}, coordclaw.json=${phase2.coordclawJsonUpdated}, teamJson=${phase2.teamJsonWritten}`
    : `团队 ${teamId} 创建部分完成: Phase1 成功, Phase2 失败 - ${phase2.error}`;

  info(MODULE, `[CREATE] === DONE === ${message}`, eventId);
  writeTeamCreateLog(`=== DONE === ${message}`);

  return {
    success: phase2.success,
    message,
    phase1,
    phase2,
  };
}