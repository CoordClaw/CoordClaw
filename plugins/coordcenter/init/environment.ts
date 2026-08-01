/**
 * 环境引导 — Phase 0+1
 *
 * 从 OpenClaw api 对象推导所有运行时路径和配置。
 * 产出 BootContext 供后续阶段使用。
 */

import { initLogger, applyLogConfig, LogLevel, cleanOldLogFiles, debug, info, warn, error, getEventId } from "../shared/logger";
import { initDefaultPlaceholders } from "../shared/template";
import { setConfigFallbackPaths, setUserDirFromRuntime, setCoordClawRoot, getCoordClawJsonPath, initPaths } from "../shared/paths";
import { writeConfigJson } from "../shared/config-writer";
import { readCoordClawJson } from "../shared/config-store";
import { migrateCoordClawJson } from "./migrate";
import { dumpRuntimePathDiagnostics } from "./diagnostics";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

export interface BootContext {
  jsonPath: string;
  cacheTtl: number;
  stateDir: string;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export function initEnvironment(api: any): BootContext {
  // ---- Logger ----
  initLogger(api);
  const PLUGIN_VERSION = 'v19.50';
  api.logger.info(`[PLUGIN] version=${PLUGIN_VERSION} loaded, pid=${process.pid}`);
  debug('plugin', `[INIT] register() ENTRY, api keys=[${Object.keys(api).join(",")}]`, getEventId());
  debug('plugin', `[INIT] api.runtime keys=[${Object.keys(api.runtime || {}).join(",")}]`, getEventId());
  debug('plugin', `[INIT] api.registerHttpRoute=${typeof api.registerHttpRoute}`, getEventId());

  dumpRuntimePathDiagnostics(api);

  // ---- 默认占位符 ----
  initDefaultPlaceholders();

  // ---- 配置回退路径 ----
  const rawConfig = api.config || {};
  const configFallbackPaths: string[] = [];
  const pluginLoadPaths = rawConfig.plugins?.load?.paths;
  if (Array.isArray(pluginLoadPaths)) {
    for (const p of pluginLoadPaths) {
      if (typeof p === "string" && p.trim().length > 0) configFallbackPaths.push(p);
    }
  }
  const skillExtraDirs = rawConfig.skills?.load?.extraDirs;
  if (Array.isArray(skillExtraDirs)) {
    for (const p of skillExtraDirs) {
      if (typeof p === "string" && p.trim().length > 0) configFallbackPaths.push(p);
    }
  }
  if (configFallbackPaths.length > 0) {
    setConfigFallbackPaths(configFallbackPaths);
    debug('plugin', `[INIT] config fallback paths set (${configFallbackPaths.length} dirs)`, getEventId());
  }

  // ---- 运行时用户目录 ----
  try {
    const stateDir = api.runtime.state.resolveStateDir();
    if (stateDir) {
      setUserDirFromRuntime(stateDir);
      debug('plugin', `[INIT] user dir from runtime: ${stateDir}`, getEventId());
    }
  } catch {}

  // ---- CoordClaw 安装根目录 ----
  // 哨兵锚定：从当前文件位置向上找包含 teamstemplate/ 的目录。
  // 不依赖深度假设，源文件 / dist 打包 / 目录改名均自动适配。
  try {
    const startDir = (() => {
      try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
      if (typeof __dirname !== 'undefined') return __dirname;
      return '';
    })();

    let coordClawRoot = '';
    if (startDir) {
      let dir = startDir;
      const sysRoot = path.parse(dir).root;
      while (dir !== sysRoot) {
        if (fs.existsSync(path.join(dir, 'teamstemplate'))) { coordClawRoot = dir; break; }
        dir = path.dirname(dir);
      }
    }
    setCoordClawRoot(coordClawRoot);
    debug('plugin', `[INIT] CoordClaw root: ${coordClawRoot || '(not found)'} (from ${startDir})`, getEventId());
  } catch (err: any) {
    warn('plugin', `[INIT] CoordClaw root resolution failed (non-fatal): ${err.message}`, getEventId());
  }

  // ---- 路径初始化 + 存量迁移 + config.json 写入（fire-and-forget，不阻塞 register 返回） ----
  initPaths().then(async () => {
    await migrateCoordClawJson();   // P2a #25: 存量 root/templatePath 锚定迁移（幂等）
    await writeConfigJson(api);
  }).catch((err: any) => {
    error('plugin', `[INIT] 初始化/迁移/配置写入失败(非致命): ${err.message}`, getEventId());
  });

  // ---- 插件配置 ----
  const cfg = (api.pluginConfig || {}) as Record<string, unknown>;
  const jsonPath = (cfg["coordclawJsonPath"] as string) || getCoordClawJsonPath();
  const cacheTtl = (cfg["cacheTtlMs"] as number) ?? DEFAULT_CACHE_TTL_MS;
  const stateDir = api.runtime?.stateDir || '';
  debug('plugin', `[INIT] stateDir=${stateDir}`, getEventId());

  // ---- 日志配置 (from coordclaw.json) ----
  try {
    if (fs.existsSync(jsonPath)) {
      const jsonData = readCoordClawJson(jsonPath);
      if (jsonData.logging) {
        const { level, modules: logModules } = jsonData.logging;
        const globalLevel = LogLevel[level as keyof typeof LogLevel] ?? undefined;
        const parsedModules: Record<string, { level: LogLevel }> = {};
        if (logModules && typeof logModules === 'object') {
          for (const [mod, lvl] of Object.entries(logModules)) {
            const parsed = LogLevel[lvl as keyof typeof LogLevel];
            if (parsed !== undefined) parsedModules[mod] = { level: parsed };
          }
        }
        applyLogConfig({
          ...(globalLevel !== undefined ? { globalLevel } : {}),
          ...(Object.keys(parsedModules).length > 0 ? { modules: parsedModules } : {})
        } as any);
        info('plugin', `[INIT] Logging config loaded from coordclaw.json: global=${LogLevel[globalLevel ?? 0]} modules=${Object.keys(parsedModules).join(',') || '(none)'}`, getEventId());

        const retention = (jsonData.logging as any).retentiondays;
        if (typeof retention === 'number' && retention > 0) {
          cleanOldLogFiles(retention);
        }
      }
    }
  } catch (logCfgErr: any) {
    warn('plugin', `[INIT] Logging config load failed (non-fatal): ${logCfgErr.message}`, getEventId());
  }

  return { jsonPath, cacheTtl, stateDir };
}
