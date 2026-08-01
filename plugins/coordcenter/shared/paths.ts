import path from "path";
import fs from "fs";
import os from "os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

let cachedRoot: string | null = null;
let cachedRootTime = 0;
let cachedUserDir: string | null = null;
const PATH_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟缓存过期（仅用于 root 缓存；userDir 锁定值永不过期）
let _configFallbackPaths: string[] = [];
let _initWarned = false;

export function setConfigFallbackPaths(paths: string[]): void {
  _configFallbackPaths = paths.filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => path.resolve(p.trim()));
}

export function setUserDirFromRuntime(userDir: string): void {
  // 锁定值永不过期：运行时事实不该 5min 后过期导致二次探测/回退 ~/.qclaw
  if (userDir && userDir.trim()) {
    cachedUserDir = userDir.trim();
  }
}

// CoordClaw 安装根目录（由插件 index.ts 在启动时注入）
let _coordClawRoot: string | null = null;
export function setCoordClawRoot(root: string): void {
  _coordClawRoot = root;
}
export function getCoordClawRoot(): string | null {
  return _coordClawRoot;
}

/**
 * 统一路径收敛层（P3/F3·v2.4 #5 落地）：展开 ~ 与 ${ENV}，分隔符归一，解析为绝对路径。
 * 对当前 OS 已有效的绝对路径为恒等变换（安全向后兼容；M1 下 .ts 改动即时生效）。
 * 不在此做 realpath（避免改变存储值；仅内部相等性判断用，见铁律）。
 */
export function expandPath(p: string): string {
  if (!p) return p;
  let s = p.replace(/^~/, () => os.homedir());
  s = s.replace(/\$\{([^}]+)\}/g, (_m, k) => process.env[k] ?? os.homedir());
  s = s.split('/').join(path.sep).split('\\').join(path.sep);
  s = path.resolve(s);
  return s;
}

function tryDeriveRootFromDir(dir: string): string | null {
  try {
    const openclawPkgDir = findPackageJsonDir(dir);
    if (!openclawPkgDir) return null;
    const root = path.dirname(path.dirname(openclawPkgDir));
    if (fs.existsSync(path.join(root, "package.json"))) return root;
  } catch {}
  return null;
}

function resolveFromConfigPaths(): string[] {
  const results: string[] = [];
  for (const configPath of _configFallbackPaths) {
    const root = tryDeriveRootFromDir(configPath);
    if (root) results.push(root);
  }
  return results;
}

export async function initPaths(): Promise<void> {
  // 根目录：经单一候选收集器（process-local 优先，OPENCLAW_PACKAGE_ROOT 仅作最低 override）
  const root = detectAllRootCandidates()[0] ?? "";
  if (root) {
    cachedRoot = root;
    cachedRootTime = Date.now();
  } else if (!_initWarned) {
    _initWarned = true;
    console.warn(`[coordcenter] 无法检测 OpenClaw 根目录，RPC 功能将不可用。请设置环境变量 OPENCLAW_PACKAGE_ROOT`);
  }
  // userDir 由 setUserDirFromRuntime 在 initEnvironment 中锁定，此处不再独立探测（避免与网关分歧/脏 env 命中旧宿主目录）
}

function findPackageJsonDir(startDir: string, maxDepth: number = 12): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "openclaw") return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveByCwd(): string | null {
  try {
    const openclawPkgDir = findPackageJsonDir(process.cwd());
    if (!openclawPkgDir) return null;
    return openclawPkgDir;
  } catch {
    return null;
  }
}

function resolveByArgv(): string | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;
    const openclawPkgDir = findPackageJsonDir(path.dirname(argv1));
    if (!openclawPkgDir) return null;
    return openclawPkgDir;
  } catch {
    return null;
  }
}

function resolveByExecPath(): string | null {
  try {
    const execPath = process.execPath;
    if (!execPath) return null;
    const installRoot = path.dirname(execPath);
    const candidate = path.join(installRoot, "resources", "openclaw");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    return null;
  } catch {
    return null;
  }
}

