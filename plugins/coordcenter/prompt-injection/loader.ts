import fs from "fs/promises";
import path from "path";
import os from "os";
import { debug, warn, info, getEventId } from "../shared/logger";
import { getTeamJsonPath, getTeamRuleMdPath, expandPath } from "../shared/paths";

let ruleCache: { raw: string; timestamp: number } | null = null;
// rulePathCache 带 TTL，与 ruleCache / projectTeamJsonCache 保持一致的过期策略
// 当 coorclaw.json 中的 active 项目切换后，缓存过期后下次请求会自动重新解析
let rulePathCache: { root: string; timestamp: number } | null = null;
let projectTeamJsonCache: { raw: string; timestamp: number; projectRoot: string; parsed: { members: { agent_id: string; sessionKey: string }[]; tool_injection_prompts?: boolean; resetcontext?: { internal_plugin?: boolean; external_tools?: boolean } } } | null = null;
const DEFAULT_CACHE_TTL_MS = 60_000;

export async function loadProjectTeamJson(projectRoot: string, cacheTtlMs: number): Promise<{ members: { agent_id: string; name?: string; sessionKey: string }[]; tool_injection_prompts?: boolean; resetcontext?: { internal_plugin?: boolean; external_tools?: boolean } }> {
  const now = Date.now();
  if (projectTeamJsonCache && projectTeamJsonCache.projectRoot === projectRoot && now - projectTeamJsonCache.timestamp < cacheTtlMs) {
    const age = now - projectTeamJsonCache.timestamp;
    debug('prompt-injection', `loadProjectTeamJson: cache hit (age=${age}ms, ttl=${cacheTtlMs}ms), returning cached data`, getEventId());
    return projectTeamJsonCache.parsed;
  }
  
  debug('prompt-injection', `loadProjectTeamJson: cache miss or expired, loading from file`, getEventId());
  const teamJsonPath = getTeamJsonPath(projectRoot);
  const readStartTime = Date.now();
  let raw = await fs.readFile(teamJsonPath, "utf-8");
  // 去掉 UTF-8 BOM（0xEF 0xBB 0xBF），避免 JSON.parse 失败
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  const readTime = Date.now() - readStartTime;

  const parseStartTime = Date.now();
  const parsed = JSON.parse(raw);
  const parseTime = Date.now() - parseStartTime;
  
  projectTeamJsonCache = { raw, timestamp: now, projectRoot, parsed };
  debug('prompt-injection', `loadProjectTeamJson: loaded ${parsed.members?.length || 0} members (read=${readTime}ms, parse=${parseTime}ms)`, getEventId());
  return parsed;
}

export function extractSessionKeys(members: { agent_id: string; name?: string; sessionKey: string }[]): Set<string> {
  debug('prompt-injection', `extractSessionKeys: extracting keys from ${members.length} members`, getEventId());
  const keys = new Set<string>();
  for (const m of members) {
    if (m.sessionKey) keys.add(m.sessionKey);
  }
  debug('prompt-injection', `extractSessionKeys: extracted ${keys.size} unique session keys`, getEventId());
  return keys;
}

export async function resolveProjectRoot(coorclawJsonPath: string, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS): Promise<string> {
  const now = Date.now();
  if (rulePathCache && now - rulePathCache.timestamp < cacheTtlMs) {
    const age = now - rulePathCache.timestamp;
    debug('prompt-injection', `resolveProjectRoot: cache hit (age=${age}ms, ttl=${cacheTtlMs}ms), returning ${rulePathCache.root}`, getEventId());
    return rulePathCache.root;
  }

  debug('prompt-injection', `resolveProjectRoot: cache miss or expired, resolving from ${coorclawJsonPath}`, getEventId());
  const resolved = expandHome(coorclawJsonPath, os);
  let raw = await fs.readFile(resolved, "utf-8");
  // 去掉 UTF-8 BOM（0xEF 0xBB 0xBF），避免 JSON.parse 失败
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  const data = JSON.parse(raw);

  for (const team of data.teams || []) {
    for (const proj of team.projects || []) {
      if (proj.status === "active" && proj.root) {
        const root = expandPath(proj.root);
        rulePathCache = { root, timestamp: now };
        debug('prompt-injection', `resolveProjectRoot: found active project root=${root}`, getEventId());
        return root;
      }
    }
  }

  // 解析失败时清空缓存，避免返回陈旧路径
  rulePathCache = null;
  warn('prompt-injection', `resolveProjectRoot: no active project found in ${coorclawJsonPath}`, getEventId());
  throw new Error("coordclaw.json: no active project found");
}

