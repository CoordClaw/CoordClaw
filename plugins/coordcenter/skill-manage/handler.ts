/**
 * skill-manage handler — Skill 管理业务逻辑
 *
 *   - skills.status → 获取 workspace skill 列表（含描述、禁用状态等）
 *   - 直写 openclaw.json → 开关 skill（Gateway 文件监听 300ms 自动热加载）
 */

import * as fs from "fs";
import { debug, info, warn, getEventId } from "../shared/logger";
import { getOpenClawJsonPath } from "../shared/paths";

const MODULE = "skill-manage";

export interface SkillInfo {
  name: string;
  description?: string;
  source?: string;
  bundled?: boolean;
  disabled?: boolean;
  eligible?: boolean;
  emoji?: string;
  homepage?: string;
  requirements?: string[];
  missing?: string[];
}

export interface SkillListResult {
  success: boolean;
  skills: SkillInfo[];
  message?: string;
}

export interface SkillSetParams {
  agentId?: string;   // 可选，默认 default agent
  skillName: string;
  enabled: boolean;
}

export interface SkillSetResult {
  success: boolean;
  skillName: string;
  enabled: boolean;
  message?: string;
}

/** 获取 skill 列表 */
export async function getSkillList(agentId?: string): Promise<SkillListResult> {
  const eventId = getEventId();
  try {
    const { callGatewayRpc } = await import("../shared/gateway-rpc");
    const params: any = {};
    if (agentId) params.agentId = agentId;
    const result = await callGatewayRpc({
      method: "skills.status",
      params,
      timeoutMs: 10_000,
    });
    const skills: SkillInfo[] = (result?.skills || []).map((s: any) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      bundled: s.bundled,
      disabled: s.disabled,
      eligible: s.eligible,
      emoji: s.emoji,
      homepage: s.homepage,
      requirements: s.requirements,
      missing: s.missing,
    }));
    info(MODULE, `[LIST] ${skills.length} skills from Gateway`, eventId);
    return { success: true, skills };
  } catch (err: any) {
    warn(MODULE, `[LIST] failed: ${err.message}`, eventId);
    return { success: false, skills: [], message: err.message };
  }
}

/** 开关 skill（直写 openclaw.json，Gateway 文件监听 300ms 自动热加载）
 *
 *  规则：
 *    - 全局：skills.entries[skillName] = { enabled }，enabled=true 时删条目（默认启用无需写）
 *    - Per-agent：skills[] 白名单数组。启用→加入数组，禁用→移出数组，空数组=全部禁用，无该字段=继承全局
 */
export async function setSkill(params: SkillSetParams): Promise<SkillSetResult> {
  const eventId = getEventId();
  const { agentId, skillName, enabled } = params;

  if (!skillName) {
    return { success: false, skillName: "", enabled: false, message: "skillName is required" };
  }

  try {
    const jsonPath = getOpenClawJsonPath();
    if (!fs.existsSync(jsonPath)) {
      return { success: false, skillName, enabled, message: "openclaw.json not found" };
    }
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(raw);
    data.agents = data.agents || { list: [] };
    data.agents.list = data.agents.list || [];

    if (agentId) {
      // ==================== Per-agent ====================
      const agent = data.agents.list.find((a: any) => a.id === agentId);
      if (!agent) {
        return { success: false, skillName, enabled, message: `agent not found: ${agentId}` };
      }

      if (enabled) {
        // 启用：加白名单
        if (!Array.isArray(agent.skills)) {
          agent.skills = [skillName];
        } else if (!agent.skills.includes(skillName)) {
          agent.skills.push(skillName);
        }
        info(MODULE, `[SET] agent=${agentId} ${skillName} → enabled`, eventId);
      } else {
        // 禁用：移出白名单
        if (Array.isArray(agent.skills)) {
          agent.skills = agent.skills.filter((s: string) => s !== skillName);
          // 空数组保留（语义："全部禁用"），与不写 skills 字段不同
        } else {
          // 本来就没有 skills 字段（继承全局），需要显式创建白名单并排除此项
          agent.skills = [];
        }
        info(MODULE, `[SET] agent=${agentId} ${skillName} → disabled`, eventId);
      }
    } else {
      // ==================== 全局 ====================
      data.skills = data.skills || {};
      data.skills.entries = data.skills.entries || {};

      if (enabled) {
        // enabled=true 是默认值，删条目即可（不写冗余配置）
        delete data.skills.entries[skillName];
        info(MODULE, `[SET] global ${skillName} → enabled (default)`, eventId);
      } else {
        data.skills.entries[skillName] = { enabled: false };
        info(MODULE, `[SET] global ${skillName} → disabled`, eventId);
      }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
    return { success: true, skillName, enabled };
  } catch (err: any) {
    warn(MODULE, `[SET] failed: ${err.message}`, eventId);
    return { success: false, skillName, enabled: false, message: err.message };
  }
}