function resolveByEnvQClawCliMjs(): string | null {
  try {
    const mjs = process.env.QCLAW_CLI_OPENCLAW_MJS?.trim();
    if (!mjs) return null;
    const openclawPkgDir = findPackageJsonDir(path.dirname(mjs));
    if (!openclawPkgDir) return null;
    const root = path.dirname(path.dirname(openclawPkgDir));
    if (fs.existsSync(path.join(root, "package.json"))) return root;
    return null;
  } catch {
    return null;
  }
}



function getRoot(): string {
  if (cachedRoot && Date.now() - cachedRootTime < PATH_CACHE_TTL_MS) return cachedRoot;
  const detected = detectAllRootCandidates()[0] ?? "";
  if (detected) {
    cachedRoot = detected;
    cachedRootTime = Date.now();
    return detected;
  }
  if (!_initWarned) {
    _initWarned = true;
    console.warn(`[coordcenter] getRoot() 失败: 所有检测方法均未找到 OpenClaw 根目录。请设置环境变量 OPENCLAW_PACKAGE_ROOT`);
  }
  return "";
}

// ==================== SDK 模块定位（新旧版本兼容，QClaw/AutoClaw 兼容） ====================

/** 遍历所有 root 候选找 dist（进程优先，避免全局 npm 污染） */
function resolvePluginSdkDistDir(): string | null {
  // 复用唯一候选收集器；其首候选即 process-local 模块解析根（已含 SDK 兜底），真正 DRY
  for (const root of detectAllRootCandidates()) {
    const dist = findExistingDist(root);
    if (dist) return dist;
  }
  return null;
}

/**
 * 收集所有 openclaw 根目录候选（不提前返回）。
 * 优先级：process-local 模块解析（最贴近当前进程实际加载的 SDK，免疫脏 env 继承）>
 * cwd/argv/exec/env-mjs/configPaths > OPENCLAW_PACKAGE_ROOT（最低优先级显式 override，兼容自定义安装位）。
 */
function detectAllRootCandidates(): string[] {
  const candidates: string[] = [];

  // 1. process-local 模块解析：直接问当前进程加载的 openclaw/plugin-sdk 在哪（免疫继承 env 污染）
  try {
    const require = createRequire(import.meta.url);
    const sdkPath = require.resolve("openclaw/plugin-sdk");
    candidates.push(path.resolve(sdkPath, "..", "..", ".."));
  } catch {
    try {
      const url = import.meta.resolve("openclaw/plugin-sdk");
      candidates.push(path.resolve(fileURLToPath(url), "..", "..", ".."));
    } catch {}
  }

  // 2. 进程/安装位置推导（不含用户目录类 env）
  try { const r = resolveByCwd(); if (r) candidates.push(r); } catch {}
  try { const r = resolveByArgv(); if (r) candidates.push(r); } catch {}
  try { const r = resolveByExecPath(); if (r) candidates.push(r); } catch {}
  try { const r = resolveByEnvQClawCliMjs(); if (r) candidates.push(r); } catch {}
  candidates.push(...resolveFromConfigPaths());

  // 3. 最低优先级：OPENCLAW_PACKAGE_ROOT 仅作显式 override（兼容非标准安装位；脏 env 风险由使用者自担）
  if (process.env.OPENCLAW_PACKAGE_ROOT?.trim()) {
    candidates.push(process.env.OPENCLAW_PACKAGE_ROOT.trim());
  }

  return candidates.filter((c) => c && fs.existsSync(path.join(c, "package.json")));
}

/** 从 openclaw 根目录探测实际 dist 位置 */
function findExistingDist(root: string): string | null {
  // AutoClaw: dist 直接在根下
  if (fs.existsSync(path.join(root, "dist"))) return path.join(root, "dist");
  // QClaw: node_modules/openclaw/dist/
  const nested = path.join(root, "node_modules", "openclaw", "dist");
  if (fs.existsSync(nested)) return nested;
  return null;
}

