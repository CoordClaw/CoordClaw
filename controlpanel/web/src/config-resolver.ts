/**
 * 配置解析器 — 所有路径从 config.json 派生，不硬编码
 * 
 * 唯一入口: COORDCLAW_CONFIG_PATH → config.json
 *   ├── openclawUserDir → openclaw.json / skills / coordclaw.json
 *   ├── coordclawJsonPath → coordclaw.json（精确路径）
 *   └── gatewayUrl / webchatUrl
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, normalize, isAbsolute, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tokenStatsService } from './lib/token-stats.js';
import { normalizeLanguage } from './lib/lang.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

/** CoordClaw 安装根目录（dist/ 上 3 级 → web/controlpanel/CoordClaw）。install 与自愈共用，单一真相源。 */
export function getCoordClawRoot(): string {
  return join(__dirname, '..', '..', '..');
}

// ============ 路径常量（单一来源，便于维护） ============

/** 数据库文件在项目中的相对子目录 */
export const DB_SUBDIR = '.data/data';
/** 数据库文件名 */
export const DB_FILENAME = 'coordclaw.db';
/** CoordClaw API 接口文档路径 */
/** config.json 路径（跨平台统一，与插件 config-writer.ts 写入路径一致） */
export const COORDCLAW_CONFIG_PATH = process.env.APPDATA
  ? join(process.env.APPDATA, 'CoordClaw', 'config.json')
  : join(homedir(), 'CoordClaw', 'config.json');
/** team.json 所在子目录 */
export const TEAM_JSON_SUBDIR = '.data';
/** team.json 文件名 */
export const TEAM_JSON_FILENAME = 'team.json';
/** 团队模板文件名 */
export const TEAMSOUL_FILENAME = 'teamsoul.md';
export const TEAM_RULE_FILENAME = 'team RULE.md';
/** 技能文件名 */
export const SKILL_MD_FILENAME = 'SKILL.md';
/** OpenClaw 配置文件名 */
export const OPENCLAW_JSON_FILENAME = 'openclaw.json';
/** CoordClaw 配置文件名 */
export const COORDCLAW_JSON_FILENAME = 'coordclaw.json';

// ============ CoordClaw 插件身份（OpenClaw 注册，install 与启动自愈共用）============
export const PLUGIN_ID = 'coordclawcenter';
export const SKILL_NAME = 'create-coordclaw-team';
export const PLUGIN_DIR = 'plugins/coordcenter';
export const SKILL_DIR = 'plugins/coordcenter/skills';

/**
 * 从项目根目录构造数据库文件完整路径
 */
export function resolveDatabasePath(projectRoot: string): string {
  return join(expandPath(projectRoot), DB_SUBDIR, DB_FILENAME);
}

/**
 * 从项目根目录构造 team.json 完整路径
 */
export function resolveTeamJsonPath(projectRoot: string): string {
  return join(expandPath(projectRoot), TEAM_JSON_SUBDIR, TEAM_JSON_FILENAME);
}

/**
 * 安全读取 JSON 文件（自动处理 BOM 头）
 */
export function readJsonFileSync(filePath: string): any {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const cleanRaw = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  return JSON.parse(cleanRaw);
}

/**
 * 从 config.json 读取 coordclawJsonPath
 * 这是 coordclaw.json 的唯一权威路径来源
 */
export function resolveCoordClawJsonPath(): string {
  if (!existsSync(COORDCLAW_CONFIG_PATH)) {
    throw new Error(`COORDCLAW_NOT_INSTALLED: 未找到 config.json (${COORDCLAW_CONFIG_PATH})`);
  }
  const raw = readFileSync(COORDCLAW_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);
  if (!config.coordclawJsonPath) {
    throw new Error('COORDCLAW_NOT_INSTALLED: config.json 中缺少 coordclawJsonPath 字段');
  }
  return config.coordclawJsonPath;
}

// ============ 类型定义 ============

export interface TeamClawProject {
  id: string;
    name: string;
  root: string;           // 项目根目录
  status: string;         // 'active' | 'inactive'
  deployedAt?: string;
}

export interface TeamClawConfig {
  language?: string;       // "zh" | "en", 语言偏好
  version: string;
  teams: Array<{
    id: string;
    name: string;
    templatePath: string;
    agents: string[];
    projects: TeamClawProject[];
  }>;
}

