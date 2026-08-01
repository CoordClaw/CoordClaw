import fsSync from "fs";
import path from "path";
import { getCoordClawLogsDir } from "./paths";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

export interface LogConfig {
  enable: boolean;
  level: LogLevel;
  writeToFile: boolean;
}

export interface ModuleLogConfig {
  [moduleName: string]: LogConfig;
}

export interface GlobalLogConfig {
  enabled: boolean;
  globalLevel: LogLevel;
  modules: ModuleLogConfig;
}

const DEFAULT_CONFIG: GlobalLogConfig = {
  enabled: true,
  globalLevel: LogLevel.INFO,
  modules: {
    'system': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'prompt-injection': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'message-routing': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'session-reset': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'session-whitelist': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'plugin': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'concurrency': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'rpc-client': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'test-rpc': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'workspace-reset': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'broadcast-v2': { enable: true, level: LogLevel.INFO, writeToFile: true },
    'run-tracker': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'session-queue': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'patch': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'snapshot-persist': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'llm-input-dump': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'llm-raw': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'team-create': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'soul-parser': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'cache-coordinator': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
    'cache-sync': { enable: true, level: LogLevel.DEBUG, writeToFile: true },
  }
};

let logDir: string | null = null;
let logApiRef: any = null;
let globalConfig: GlobalLogConfig = DEFAULT_CONFIG;

function getDatePrefix(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getModuleLogFile(moduleName: string): string {
  return path.join(getCoordClawLogsDir(), `${getDatePrefix()}-plugin-${moduleName}.log`);
}

function getLogDir(): string {
  return getCoordClawLogsDir();
}

export function initLogger(api: any, config?: Partial<GlobalLogConfig>, retentionDays?: number): void {
  logApiRef = api;
  if (config) applyLogConfig(config);

  const baseLogDir = getCoordClawLogsDir();
  api.logger.info(`[logger] Target log directory: ${baseLogDir}`);

  try {
    fsSync.mkdirSync(baseLogDir, { recursive: true });
    api.logger.info(`[logger] Log directory created/exists: ${baseLogDir}`);
  } catch (err: any) {
    api.logger.error(`[logger] Failed to create log directory: ${err.message}`);
    return;
  }

  logDir = baseLogDir;

  rotateAllLogs(baseLogDir);

  if (retentionDays && retentionDays > 0) {
    cleanOldLogs(baseLogDir, retentionDays);
  }

  api.logger.info(`[logger] Global logging enabled: ${globalConfig.enabled}`);
  api.logger.info(`[logger] Global log level: ${LogLevel[globalConfig.globalLevel]}`);
  for (const [moduleName, config] of Object.entries(globalConfig.modules)) {
    const status = config.enable ? 'ENABLED' : 'DISABLED';
    const level = LogLevel[config.level];
    api.logger.info(`[logger] Module '${moduleName}': ${status}, level=${level}`);
  }
}

function cleanOldLogs(dir: string, retentionDays: number): void {
  try {
    const cutoff = Date.now() - retentionDays * 86400000;
    const files = fsSync.readdirSync(dir);
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.log') && !f.endsWith('.jsonl')) continue;
      try {
        const stat = fsSync.statSync(path.join(dir, f));
        if (stat.birthtime.getTime() < cutoff) {
          fsSync.unlinkSync(path.join(dir, f));
          removed++;
        }
      } catch { /* 单个文件处理失败不影响其他 */ }
    }
  } catch { /* 清理失败不影响日志系统 */ }
}

export function cleanOldLogFiles(retentionDays: number): void {
  const dir = getCoordClawLogsDir();
  cleanOldLogs(dir, retentionDays);
}

export function applyLogConfig(config: Partial<GlobalLogConfig>): void {
  const mergedModules = config.modules
    ? Object.entries(config.modules).reduce((acc, [modName, modOverrides]) => {
        const existing = globalConfig.modules[modName] || { enable: true, level: LogLevel.DEBUG, writeToFile: true };
        acc[modName] = { ...existing, ...modOverrides };
        return acc;
      }, { ...globalConfig.modules } as Record<string, LogConfig>)
    : globalConfig.modules;

  globalConfig = {
    ...globalConfig,
    ...config,
    modules: mergedModules
  };
}

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