/**
 * 统一兼容新旧版本 openclaw 的 SDK 模块定位。
 *
 * 版本差异：
 *   ≥2026.4.x: 命名规范 call.runtime.js / sessions.runtime.js / agent-scope-DGt-MSYm.js
 *   2026.3.8:  esbuild code-split 产物 call-{hash}.js / sessions-{hash}.js 等
 *
 * @param moduleName   新版精确文件名（如 "call.runtime.js"）
 * @param fallbackPrefix 旧版 glob 匹配前缀（如 "call-"），传入 null 则不做 fallback
 * @returns 可 import 的 file:// URL 字符串（Windows 绝对路径经 pathToFileURL 转换，
 *         规避 ESM dynamic import 对裸绝对路径报 scheme 错）；distDir 缺失时回退相对路径
 *         （ESM 相对 specifier 合法），让下游 import 给出明确错误
 */
function resolveSdkModuleCompat(moduleName: string, fallbackPrefix: string | null = null): string {
  const distDir = resolvePluginSdkDistDir();
  if (!distDir) {
    return `node_modules/openclaw/dist/${moduleName}`;
  }

  // 1. 优先精确匹配（新版 clean-path）
  const exact = path.join(distDir, moduleName);
  if (fs.existsSync(exact)) return pathToFileURL(exact).href;

  // 2. 兼容旧版：按前缀 glob 匹配 hash-suffixed 文件
  if (fallbackPrefix) {
    try {
      const files = fs.readdirSync(distDir);
      const match = files.find(
        (f: string) => f.startsWith(fallbackPrefix) && f.endsWith(".js")
      );
      if (match) return pathToFileURL(path.join(distDir, match)).href;
    } catch {}
  }

  // 3. 都没找到，转 file:// URL——让下游 dynamic import 给出明确"找不到模块"错误
  return pathToFileURL(exact).href;
}

export function getCallGatewayModule(): string {
  return resolveSdkModuleCompat("call.runtime.js", "call-");
}

export function getOpenClawResetModule(): string {
  return resolveSdkModuleCompat("sessions.runtime.js", "sessions-");
}

export function getAgentScopeModule(): string {
  return resolveSdkModuleCompat("agent-scope-DGt-MSYm.js", "agent-scope-");
}

/** @deprecated 别名，兼容旧引用 */
export const resolveOpenclawDistDir = resolvePluginSdkDistDir;
export function getOpenClawRoot(): string { return getRoot(); }

/**
 * 读取 OpenClaw 框架包（openclaw 依赖包）的权威 version。
 *
 * 复用 resolveOpenclawDistDir()（= resolvePluginSdkDistDir）——所有 gateway SDK 模块加载器
 * 共用的"框架 dist 定位"单一真源，已处理 QClaw（node_modules/openclaw/dist）与
 * AutoClaw（根下 dist）两套布局，无需任何新路径/环境变量逻辑。
 *
 * 框架包根 = dirname(distDir)，其 package.json.version 即框架版本：
 *   - QClaw：distDir = <root>/node_modules/openclaw/dist → 父目录 = 框架包根
 *   - AutoClaw：distDir = <root>/dist（root 即框架本身）→ 父目录 = 框架包根
 *
 * 注意：distDir 为 null（极端部署检测失败）时直接返回 ""，绝不回落 getOpenClawRoot()
 * （那是启动壳 openclaw-runtime 的版本，非框架包，会写错版本）。失败由调用方
 * api.runtime.version 兜底。
 */
export function getOpenClawFrameworkVersion(): string {
  const distDir = resolveOpenclawDistDir();
  if (!distDir) return "";
  const pkgDir = path.dirname(distDir);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    return j.version || "";
  } catch {
    return "";
  }
}

/**
 * 唯一用户目录真源：返回宿主运行时经 setUserDirFromRuntime 锁定的目录
 * （对应网关 resolveStateDir，由 initEnvironment 注入，进程作用域、免疫脏 env 继承）。
 * 不再独立探测 env 或回退 ~/.qclaw，避免与网关产生第二处分歧目录。
 */
