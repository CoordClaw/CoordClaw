/**
 * 安装模式处理器
 *
 * 当 config.json 或 coordclaw.json 缺失时，提供 Web 安装向导。
 * 复用 fs/path/os 等 Node 内置模块，与现有代码风格一致。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  OPENCLAW_JSON_FILENAME, COORDCLAW_JSON_FILENAME,
  TEAM_JSON_FILENAME, TEAM_JSON_SUBDIR,
  normalizePath, expandPath, readPlatformConfig, resolveExternalPlatformDir,
  PLUGIN_DIR, SKILL_DIR, SKILL_NAME, getCoordClawRoot,
  applyOpenClawRegistration, buildOpenClawRegCtx, writeOpenClawJson,
} from '../config-resolver.js';
import { sendJSON } from '../lib/response.js';

// CoordClaw 根目录：从 install.js 位置反推（dist/handlers/ → web/ → controlpanel/ → root）
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
const COORDCLAW_ROOT = getCoordClawRoot();

// 从 package.json 读取版本号和运行时配置
let PKG_VERSION = '2.3';
let PKG_RUNTIME = 'browser';
let PKG_DEFAULT_LANG = 'zh';
try {
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    PKG_VERSION = pkg.version || PKG_VERSION;
    PKG_RUNTIME = pkg.config?.runtime || PKG_RUNTIME;
    PKG_DEFAULT_LANG = pkg.config?.defaultLanguage || PKG_DEFAULT_LANG;
  }
} catch {}

interface PlatformInfo {
  dir: string;
  name: string;
  hasPlugin: boolean;
}

/** 扫描 ~ 下所有含 openclaw.json 的目录 */
export function scanPlatforms(): PlatformInfo[] {
  const home = homedir();
  const platforms: PlatformInfo[] = [];

  // ① homedir 一级子目录
  try {
    const entries = readdirSync(home, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dirPath = join(home, e.name);
      const openclawPath = join(dirPath, OPENCLAW_JSON_FILENAME);
      if (!existsSync(openclawPath)) continue;
      const coordclawPath = join(dirPath, COORDCLAW_JSON_FILENAME);
      platforms.push({ dir: e.name, name: e.name, hasPlugin: existsSync(coordclawPath) });
    }
  } catch {}

  // ② findplatforms.json 自定义路径
  const seen = new Set(platforms.map(p => p.dir));
  try {
    const dirs = readPlatformConfig(COORDCLAW_ROOT).directories;
    for (const raw of dirs) {
      const absPath = resolveExternalPlatformDir(COORDCLAW_ROOT, raw);
      // ★ 存正斜杠，避免反斜杠在 HTML/JS 字符串中被当作转义符
      const dir = absPath.replace(/\\/g, '/');
      if (!existsSync(join(absPath, OPENCLAW_JSON_FILENAME))) continue;
      const name = absPath.split(/[/\\]/).filter(Boolean).pop() || absPath;
      if (seen.has(dir)) continue;
      seen.add(dir);
      platforms.push({
        dir,
        name,
        hasPlugin: existsSync(join(absPath, COORDCLAW_JSON_FILENAME)),
      });
    }
  } catch {}

  return platforms;
}

// ── 动态团队发现 ──

interface DiscoveredTeam {
  id: string;
  name: string;
  templatePath: string;
  agents: string[];
}

interface DiscoverResult {
  teams: DiscoveredTeam[];
  agentMeta: Record<string, { name: string; role: string }>;
}