function formatMessage(
  moduleName: string,
  level: LogLevel,
  message: string,
  eventId?: string | null
): string {
  const timestamp = formatTimestamp();
  const levelStr = LogLevel[level];
  const eventPrefix = eventId ? `[${eventId}] ` : '';
  return `[${timestamp}] [${moduleName.toUpperCase()}] [${levelStr}] ${eventPrefix}${message}\n`;
}

function shouldLog(moduleName: string, level: LogLevel): boolean {
  if (!globalConfig.enabled) {
    return false;
  }

  if (level < globalConfig.globalLevel) {
    return false;
  }

  const moduleConfig = globalConfig.modules[moduleName];
  if (!moduleConfig || !moduleConfig.enable) {
    return false;
  }

  if (level < moduleConfig.level) {
    return false;
  }

  return true;
}

// ==================== 日志轮转（启动时统一扫描） ====================
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_BACKUPS = 5;

export function rotateAllLogs(dir: string): void {
  try {
    const files = fsSync.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.log') && !f.endsWith('.jsonl')) continue;
      // 跳过已轮转的文件（文件名中包含 .数字.log / .数字.jsonl 后缀）
      if (/\.\d+\.(log|jsonl)$/.test(f)) continue;

      const filePath = path.join(dir, f);
      try {
        const stat = fsSync.statSync(filePath);
        if (stat.size < MAX_LOG_SIZE_BYTES) continue;

        const ext = f.endsWith('.jsonl') ? '.jsonl' : '.log';
        const baseName = filePath.slice(0, -ext.length);
        // 尾部清理：先删最老的，再逐个上移
        const oldestPath = `${baseName}.${MAX_LOG_BACKUPS}${ext}`;
        if (fsSync.existsSync(oldestPath)) fsSync.unlinkSync(oldestPath);
        for (let i = MAX_LOG_BACKUPS - 1; i >= 0; i--) {
          const oldPath = i === 0 ? filePath : `${baseName}.${i}${ext}`;
          const newPath = `${baseName}.${i + 1}${ext}`;
          if (fsSync.existsSync(oldPath)) {
            fsSync.renameSync(oldPath, newPath);
          }
        }
      } catch { /* 单文件轮转失败不影响其他 */ }
    }
  } catch { /* 目录扫描失败不影响日志系统 */ }
}

function writeToFile(moduleName: string, formattedMessage: string): void {
  if (!logDir) return;

  const moduleConfig = globalConfig.modules[moduleName];
  if (!moduleConfig || !moduleConfig.writeToFile) return;

  const logFile = getModuleLogFile(moduleName);

  try {
    fsSync.appendFileSync(logFile, formattedMessage);
  } catch { /* 文件写入失败不影响日志系统 */ }
}

export function log(
  moduleName: string,
  level: LogLevel,
  message: string,
  eventId?: string | null
): void {
  if (!shouldLog(moduleName, level)) {
    return;
  }

  const formattedMessage = formatMessage(moduleName, level, message, eventId);

  writeToFile(moduleName, formattedMessage);
}

export function debug(moduleName: string, message: string, eventId?: string | null): void {
  log(moduleName, LogLevel.DEBUG, message, eventId);
}

export function info(moduleName: string, message: string, eventId?: string | null): void {
  log(moduleName, LogLevel.INFO, message, eventId);
}

export function warn(moduleName: string, message: string, eventId?: string | null): void {
  log(moduleName, LogLevel.WARN, message, eventId);
}

export function error(moduleName: string, message: string, eventId?: string | null): void {
  log(moduleName, LogLevel.ERROR, message, eventId);
}

/**
 * Returns the current event ID for log correlation, or null if not in an event context.
 * TODO: Integrate with event tracking system to return actual event IDs.
 */
export function getEventId(): string | null {
  return null;
}