function getUserDir(): string {
  if (cachedUserDir) return cachedUserDir;
  // V9：未注入时 fail-fast，绝不返回 ""（否则 path.join("", ...) 会落到相对 cwd，比 env 更隐蔽的分散源）
  throw new Error(
    "[coordcenter] getUserDir() 未初始化：宿主运行时未注入用户目录（setUserDirFromRuntime 未调用）。请检查初始化顺序。"
  );
}

export function getOpenClawUserDir(): string { return getUserDir(); }

const COORDCLAW_DATA_DIR_NAME = "CoordClaw";

function resolveAppDataDir(): string {
  return process.env.APPDATA || os.homedir();
}

export function getCoordClawDataDir(): string {
  return path.join(resolveAppDataDir(), COORDCLAW_DATA_DIR_NAME);
}

export function getCoordClawJsonPath(): string {
  return path.join(getOpenClawUserDir(), "coordclaw.json");
}

/** 获取插件配置 config.json 的完整路径（位于 coordclaw 数据目录） */
export function getConfigJsonPath(): string {
  return path.join(getCoordClawDataDir(), "config.json");
}

export function getCoordClawLogsDir(): string {
  return path.join(getCoordClawDataDir(), "logs");
}

/**
 * v19.25 - LLM 请求导出目录（完整 system 提示词）
 * 文件布局：%APPDATA%/CoordClaw/llm-input-dump/{runId}/turn_NNN.json
 */
export function getLlmInputDumpDir(): string {
  return path.join(getCoordClawDataDir(), "llm-input-dump");
}

// ==================== 项目级文件路径（root = projectRoot） ====================

/** 团队配置文件名 */
export const TEAM_JSON_FILENAME = ".data/team.json";

/** 团队规则文件名 */
export const TEAM_RULE_MD_FILENAME = ".data/team RULE.md";

/** 数据目录名（相对于 projectRoot） */
export const DATA_DIR_NAME = ".data/data";

/** 数据库文件名 */
export const DATABASE_FILENAME = "coordclaw.db";

/**
 * 获取 team.json 的完整路径
 * @param projectRoot 项目根目录（由 resolveProjectRoot 返回）
 */
export function getTeamJsonPath(projectRoot: string): string {
  return path.join(expandPath(projectRoot), TEAM_JSON_FILENAME);
}

/**
 * 获取 team RULE.md 的完整路径
 * @param projectRoot 项目根目录
 */
export function getTeamRuleMdPath(projectRoot: string): string {
  return path.join(projectRoot, TEAM_RULE_MD_FILENAME);
}

/**
 * 获取 coordclaw.db 的完整路径（含 path.resolve 确保绝对路径）
 * @param projectRoot 项目根目录
 */
export function getCoordClawDbPath(projectRoot: string): string {
  return path.resolve(path.join(projectRoot, DATA_DIR_NAME, DATABASE_FILENAME));
}

// ==================== 框架级文件路径（root = stateDir / QCLAW_HOME） ====================

/**
 * 获取 OpenClaw 框架 sessions.json 的完整路径
 *
 * 注意：sessions.json 是框架管理的会话注册表，位于 QCLAW_HOME/agents/{agentId}/sessions/
 * 下，不属于项目级（projectRoot）文件体系。因此参数使用 stateDir 而非 projectRoot。
 *
 * @param stateDir 框架状态目录（由 api.runtime.stateDir 或 getConfig().stateDir 提供）
 */
export function getSessionsJsonPath(stateDir: string): string {
  return path.join(stateDir, "sessions", "sessions.json");
}

// ==================== 团队管理路径（功能17：新建团队） ====================

/** coordclaw-teams 团队汇总文件夹名称 */
export const TEAMS_DIR_NAME = "coordclaw-teams";

/** 团队模板目录名称 */
export const TEAM_TEMPLATE_DIR_NAME = "teamstemplate";