export interface ControlPanelConfig {
  // 服务端口（可从环境变量或配置覆盖）
  port: number;

  // 当前用户名和 agent_id（用于已读/消息过滤）
  currentUser: string;
  currentUserId: string;

  // 团队成员列表（含 agent_id，从 team.json 动态读取）
  members: Array<{
    agent_id: string;
    name: string;
    role: string;
    role_type?: string;
    role_label?: string;
    sessionKey?: string;
  }>;

  // 人类用户（从 team.json humanmember 读取）
  humanMember: Array<{
      enabled: boolean;
    name: string;
      human_id: string;
    role?: string;
    role_type?: string;
    }> | null;

  // 团队名称（从 team.json team_name 读取）
  teamName: string;

  // 消息路由配置（从 team.json msg_robot 读取）
  msgRobot: {
    enabled: boolean;
  };

  // 自动协同配置（从 team.json auto_coordination 读取）
  autoCoordination: boolean;

  // CORS 配置
  corsOrigin: string;

  // 数据库路径（自动解析）
  databasePath: string;

  // 项目根目录（用于日志等）
  projectRoot: string;

  // Token 累计用量（token-stats.jsonl 的 estTotal 去重求和）
  estTotalTokens: number;

  // 当前项目名称
  projectName: string;
  language?: string;        // 语言偏好，来自 coordclaw.json: 'zh' | 'en'
  startupStatus?: string;    // 启动状态: 'ok' | 'no_config' | 'no_coordclaw' | 'empty'
  version?: string;          // 版本号，来自 coordclaw.json
}

// ============ 项目切换相关类型 ============

/** 项目列表中的单个项目信息 */
export interface TeamProjectInfo {
  id: string;
  name: string;
  root: string;
  status: string;          // 'active' | 'inactive'
  teamId: string;
  teamName: string;
}

/** getAllProjects 返回结果 */
export interface AllProjectsResult {
  teams: Array<{
    id: string;
    name: string;
    templatePath?: string;
    projects: TeamProjectInfo[];
  }>;
}

/** switchActiveProject 返回结果 */
export interface SwitchProjectResult {
  success: boolean;
  projectId?: string;
  projectRoot?: string;
  error?: string;
}

// ============ 配置解析器类 ============

export class ConfigResolver {
  private static instance: ConfigResolver | null = null;
  
  private cache: ControlPanelConfig | null = null;
  private cacheTimestamp: number = 0;
  private coordclawCache: TeamClawConfig | null = null;
  private coordclawCacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 60_000; // 缓存1分钟
  
  private constructor() {}
  
  /**
   * 获取单例实例
   */
  public static getInstance(): ConfigResolver {
    if (!ConfigResolver.instance) {
      ConfigResolver.instance = new ConfigResolver();
    }
    return ConfigResolver.instance;
  }
  