function expandHome(p: string, os: any): string {
  if (p.startsWith("~")) { return p.replace(/^~/, os.homedir()); }
  return p;
}

export async function resolveRuleFilePath(coorclawJsonPath: string): Promise<string> {
  debug('prompt-injection', `resolveRuleFilePath: resolving for ${coorclawJsonPath}`, getEventId());
  const root = await resolveProjectRoot(coorclawJsonPath);
  const rulePath = getTeamRuleMdPath(root);
  debug('prompt-injection', `resolveRuleFilePath: resolved to ${rulePath}`, getEventId());
  return rulePath;
}

export async function loadRuleMd(ruleFilePath: string, cacheTtlMs: number): Promise<string> {
  const now = Date.now();
  if (ruleCache && now - ruleCache.timestamp < cacheTtlMs) {
    const age = now - ruleCache.timestamp;
    debug('prompt-injection', `loadRuleMd: cache hit (age=${age}ms, size=${ruleCache.raw.length} chars)`, getEventId());
    return ruleCache.raw;
  }
  
  debug('prompt-injection', `loadRuleMd: cache miss, loading from ${ruleFilePath}`, getEventId());
  const readStartTime = Date.now();
  const content = await fs.readFile(ruleFilePath, "utf-8");
  const readTime = Date.now() - readStartTime;
  
  ruleCache = { raw: content, timestamp: now };
  debug('prompt-injection', `loadRuleMd: loaded ${content.length} chars (read=${readTime}ms)`, getEventId());
  return content;
}

export function extractAgentIds(ruleMd: string): string[] {
  debug('prompt-injection', `extractAgentIds: extracting from ruleMd (${ruleMd.length} chars)`, getEventId());
  const agMatch = ruleMd.match(/<!--\s*AGENTS:START\s+(.+)\s*-->/);
  if (agMatch) {
    const ids = agMatch[1].split(",").map(s => s.trim()).filter(Boolean);
    debug('prompt-injection', `extractAgentIds: found ${ids.length} agents from AGENTS:START section`, getEventId());
    return ids;
  }
  
  const ids = new Set<string>();
  const re = /### §2\.\d+\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ruleMd)) !== null) ids.add(m[1]);
  debug('prompt-injection', `extractAgentIds: found ${ids.size} agents from section headers`, getEventId());
  return [...ids];
}

export function extractCommonSection(ruleMd: string): string | null {
  debug('prompt-injection', `extractCommonSection: searching for common section`, getEventId());
  const re = /<!--\s*SECTION:START\s+id=["']?common["']?[^>]*-->[\s\S]*?<!--\s*SECTION:END\s+id=["']?common["']?\s*-->/;
  const m = ruleMd.match(re);
  if (m) {
    const section = m[0]
      .replace(/<!--\s*SECTION:START[^>]*-->/g, "")
      .replace(/<!--\s*SECTION:END[^>]*-->/g, "")
      .trim();
    debug('prompt-injection', `extractCommonSection: found common section (${section.length} chars)`, getEventId());
    return section;
  }
  debug('prompt-injection', `extractCommonSection: not found`, getEventId());
  return null;
}

export function extractAgentSection(ruleMd: string, agentId: string): string | null {
  debug('prompt-injection', `extractAgentSection: searching for agent=${agentId}`, getEventId());
  const esc = agentId.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<!--\\s*SECTION:START\\s+id=["']?${esc}["']?\\b[^>]*-->[\\s\\S]*?<!--\\s*SECTION:END\\s+id=["']?${esc}["']?\\b\\s*-->`,
    "i"
  );
  const m = ruleMd.match(re);
  if (m) {
    const section = m[0]
      .replace(/<!--\s*SECTION:START[^>]*-->/g, "")
      .replace(/<!--\s*SECTION:END[^>]*-->/g, "")
      .trim();
    debug('prompt-injection', `extractAgentSection: found section for ${agentId} (${section.length} chars)`, getEventId());
    return section;
  }

  warn('prompt-injection', `extractAgentSection: no section found for agentId=${agentId} (expected mark: <!-- SECTION:START id=${agentId} ... -->)`, getEventId());
  return null;
}

export function clearLoaderCache(): { cleared: string[] } {
  const cleared: string[] = [];
  if (ruleCache) { ruleCache = null; cleared.push('ruleCache'); }
  if (rulePathCache) { rulePathCache = null; cleared.push('rulePathCache'); }
  if (projectTeamJsonCache) { projectTeamJsonCache = null; cleared.push('projectTeamJsonCache'); }
  info('prompt-injection', `clearLoaderCache: cleared ${cleared.length} cache(s): ${cleared.join(', ') || 'none'}`, getEventId());
  return { cleared };
}