/** 团队 SOUL 定义文件名 */
export const TEAMSOUL_FILENAME = "teamsoul.md";

/** openclaw.json 配置文件名 */
export const OPENCLAW_JSON_FILENAME = "openclaw.json";

/**
 * 获取 coordclaw-teams 团队汇总目录的完整路径
 * 位于用户目录下，与 coordclaw.json 同级
 */
export function getCoordClawTeamsDir(): string {
  return path.join(getOpenClawUserDir(), TEAMS_DIR_NAME);
}

/**
 * 获取指定团队目录的完整路径
 * @param teamId 团队 ID（如 "team-c"）
 */
export function getTeamDir(teamId: string): string {
  return path.join(getCoordClawTeamsDir(), teamId);
}

/**
 * 获取指定团队 .data 子目录的完整路径
 * @param teamId 团队 ID
 */
export function getTeamDataDir(teamId: string): string {
  return path.join(getTeamDir(teamId), ".data");
}

/**
 * 获取 openclaw.json 的完整路径
 * 位于用户目录下
 */
export function getOpenClawJsonPath(): string {
  return path.join(getOpenClawUserDir(), OPENCLAW_JSON_FILENAME);
}

/**
 * 获取 agent workspace 目录的完整路径
 * @param agentId agent 标识符（如 "chenmo-pm"）
 */
export function getWorkspaceDirForAgent(agentId: string): string {
  return path.join(getOpenClawUserDir(), `workspace-${agentId}`);
}

/**
 * 获取团队模板 .data 目录的完整路径
 *
 * 策略：
 *   1. 从 CoordClaw 安装根目录拼接 teamstemplate/{语言}/.data
 *   2. 降级：通过注入的 CoordClaw 根目录 + 语言子目录
 */
export function getTeamTemplateDataDir(): string {
  const langSubDir = getDeployLanguage();

  if (_coordClawRoot) {
    const baseDir = path.join(_coordClawRoot, TEAM_TEMPLATE_DIR_NAME);
    const primaryPath = path.join(baseDir, langSubDir, ".data");
    if (fs.existsSync(primaryPath)) return primaryPath;
    if (langSubDir !== "zh") {
      const fallbackPath = path.join(baseDir, "zh", ".data");
      if (fs.existsSync(fallbackPath)) return fallbackPath;
    }
  }

  return "";
}

/** 读取 coordclaw.json 的 language 字段，默认 "zh" */
function getDeployLanguage(): string {
  try {
    const jsonPath = getCoordClawJsonPath();
    if (!fs.existsSync(jsonPath)) return "zh";
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(raw);
    const lang = (data.language || "").toLowerCase();
    return lang === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

// ==================== 项目管理路径（功能18：新建项目） ====================

// getProjectTeamJsonPath 已废弃：与 getTeamJsonPath(projectRoot) 等价
// （前者仅多一次 expandPath，现已折入 getTeamJsonPath）。调用方改用 getTeamJsonPath。

// ==================== Gateway 配置（env 优先，文件兜底） ====================

export function resolveGatewayUrl(): string {
  const envPort = process.env.OPENCLAW_GATEWAY_PORT;
  if (envPort) return `http://127.0.0.1:${envPort}`;
  // 回退：openclaw.json gateway.port
  try {
    const userDir = getOpenClawUserDir();
    if (userDir) {
      const configPath = path.join(userDir, "openclaw.json");
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const port = cfg?.gateway?.port;
        if (port) return `http://127.0.0.1:${port}`;
      }
    }
  } catch {}
  return "http://127.0.0.1:28789";
}

export function resolveGatewayToken(): string {
  // AutoClaw: 环境变量
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) return envToken;
  // QClaw: openclaw.json gateway.auth.token
  try {
    const userDir = getOpenClawUserDir();
    if (userDir) {
      const configPath = path.join(userDir, "openclaw.json");
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const token = cfg?.gateway?.auth?.token;
        if (token) return token;
      }
    }
  } catch {}
  return "";
}
