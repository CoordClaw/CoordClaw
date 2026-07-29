/**
 * 技能管理处理器 — 通过 Gateway API 替代直接读写 openclaw.json
 * 依赖: sendJSON, config-resolver, node:fs (仅 install 和 open-dir 保留文件操作)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sendJSON, parseBody } from '../lib/response.js';
import { getOpenClawUserDir, OPENCLAW_JSON_FILENAME, SKILL_MD_FILENAME, COORDCLAW_CONFIG_PATH } from '../config-resolver.js';

// ─── 技能缓存（扫描目录，install 用） ──────────────────

let _skillCache: Record<string, { path: string; desc: string }> | null = null;

export function scanAllSkills(): Record<string, { path: string; desc: string }> {
  if (_skillCache) return _skillCache;
  const seen = new Set<string>();
  const result: Record<string, { path: string; desc: string }> = {};
  const openclawUserDir = getOpenClawUserDir();
  const openclawPath = join(openclawUserDir, OPENCLAW_JSON_FILENAME);

  const scanDirs: string[] = [join(openclawUserDir, 'skills')];
  // 也扫描 coordClawRoot/plugins/coordcenter/skills（安装目标目录）
  try {
    const cfgRaw = JSON.parse(readFileSync(COORDCLAW_CONFIG_PATH, 'utf-8'));
    if (cfgRaw.coordClawRoot) {
      scanDirs.push(join(cfgRaw.coordClawRoot, 'plugins', 'coordcenter', 'skills'));
    }
  } catch {}
  if (existsSync(openclawPath)) {
    const raw = JSON.parse(readFileSync(openclawPath, 'utf-8'));
    const extraDirs: string[] = raw.skills?.load?.extraDirs || [];
    for (const dir of extraDirs) {
      scanDirs.push(dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir);
    }
  }

  for (const rp of scanDirs) {
    if (!existsSync(rp)) continue;
    for (const entry of readdirSync(rp, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = join(rp, entry.name, SKILL_MD_FILENAME);
      if (!existsSync(mdPath)) continue;
      if (seen.has(entry.name)) continue;
      let desc = '';
      try {
        const content = readFileSync(mdPath, 'utf-8').slice(0, 4096);
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const descKey = fm.match(/^description:\s*/m);
          if (descKey) {
            const afterDesc = fm.slice(descKey.index! + descKey[0].length);
            const firstLine = afterDesc.split('\n')[0] || '';
            if (firstLine === '|' || firstLine === '>' || firstLine.startsWith('|') || firstLine.startsWith('>')) {
              const lines = afterDesc.split('\n').slice(1);
              const blockLines: string[] = [];
              for (const l of lines) {
                if (/^\S/.test(l) && !/^\s/.test(l)) break;
                blockLines.push(l.replace(/^\s{2,}/, ''));
              }
              desc = blockLines.join(' ').trim().slice(0, 200);
            } else if (firstLine.startsWith('"') || firstLine.startsWith("'")) {
              desc = firstLine.replace(/^["']|["']$/g, '').trim().slice(0, 200);
            } else {
              desc = firstLine.trim().slice(0, 200);
            }
          }
        }
      } catch { /* ignore */ }
      if (!desc) continue;
      seen.add(entry.name);
      result[entry.name] = { path: rp, desc };
    }
  }
  _skillCache = result;
  return result;
}

export function invalidateSkillCache(): void {
  _skillCache = null;
}

// ─── Gateway 助手 ─────────────────────────────────────

interface GatewayConfig { url: string; token: string; }

function getGw(): GatewayConfig {
  const raw = JSON.parse(readFileSync(COORDCLAW_CONFIG_PATH, 'utf-8'));
  return { url: raw.gatewayUrl, token: raw.gatewayToken };
}

async function gwGet(path: string): Promise<any> {
  const { url, token } = getGw();
  const resp = await fetch(`${url}${path}`, { headers: { 'x-gateway-token': token } });
  return resp.json();
}

// skill-list 缓存（避免 toggle 时重复拉 87KB）
let _gwSkillCache: { data: any; ts: number } | null = null;
const SKILL_CACHE_TTL = 30000; // 30 秒