/** 扫描 teamstemplate/{lang}/ 下所有团队子目录，读取 team.json 提取团队和 Agent 元数据 */
function discoverTeams(language: string): DiscoverResult {
  const langDir = join(COORDCLAW_ROOT, 'teamstemplate', language);
  const teams: DiscoveredTeam[] = [];
  const agentMeta: Record<string, { name: string; role: string }> = {};

  if (!existsSync(langDir)) return { teams, agentMeta };

  try {
    const entries = readdirSync(langDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const teamId = e.name;
      const teamJsonPath = join(langDir, teamId, TEAM_JSON_SUBDIR, TEAM_JSON_FILENAME);
      if (!existsSync(teamJsonPath)) continue;

      try {
        const teamJson = JSON.parse(readFileSync(teamJsonPath, 'utf-8'));
        const members = teamJson.members || [];
        const agentIds: string[] = [];

        for (const m of members) {
          if (!m.agent_id) continue;
          agentIds.push(m.agent_id);
          if (!agentMeta[m.agent_id]) {
            agentMeta[m.agent_id] = { name: m.name || m.agent_id, role: m.role || '' };
          }
        }

        teams.push({
          id: teamId,
          name: teamJson.team_name || teamId,
          templatePath: join(langDir, teamId).replace(/\\/g, "/"),
          agents: agentIds,
        });
      } catch {}
    }
  } catch {}

  return { teams, agentMeta };
}

/**
 * 在宿主目录内创建 coordcenter junction（指向 pluginDirPath）。
 * 统一供 ⑦ extensions 与 ⑧ mklinkforplugins 复用：
 * - 宿主目录不存在：先递归创建；创建失败则发警告并静默跳过（不阻断后续）。
 * - 已存在 junction：幂等跳过。
 * - 连接失败（真异常）：通过 onError 上报为错误。
 */
function ensureCoordcenterJunction(
  hostDir: string,
  pluginDirPath: string,
  symlinkType: 'junction' | 'dir',
  opts: { onError: (msg: string) => void; onWarn: (msg: string) => void },
): void {
  if (!existsSync(hostDir)) {
    try {
      mkdirSync(hostDir, { recursive: true });
    } catch (e: any) {
      opts.onWarn(`${hostDir} 目录创建失败，已跳过: ${e.message}`);
      return;
    }
  }
  const linkPath = join(hostDir, 'coordcenter');
  if (existsSync(linkPath)) return;
  if (!existsSync(pluginDirPath)) mkdirSync(pluginDirPath, { recursive: true });
  try {
    symlinkSync(pluginDirPath, linkPath, symlinkType);
  } catch (e: any) {
    if (e.code === 'EEXIST') return; // 已存在（含损坏 junction），视作已连
    opts.onError(`${hostDir}/coordcenter 连接失败: ${e.message}`);
  }
}