  /**
   * 解析完整配置（带缓存）
   */
  public resolve(fresh: boolean = false): ControlPanelConfig {
    const now = Date.now();

    if (fresh) {
      this.clearCache();  // 强制刷新：同时清 ControlPanelConfig 和 coordclaw 缓存
    } else if (this.cache && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      return this.cache;
    }
    console.log('[ConfigResolver] 🔄 Parsing configuration...');
    
    // ★ 前置检查：config.json 必须存在
    if (!existsSync(COORDCLAW_CONFIG_PATH)) {
      throw new Error(`COORDCLAW_NOT_INSTALLED: 未找到 config.json (${COORDCLAW_CONFIG_PATH})`);
    }
    
    const teamclawConfig = this.resolveTeamClawConfig();
    const projectRoot = teamclawConfig.projectRoot;
    // ★ Token 统计：复用 config-resolver 解析出的 projectRoot（不自行猜测路径）
    tokenStatsService.setProjectRoot(projectRoot);
    // ★ 一次读盘，五次共用（空项目模式跳过）
    const teamJson = projectRoot ? this._readTeamJsonOnce(projectRoot) : null;
    const teamMembers = teamJson ? this.resolveTeamMembers(projectRoot, teamJson) : [];
    const humanMember = teamJson ? this.resolveHumanMember(projectRoot, teamJson) : [];
    const teamName = teamJson ? this.resolveTeamName(projectRoot, teamJson) : '';
    const msgRobot = teamJson ? this.resolveMsgRobot(projectRoot, teamJson) : { enabled: false };
    const autoCoordination = teamJson ? this.resolveAutoCoordination(projectRoot, teamJson) : false;

    // 从环境变量或team.json第一个成员获取当前用户
    const envUser = process.env.CONTROL_PANEL_USER;
    const currentUser = envUser || (teamMembers.length > 0 ? teamMembers[0].name : '用户');
    // ★ 从成员列表或 humanMember 反查当前用户的 agent_id
    const currentUserMember = teamMembers.find(m => m.name === currentUser);
    const currentUserId = currentUserMember?.agent_id
      || (humanMember.find(h => h.name === currentUser)?.human_id || '');

    const config: ControlPanelConfig = {
      port: parseInt(process.env.CONTROL_PANEL_PORT || '18790', 10),
      currentUser: currentUser,
      currentUserId: currentUserId,
      members: teamMembers,
      corsOrigin: process.env.CORS_ORIGIN || '*',
      databasePath: teamclawConfig.databasePath,
      projectRoot: teamclawConfig.projectRoot,
      projectName: teamclawConfig.projectName,
      estTotalTokens: tokenStatsService.estTotal,
      humanMember: humanMember,
      teamName: teamName,
      msgRobot: msgRobot,
      autoCoordination: autoCoordination,
      language: teamclawConfig.language,
      startupStatus: teamclawConfig.startupStatus || 'ok',
      version: teamclawConfig.version || '0.0.0',
    };

    this.cache = config;
    this.cacheTimestamp = now;

    console.log('[ConfigResolver] ✅ Config parsed:');
    console.log(`   📍 Server port: ${config.port}`);
    console.log(`   👤 Current user: ${config.currentUser} (${config.currentUserId})`);
    if (config.projectRoot) {
      console.log(`   👥 Team members: ${config.members.map(m => `${m.name}(${m.agent_id})`).join(', ')}`);
      if (humanMember.length > 0) {
        console.log(`   🧑 Human users: ${humanMember.filter(h=>h.enabled).map(h=>`${h.name}(${h.human_id})`).join(', ')}`);
      }
      console.log(`   📊 Database path: ${config.databasePath}`);
    } else {
      console.log(`   📭 Empty project mode (no team or project to create)`);
    }
    return config;
  }
  
