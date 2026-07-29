/**
 * 功能模块：规则注入（prompt-injection）
 *
 * 在 before_prompt_build 钩子中，根据 agentId 从 teamsoul.md 中提取：
 * - 通用规则（common section）
 * - 角色专属规则（agent section）
 *
 * 支持模板占位符替换：<#projectroot#>、<#name#>、<#agentid#> 等
 */

import {
  resolveRuleFilePath,
  loadRuleMd,
  extractAgentIds,
  extractCommonSection,
  extractAgentSection,
  loadProjectTeamJson,
  extractSessionKeys,
  resolveProjectRoot,
} from "./loader";

export {
  loadProjectTeamJson,
  extractSessionKeys,
  resolveProjectRoot,
  resolveRuleFilePath,
  loadRuleMd,
  extractAgentIds,
  extractCommonSection,
  extractAgentSection,
};

import { info, error, getEventId } from "../shared/logger";
import { renderTemplate } from "../shared/template";
import type { AgentDispatchContext } from "../shared/types";
import type { BeforePromptBuildResult } from "../types/contracts";

export interface PromptInjectionConfig {
  jsonPath: string;
  cacheTtl: number;
}

// 继承框架 before_prompt_build 契约（types/contracts.ts 本地 mirror），
// 使 appendSystemContext 等字段类型错配在编译期可见，而非运行时静默丢弃。
export interface PromptInjectionResult extends BeforePromptBuildResult {
  appendSystemContext: string;
}

export async function handlePromptInjection(
  agentId: string,
  config: PromptInjectionConfig
): Promise<PromptInjectionResult | undefined> {
  try {
    const ruleFilePath = await resolveRuleFilePath(config.jsonPath);
    const ruleMd = await loadRuleMd(ruleFilePath, config.cacheTtl);
    const known = extractAgentIds(ruleMd);
    if (known.length > 0 && !known.includes(agentId)) return undefined;

    const common = extractCommonSection(ruleMd);
    const agentPart = extractAgentSection(ruleMd, agentId);
    if (!common && !agentPart) return undefined;

    const projectRoot = await resolveProjectRoot(config.jsonPath, config.cacheTtl);
    const teamData = await loadProjectTeamJson(projectRoot, config.cacheTtl);
    const toolInjectionPrompts = teamData.tool_injection_prompts;

    const parts: string[] = [];
    if (common) parts.push(common);
    if (!toolInjectionPrompts && agentPart) parts.push(agentPart);

    const rawContent = parts.join("\n\n---\n\n");

    const ctx: AgentDispatchContext = {
      agentId,
      agentName: agentId,
      sessionKey: '',
      state: 1 as any,
      isPM: false,
      teamHasUnread: false,
      members: [],
      teamData: null,
      logger: { info, error },
      projectRoot,
    };

    const renderedContent = renderTemplate(rawContent, ctx);

    const injectedContent = `\n\n# CoordClaw 团队角色规则（自动注入）\n\n${renderedContent}`;
    const previewLines = injectedContent.split('\n').filter(l => l.trim()).slice(0, 2).join(' | ');
    info('prompt-injection', `[FUNC: handlePromptInjection] agent=${agentId} 规则内容构建完成 (${injectedContent.length}chars), projectRoot=${projectRoot}, preview: ${previewLines}`, getEventId());

    // 注意：此处仅代表规则字符串构建完成，不代表框架已将其合并进 system prompt。
    // 框架通过 before_prompt_build 返回值契约消费 appendSystemContext（须为 string），
    // 是否真正拼入由框架决定，插件侧无回执，日志不得标注"注入成功"。
    return { appendSystemContext: injectedContent };
  } catch (err: any) {
    error('prompt-injection', `[FUNC: handlePromptInjection] 规则注入失败: ${err.message}`, getEventId());
    return undefined;
  }
}