/** 对选中的平台执行安装 */
export function applyInstall(language: string, platformDirs: string[]): {
  installed: string[];
  skipped: string[];
  errors: string[];
  warnings: string[];
} {
  const home = homedir();
  const lang = language || PKG_DEFAULT_LANG;
  const installed: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  const pluginDirPath = join(COORDCLAW_ROOT, PLUGIN_DIR);
  const skillDirPath = join(COORDCLAW_ROOT, SKILL_DIR);
  const symlinkType: 'junction' | 'dir' = platform() === 'win32' ? 'junction' : 'dir';
  const { mklinkforplugins } = readPlatformConfig(COORDCLAW_ROOT);

  // ★ 一次性发现当前语言的团队模板和 Agent 元数据
  const dis = discoverTeams(lang);

  for (const dir of platformDirs) {
    try {
      const needsExpansion = (p: string) => p.startsWith('~') || p.includes('${');
      const dirPath = needsExpansion(dir)
        ? expandPath(dir)
        : (isAbsolute(dir) ? normalizePath(dir) : join(home, dir));
      const openclawPath = join(dirPath, OPENCLAW_JSON_FILENAME);
      const coordclawPath = join(dirPath, COORDCLAW_JSON_FILENAME);

      if (!existsSync(openclawPath)) {
        errors.push(`${dir}: openclaw.json 不存在`);
        continue;
      }

      const raw = readFileSync(openclawPath, 'utf-8');
      const cfg = JSON.parse(raw);
      // ═══ ①②③④⑦ 注册合并（install 与启动自愈共用 applyOpenClawRegistration）═══
      let changed = applyOpenClawRegistration(cfg, buildOpenClawRegCtx(dirPath));

      // ═══ ⑤ agents.list[].skills — 添加技能给有 skills 列表的 Agent ═══
      const agents = cfg.agents?.list || [];
      for (const agent of agents) {
        if (!Array.isArray(agent.skills) || agent.skills.length === 0) continue;
        if (!agent.skills.includes(SKILL_NAME)) {
          agent.skills.push(SKILL_NAME);
          changed = true;
        }
      }

      // coordclawObj.teams 来自动态发现
      const coordclawObj = {
        version: PKG_VERSION,
        runtime: PKG_RUNTIME,
        platform: dir,
        language: lang,
        logging: {
          level: 'INFO',
          retentiondays: 2,
          modules: { 'message-routing': 'INFO', 'rpc-client': 'INFO' },
        },
        endpointslist: false,
        teams: dis.teams.map(t => ({
          id: t.id,
          name: t.name,
          templatePath: t.templatePath.replace(/\\/g, "/"),
          agents: t.agents,
          projects: [],
        })),
      };

      // ═══ ⑥ agents.list — 从发现的团队模板补全 Agent 元数据 ═══
      {
        const allAgentIds = new Set<string>();
        for (const team of dis.teams) {
          for (const aid of team.agents) allAgentIds.add(aid);
        }
        cfg.agents = cfg.agents || { defaults: {}, list: [] };
        cfg.agents.list = cfg.agents.list || [];
        const existingIds = new Set(cfg.agents.list.map((a: any) => a.id));
        for (const agentId of allAgentIds) {
          if (!existingIds.has(agentId)) {
            const meta = dis.agentMeta[agentId];
            const displayName = meta ? meta.name : agentId;
            const identityName = meta?.role ? `${meta.name}-${meta.role}` : displayName;
            cfg.agents.list.push({
              id: agentId,
              name: displayName,
              identity: { name: identityName },
              workspace: join(dirPath, `workspace-${agentId}`),
            });
            changed = true;
          }
        }
      }

      // ⑦ gateway.chatCompletions 已并入 applyOpenClawRegistration，此处不再重复

      // 写入 openclaw.json
      if (changed) {
        writeOpenClawJson(cfg, openclawPath);
      }

      // 创建 coordclaw.json
      if (!existsSync(coordclawPath)) {
        writeFileSync(coordclawPath, JSON.stringify(coordclawObj, null, 2), 'utf-8');
        installed.push(dir);
      } else {
        skipped.push(dir);
      }

      // ═══ ⑦ extensions — 将 coordcenter 插件链接到平台的 extensions 目录 ═══
      ensureCoordcenterJunction(
        join(dirPath, 'extensions'), pluginDirPath, symlinkType,
        {
          onError: (m) => errors.push(`${dir}: extensions/coordcenter ${m}`),
          onWarn: (m) => warnings.push(`${dir}: ${m}`),
        },
      );

      // ═══ ⑧ mklinkforplugins — 在各扩展插件目录下创建 coordcenter junction ═══
      for (const raw of mklinkforplugins) {
        const needsExpansion = (p: string) => p.startsWith('~') || p.includes('${');
        const target = needsExpansion(raw) ? expandPath(raw) : normalizePath(raw);
        ensureCoordcenterJunction(target, pluginDirPath, symlinkType, {
          onError: (m) => errors.push(`${dir}: mklink ${raw} ${m}`),
          onWarn: (m) => warnings.push(`mklinkforplugins[${raw}]: ${m}`),
        });
      }
    } catch (e: any) {
      errors.push(`${dir}: ${e.message}`);
    }
  }

  return { installed, skipped, errors, warnings };
}

/** 扫描 API */
export function handleScan(req: IncomingMessage, res: ServerResponse): void {
  const platforms = scanPlatforms();
  sendJSON(res, 200, { platforms });
}

/** 应用安装 API */
export function handleApply(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      const { language, platforms } = JSON.parse(body);
      if (!language || !platforms || !Array.isArray(platforms) || platforms.length === 0) {
        sendJSON(res, 400, { error: '请选择语言和至少一个平台' });
        return;
      }
      const result = applyInstall(language, platforms);
      sendJSON(res, 200, result);
    } catch (e: any) {
      sendJSON(res, 400, { error: e.message });
    }
  });
}