async function gwGetSkillList(): Promise<any> {
  if (_gwSkillCache && Date.now() - _gwSkillCache.ts < SKILL_CACHE_TTL) {
    return _gwSkillCache.data;
  }
  const data = await gwGet('/coordclaw-plugin/coordclawcenter/skill-list');
  _gwSkillCache = { data, ts: Date.now() };
  return data;
}

async function gwSetSkill(name: string, enabled: boolean): Promise<any> {
  const result = await gwPost('/coordclaw-plugin/coordclawcenter/skill-set', { skillName: name, enabled });
  // toggle 成功后更新缓存
  if (result.success && _gwSkillCache) {
    const skills = _gwSkillCache.data.skills || [];
    const sk = skills.find((s: any) => s.name === name);
    if (sk) sk.disabled = !enabled;
  }
  return result;
}

async function gwPost(path: string, body: any, ct: string = 'application/json'): Promise<any> {
  const { url, token } = getGw();
  const resp = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'x-gateway-token': token, 'Content-Type': ct },
    body: ct === 'application/json' ? JSON.stringify(body) : body,
  });
  return resp.json();
}

// ─── Skill 列表/刷新（Gateway skill-list） ─────────────

function mapSkillList(gwSkills: any[]) {
  const list = gwSkills.map((s: any) => ({
    name: s.name,
    path: '',
    desc: s.description || '',
    enabled: !s.disabled,
  }));
  list.sort((a: any, b: any) => a.name.localeCompare(b.name));
  return list;
}

/** POST /api/skills/refresh */
export async function handleRefreshSkills(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    _gwSkillCache = null; // 强制刷新
    const data = await gwGetSkillList();
    const list = mapSkillList(data.skills || []);
    sendJSON(res, 200, { skills: list, total: list.length });
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}

/** GET /api/skills */
export async function handleSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await gwGetSkillList();
    const list = mapSkillList(data.skills || []);
    sendJSON(res, 200, { skills: list, total: list.length });
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}

/** POST /api/skills/toggle */
export async function handleToggleSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { name } = await parseBody(req);
    if (!name) { sendJSON(res, 400, { error: '缺少 name' }); return; }
    const listData = await gwGetSkillList();
    const skill = (listData.skills || []).find((s: any) => s.name === name);
    if (!skill) { sendJSON(res, 404, { error: '技能不存在' }); return; }
    const newEnabled = !!skill.disabled;
    const result = await gwSetSkill(name, newEnabled);
    if (result.success) {
      sendJSON(res, 200, { name, enabled: newEnabled });
    } else {
      sendJSON(res, 500, { error: result.message || '切换失败' });
    }
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}

// ─── 成员技能 ───────────────────────────────────────

/** GET /api/member-skills */
export async function getMemberSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const agentId = url.searchParams.get('agentId');
    if (!agentId) { sendJSON(res, 400, { error: '缺少 agentId' }); return; }

    const [cfgData, listData] = await Promise.all([
      gwGet('/coordclaw-plugin/coordclawcenter/config-get'),
      gwGet('/coordclaw-plugin/coordclawcenter/skill-list'),
    ]);
    const config: any = cfgData.config || cfgData;
    const agents: any[] = config?.parsed?.agents?.list || config?.resolved?.agents?.list || [];
    const agent = agents.find((a: any) => a.id === agentId);
    const hasExplicitSkills = agent && 'skills' in agent;
    const assignedRaw: string[] = hasExplicitSkills ? (agent.skills || []) : [];
    const allSkills: any[] = listData.skills || [];
    const skillMap = new Map(allSkills.map((s: any) => [s.name, s]));

    const assigned = assignedRaw
      .filter((s: string) => skillMap.has(s))
      .map((s: string) => ({ name: s, desc: skillMap.get(s)!.description || '', enabled: !skillMap.get(s)!.disabled }));
    assigned.sort((a: any, b: any) => a.name.localeCompare(b.name));

    const assignedSet = new Set(assignedRaw);
    const available = allSkills
      .filter((s: any) => !assignedSet.has(s.name))
      .map((s: any) => ({ name: s.name, desc: s.description || '', enabled: !s.disabled }));
    available.sort((a: any, b: any) => a.name.localeCompare(b.name));

    sendJSON(res, 200, { agentId, assigned, available, all: !hasExplicitSkills });
  } catch (e: any) {
    sendJSON(res, 500, { error: '读取成员技能失败: ' + e.message });
  }
}