  /**
   * 清除缓存（强制下次重新解析）
   */
  public clearCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
    this.coordclawCache = null;
    this.coordclawCacheTimestamp = 0;
  }

  /** 读取 coordinator.json（带缓存，watch 时由外部清缓存） */
  public readCoordClawCached(): TeamClawConfig {
    const now = Date.now();
    if (this.coordclawCache && (now - this.coordclawCacheTimestamp) < this.CACHE_TTL_MS) {
      return this.coordclawCache;
    }
    this.coordclawCache = readJsonFileSync(resolveCoordClawJsonPath()) as TeamClawConfig;
    this.coordclawCacheTimestamp = now;
    return this.coordclawCache;
  }
  
  // ============ 私有方法：解析 OpenClaw 配置 ============

  // ============ 私有方法：解析 TeamClaw 配置 ============

  /**
   * 解析 CoordClaw 配置（优先从 openclaw 的 config.json 获取基准目录）
   * 流程：RoamingAppData/CoordClaw/config.json → openclawUserDir → coordclaw.json
   */
  private resolveTeamClawConfig(): { databasePath: string; projectRoot: string; projectName: string; language?: string; startupStatus?: string; version?: string } {
    const configPath = resolveCoordClawJsonPath();

    console.log(`[ConfigResolver] 🔍 Step 1: locate config file`);
    console.log(`   📄 Config file: ${configPath}`);

    if (!existsSync(configPath)) {
      console.warn(`[ConfigResolver] ⚠️ coordclaw.json not found: ${configPath}`);
      throw new Error(`COORDCLAW_NOT_INSTALLED: coordclaw.json 未找到 (${configPath})`);
    }

    try {
      const config: TeamClawConfig = readCoordClawJson();

      console.log(`[ConfigResolver] 🔍 Step 2: coordclaw.json read successfully`);

      // 查找激活的项目
      const activeProject = this.findActiveProject(config);

      if (!activeProject) {
        console.log(`[ConfigResolver] ⚠️ No active project found, entering empty project mode`);
        const language = normalizeLanguage(config.language);
        if (config.language !== language) {
          config.language = language;
          writeCoordClawJson(config);
        }
        return { databasePath: '', projectRoot: '', projectName: '', language, startupStatus: 'empty', version: config.version };
      }

      const projectRoot = expandPath(activeProject.root);
      const projectName = activeProject.name;
      const databasePath = resolveDatabasePath(projectRoot);
      const language = normalizeLanguage(config.language);
      if (config.language !== language) {
        config.language = language;
        writeCoordClawJson(config);
        console.log(`[ConfigResolver] 🌐 Language invalid/missing, normalized to default: ${language}`);
      }
      const teamJsonPath = resolveTeamJsonPath(projectRoot);

      console.log(`[ConfigResolver] 🔍 Step 3: active project found`);
      console.log(`   📁 Project name: ${activeProject.name} (${activeProject.id})`);
      console.log(`   📂 Project root: ${projectRoot}`);
      console.log(`   💾 Database file: ${databasePath}`);
      console.log(`   👥 Member config: ${teamJsonPath}`);
      console.log(`[ConfigResolver] ✅ Config resolved (project root resolved dynamically)`);

      return { databasePath, projectRoot, projectName, language, version: config.version };

    } catch (error) {
      console.error(`[ConfigResolver] ❌ Failed to resolve CoordClaw config:`, error);
      throw new Error(`COORDCLAW_NOT_INSTALLED: coordclaw.json 解析失败 — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * 查找状态为 active 的项目
   */
  private findActiveProject(config: TeamClawConfig): TeamClawProject | null {
    for (const team of config.teams) {
      for (const project of team.projects) {
        if (project.status === 'active') {
          return project;
        }
      }
    }
    return null;
  }

  /**
   * ★ 读取 team.json 一次（5 个子方法共用）
   */
  private _readTeamJsonOnce(projectRoot: string): any {
    const teamJsonPath = resolveTeamJsonPath(projectRoot);
    if (!existsSync(teamJsonPath)) {
      console.warn(`[ConfigResolver] ⚠️ team.json not found: ${teamJsonPath}`);
      return null;
    }
    try {
      return readJsonFileSync(teamJsonPath);
    } catch (err) {
      console.warn(`[ConfigResolver] ⚠️ Failed to parse team.json: ${teamJsonPath}`, (err as Error).message);
      return null;
    }
  }

  /**
   * 从team.json读取团队成员列表（含 agent_id）
   * @param teamJson 预读取的 team.json 对象（避免重复读盘）
   */
  private resolveTeamMembers(projectRoot: string, teamJson?: any): ControlPanelConfig['members'] {
    if (!teamJson) return [];

    try {
      // 提取成员列表（含 agent_id）并排序（按权限级别降序）
      const members = (teamJson.members || [])
        .map((member: any) => ({
          agent_id: member.agent_id,
          name: member.name,
          role: member.role || 'member',
          role_type: member.role_type,
          role_label: member.role_label,
          sessionKey: member.sessionKey || '',
        }))
        .sort((a: any, b: any) => {
          const levelOrder: Record<string, number> = { 'L4': 4, 'L3': 3, 'L2': 2, 'L1': 1, '基础设施': 0 };
          return (levelOrder[b.role] || 0) - (levelOrder[a.role] || 0);
        });

      console.log(`[ConfigResolver] ✅ Loaded ${members.length} members from team.json`);
      return members;

    } catch (error) {
      console.error(`[ConfigResolver] ❌ Failed to parse team.json:`, error);
      return [];
    }
  }

  /**
   * 从team.json读取 humanmember 配置
   */
  private resolveHumanMember(projectRoot: string, teamJson?: any): Array<{ enabled: boolean; name: string; human_id: string }> {
    if (!teamJson) return [];

    try {
      const hm = teamJson.humanmember;

      if (!hm) return [];

      // ★ 兼容旧格式（单对象）→ 转数组
      const list = Array.isArray(hm) ? hm : [hm];

      const result = list
        .filter((h: any) => h && h.name)
        .map((h: any) => ({
          enabled: h.enabled === true,
          name: h.name,
          human_id: h.human_id || '',
          role: h.role || '',
          role_type: h.role_type || '',
        }));

      const enabled = result.filter(r => r.enabled);
      if (enabled.length > 0) {
        console.log(`[ConfigResolver] ✅ Human users: ${enabled.map(r => `${r.name}(${r.human_id})`).join(', ')}`);
      }
      return result;

    } catch (error) {
      console.error(`[ConfigResolver] ❌ Failed to parse human member:`, error);
      return [];
    }
  }

  /**
   * 从team.json读取团队名称
   */
  private resolveTeamName(projectRoot: string, teamJson?: any): string {
    if (!teamJson) return '';

    try {
      return teamJson.team_name || teamJson.name || '';
    } catch (error) {
      console.error(`[ConfigResolver] ❌ Failed to parse team_name:`, error);
      return '';
    }
  }

  /**
   * 从team.json读取消息路由配置（msg_robot 字段）
   */
  private resolveMsgRobot(projectRoot: string, teamJson?: any): { enabled: boolean } {
    if (!teamJson) return { enabled: false };

    try {
      const msgRobot = teamJson.msg_robot;

      if (typeof msgRobot === 'boolean') {
        return { enabled: msgRobot };
      }

      if (typeof msgRobot === 'object' && msgRobot !== null) {
        return { enabled: msgRobot.enabled === true };
      }

      return { enabled: false };
    } catch (error) {
      console.error(`[ConfigResolver] ❌ Failed to parse msg_robot:`, error);
      return { enabled: false };
    }
  }

  /**
   * 从 team.json 读取 auto_coordination 配置
   */
  private resolveAutoCoordination(projectRoot: string, teamJson?: any): boolean {
    if (!teamJson) return false;
    try {
      return !!teamJson.auto_coordination;
    } catch { return false; }
  }
}

// ============ 导出便捷函数 ============

/**
 * 获取控制面板完整配置
 */
export function getConfig(fresh: boolean = false): ControlPanelConfig {
  return ConfigResolver.getInstance().resolve(fresh);
}

/**
 * 获取数据库路径
 */
export function getDatabasePath(fresh: boolean = false): string {
  return getConfig(fresh).databasePath;
}

// ============ 项目切换相关函数 ============

/**
 * 获取 openclawUserDir（仅从 config.json，与 resolveOpenClawUserDir 同源）
 */
export function getOpenClawUserDir(): string {
  if (!existsSync(COORDCLAW_CONFIG_PATH)) {
    throw new Error('COORDCLAW_NOT_INSTALLED: config.json 不存在');
  }
  const raw = readFileSync(COORDCLAW_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);
  if (!config.openclawUserDir) {
    throw new Error('COORDCLAW_NOT_INSTALLED: config.json 中缺少 openclawUserDir 字段');
  }
  return config.openclawUserDir;
}

// ============ OpenClaw 插件注册（install 与启动自愈共用）============

/** 注册上下文：install 与启动自愈统一通过 buildOpenClawRegCtx 构造，避免两处各算路径 */
export interface OpenClawRegCtx {
  pluginId: string;
  pluginDirPath: string;
  skillDirPath: string;
  coordclawPath: string;
}

/** 基于 openclaw 所在目录构造注册上下文（plugin/skill 路径来自 getCoordClawRoot 单一真相源） */
export function buildOpenClawRegCtx(dir: string): OpenClawRegCtx {
  return {
    pluginId: PLUGIN_ID,
    pluginDirPath: join(getCoordClawRoot(), PLUGIN_DIR),
    skillDirPath: join(getCoordClawRoot(), SKILL_DIR),
    coordclawPath: join(dir, COORDCLAW_JSON_FILENAME),
  };
}

/** 仅看插件的 enabled 是否为 true（自愈判定条件，业务逻辑单一信号） */
export function isCoordClawPluginEnabled(cfg: any): boolean {
  return cfg?.plugins?.entries?.[PLUGIN_ID]?.enabled === true;
}

/**
 * 幂等合并 CoordClaw 在 openclaw.json 的注册：① allow ② load.paths ③ entries ④ skills.extraDirs ⑦ gateway.chatCompletions
 * 不动 ⑤ agents[].skills ⑥ agents.list（agentlist 由安装流程负责）。
 * 返回是否需要回写（changed）。
 */
export function applyOpenClawRegistration(cfg: any, ctx: OpenClawRegCtx): boolean {
  let changed = false;

  // ① plugins.allow — 允许插件运行
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.allow = cfg.plugins.allow || [];
  if (!cfg.plugins.allow.includes(ctx.pluginId)) {
    cfg.plugins.allow.push(ctx.pluginId);
    changed = true;
  }

  // ② plugins.load.paths — 插件路径
  cfg.plugins.load = cfg.plugins.load || {};
  cfg.plugins.load.paths = cfg.plugins.load.paths || [];
  if (!cfg.plugins.load.paths.includes(ctx.pluginDirPath)) {
    cfg.plugins.load.paths.push(ctx.pluginDirPath);
    changed = true;
  }

  // ③ plugins.entries — 完整实体（enabled / hooks / config.coordclawJsonPath）
  cfg.plugins.entries = cfg.plugins.entries || {};
  if (!cfg.plugins.entries[ctx.pluginId]) {
    cfg.plugins.entries[ctx.pluginId] = {
      enabled: true,
      hooks: { allowConversationAccess: true },
      config: { coordclawJsonPath: ctx.coordclawPath, cacheTtlMs: 60000 },
    };
    changed = true;
  } else {
    const e = cfg.plugins.entries[ctx.pluginId];
    if (e.enabled !== true) { e.enabled = true; changed = true; }
    if (!e.config || e.config.coordclawJsonPath !== ctx.coordclawPath) {
      e.config = e.config || {};
      e.config.coordclawJsonPath = ctx.coordclawPath;
      changed = true;
    }
  }

  // ④ skills.load.extraDirs — 技能目录
  cfg.skills = cfg.skills || {};
  cfg.skills.load = cfg.skills.load || {};
  cfg.skills.load.extraDirs = cfg.skills.load.extraDirs || [];
  if (!cfg.skills.load.extraDirs.includes(ctx.skillDirPath)) {
    cfg.skills.load.extraDirs.push(ctx.skillDirPath);
    changed = true;
  }

  // ⑦ gateway.http.endpoints.chatCompletions — 启用 chatCompletions 端点
  cfg.gateway = cfg.gateway || {};
  cfg.gateway.http = cfg.gateway.http || {};
  cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {};
  cfg.gateway.http.endpoints.chatCompletions = cfg.gateway.http.endpoints.chatCompletions || {};
  if (cfg.gateway.http.endpoints.chatCompletions.enabled !== true) {
    cfg.gateway.http.endpoints.chatCompletions.enabled = true;
    changed = true;
  }

  return changed;
}

/** 写回 openclaw.json（与 writeCoordClawJson 对称；openclaw 读取走 readJsonFileSync 无缓存，故不调 clearCache） */
export function writeOpenClawJson(cfg: any, path: string): void {
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * 读取 coordclaw.json
 */
export function readCoordClawJson(): TeamClawConfig {
  return ConfigResolver.getInstance().readCoordClawCached();
}

/**
 * 写入 coordclaw.json（同时清缓存）
 */
export function writeCoordClawJson(config: TeamClawConfig): void {
  const jsonPath = resolveCoordClawJsonPath();
  writeFileSync(jsonPath, JSON.stringify(config, null, 2), 'utf-8');
  ConfigResolver.getInstance().clearCache();
  console.log(`[ConfigResolver] ✅ Updated coordclaw.json: ${jsonPath}`);
}

/** 外部（Gateway）修改了 coordclaw.json → 清缓存 */
export function clearCoordClawCache(): void {
  ConfigResolver.getInstance().clearCache();
}

// ============ 路径解析（coordclaw.json 为唯一权威） ============

/** 路径规范化：正反斜杠统一为平台分隔符，去尾斜杠 */
export function normalizePath(p: string): string {
  return normalize(p.replace(/[/\\]/g, sep));
}

/**
 * 路径收敛层（P3/F3·控制面板独立包，无法 import 插件 shared/paths，故同语义实现一份）。
 * 展开 ~ 与 ${ENV}，分隔符归一，解析为绝对路径。
 * 对当前 OS 已有效的绝对路径为恒等变换（安全向后兼容）。
 */
export function expandPath(p: string): string {
  if (!p) return p;
  let s = p.replace(/^~/, () => homedir());
  s = s.replace(/\$\{([^}]+)\}/g, (_m, k) => process.env[k] ?? homedir());
  s = s.split('/').join(sep).split('\\').join(sep);
  s = resolve(s);
  return s;
}

// ============ 外部平台扫描 ============

/** 额外平台扫描配置文件名 */
export const FINDPLATFORMS_JSON_FILENAME = 'findplatforms.json';

export interface PlatformConfig {
  directories: string[];
  mklinkforplugins: string[];
}

/** 读取额外平台配置（从 findplatforms.json），文件不存在或格式错误返回空配置 */
export function readPlatformConfig(rootDir: string): PlatformConfig {
  const fp = join(rootDir, FINDPLATFORMS_JSON_FILENAME);
  if (!existsSync(fp)) return { directories: [], mklinkforplugins: [] };
  try {
    const cfg = JSON.parse(readFileSync(fp, 'utf-8'));
    return {
      directories: Array.isArray(cfg.directories) ? cfg.directories : [],
      mklinkforplugins: Array.isArray(cfg.mklinkforplugins) ? cfg.mklinkforplugins : [],
    };
  } catch { return { directories: [], mklinkforplugins: [] }; }
}

/** 解析外部平台路径 — 绝对路径直接用，相对路径基于 rootDir 解析，跨平台兼容 */
export function resolveExternalPlatformDir(rootDir: string, raw: string): string {
  return normalize(resolve(rootDir, raw));
}

/** 按 projId 查项目根目录（路径规范化） */
export function resolveProjectRoot(projId: string): string | null {
  const cfg = readCoordClawJson();
  for (const team of cfg.teams) {
    for (const proj of team.projects) {
      if (proj.id === projId) return expandPath(proj.root);
    }
  }
  return null;
}

/** 按 teamId 查模板目录（路径规范化） */
export function resolveTeamTemplatePath(teamId: string): string | null {
  const cfg = readCoordClawJson();
  const team = cfg.teams.find(t => t.id === teamId);
  if (!team?.templatePath) return null;
  return expandPath(team.templatePath);
}

/**
 * 获取所有项目（按团队分组），供前端项目选择器使用
 */
export function getAllProjects(): AllProjectsResult {
  const config = readCoordClawJson();

  const teams = config.teams.map(team => ({
    id: team.id,
    name: team.name,
    templatePath: team.templatePath,
    projects: team.projects.map(project => ({
      id: project.id,
      name: project.name,
      root: project.root,
      status: project.status || 'inactive',
      teamId: team.id,
      teamName: team.name,
    })),
  }));

  return { teams };
}

/**
 * 切换激活项目
 * - 将指定项目设为 active，其余所有项目（含其他团队）设为 inactive
 * - 清除配置缓存，下次 getConfig() 会读取新的 active 项目
 */
/**
 * ⚠️ 死代码（v2.4 N7）：本函数在控制面板 src 中无任何调用方（grep 实锤）。
 * 真实项目切换链路为 handlers/projects.ts handleSwitchProject → callGateway(/project-switch) + ctx.notifyProjectSwitched()
 * （server.ts:686→:689 用 getConfig().projectRoot，来源 resolveTeamClawConfig:403）。
 * 保留此函数无运行时影响，请勿将其当作"切换→DB 重连主链路"。
 */
export function switchActiveProject(projectId: string): SwitchProjectResult {
  const config = readCoordClawJson();

  let found = false;
  let targetRoot = '';

  // 遍历所有团队的所有项目，更新 status
  for (const team of config.teams) {
    for (const project of team.projects) {
      if (project.id === projectId) {
        project.status = 'active';
        targetRoot = project.root;
        found = true;
      } else {
        project.status = 'inactive';
      }
    }
  }

  if (!found) {
    return {
      success: false,
      error: `未找到项目: ${projectId}`,
    };
  }

  writeCoordClawJson(config);

  console.log(`[ConfigResolver] 🔄 Switched active project: ${projectId} (${targetRoot})`);

  return {
    success: true,
    projectId,
    projectRoot: targetRoot,
  };
}