/** PUT /api/member-skills */
export async function updateMemberSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { agentId, skills } = await parseBody(req);
    if (!agentId) { sendJSON(res, 400, { error: '缺少 agentId' }); return; }
    if (skills !== null && !Array.isArray(skills)) { sendJSON(res, 400, { error: 'skills 必须是数组或 null' }); return; }

    // ① 即时响应，弹窗即关
    sendJSON(res, 200, { success: true, agentId, skills: skills === null ? undefined : [...new Set(skills as string[])] });

    // ② 异步写 openclaw.json
    (async () => {
      try {
        const cfgData = await gwGet('/coordclaw-plugin/coordclawcenter/config-get');
        const config: any = cfgData.config || cfgData;
        const agents: any[] = config?.parsed?.agents?.list || config?.resolved?.agents?.list || [];
        const agent = agents.find((a: any) => a.id === agentId);
        if (!agent) return;

        if (skills === null) {
          // 全选 → 删除 skills key，继承全局
          if ('skills' in agent) {
            await gwPost('/coordclaw-plugin/coordclawcenter/config-patch',
              JSON.stringify({ agents: { list: [{ id: agentId, skills: null }] } }), 'text/plain');
          }
        } else {
          const oldSkills: string[] = Array.isArray(agent?.skills) ? agent.skills as string[] : [];
          const newSkills: string[] = [...new Set(skills as string[])];
          for (const s of newSkills.filter(s => !oldSkills.includes(s))) {
            await gwPost('/coordclaw-plugin/coordclawcenter/skill-set', { skillName: s, enabled: true, agentId });
          }
          for (const s of oldSkills.filter(s => !newSkills.includes(s))) {
            await gwPost('/coordclaw-plugin/coordclawcenter/skill-set', { skillName: s, enabled: false, agentId });
          }
        }
      } catch {} // 静默
    })();
  } catch (e: any) {
    sendJSON(res, 500, { error: '更新成员技能失败: ' + e.message });
  }
}

// ─── 安装 / 打开目录 ─────────────────────────────────

/** POST /api/install-skill */
export async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { sourcePath } = await parseBody(req);
    if (!sourcePath) { sendJSON(res, 400, { error: '缺少 sourcePath' }); return; }
    const srcMd = join(sourcePath, SKILL_MD_FILENAME);
    if (!existsSync(srcMd)) {
      sendJSON(res, 400, { error: '所选文件夹不包含 ' + SKILL_MD_FILENAME });
      return;
    }
    const mdContent = readFileSync(srcMd, 'utf-8').slice(0, 4096);
    const fmMatch = mdContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      sendJSON(res, 400, { error: SKILL_MD_FILENAME + ' 缺少有效的 YAML frontmatter' });
      return;
    }
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (!descMatch) {
      sendJSON(res, 400, { error: SKILL_MD_FILENAME + ' 缺少 description 字段，无效技能' });
      return;
    }
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    const skillName = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : sourcePath.split(/[\\/]/).pop()!;

    // ★ 不再复制文件夹，仅校验 + 注册
    sendJSON(res, 200, { success: true, skillName });
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}

/** GET /api/open-skill-dir */
export function handleOpenSkillDir(req: IncomingMessage, res: ServerResponse, openFolder: (p: string) => void): void {
  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const name = url.searchParams.get('name');
    if (!name) { sendJSON(res, 400, { error: '缺少 name 参数' }); return; }
    const skills = scanAllSkills();
    const skill = skills[name];
    if (!skill) { sendJSON(res, 404, { error: '技能不存在' }); return; }
    const dir = join(skill.path, name);
    openFolder(dir);
    sendJSON(res, 200, { success: true });
  } catch (e: any) {
    sendJSON(res, 500, { error: e.message });
  }
}
