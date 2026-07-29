/**
 * HTTP 服务器核心 - CoordClaw 控制面板
 * 
 * 功能：
 * 1. 静态文件服务（HTML/CSS/JS）
 * 2. RESTful API（消息/成员/已读标记）
 * 3. SSE 实时推送（新消息/已读状态）
 * 4. CORS 支持
 * 5. 健康检查端点
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, watch, statSync, readdirSync, copyFileSync, unlinkSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, exec, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { MessageDatabase } from './database.js';
import { getConfig, ConfigResolver, resolveTeamJsonPath, getAllProjects, resolveDatabasePath, readJsonFileSync, readCoordClawJson, COORDCLAW_CONFIG_PATH, getOpenClawUserDir, clearCoordClawCache, resolveCoordClawJsonPath, resolveProjectRoot, resolveTeamTemplatePath, normalizePath, TEAMSOUL_FILENAME, TEAM_RULE_FILENAME, SKILL_MD_FILENAME, TEAM_JSON_FILENAME, OPENCLAW_JSON_FILENAME, writeCoordClawJson, isCoordClawPluginEnabled, applyOpenClawRegistration, buildOpenClawRegCtx, writeOpenClawJson, PLUGIN_ID, type ControlPanelConfig } from './config-resolver.js';
import { type SSEClient } from './lib/types.js';
import { sendJSON, setCommonHeaders, serveStaticFile, getContentType, handlePreflight, parseBody } from './lib/response.js';
import { joinStatic } from './lib/paths.js';
import { resolveGatewayUrl, readGatewayPid, resolveWebchatUrl } from './lib/gateway.js';
import { readTeamJson as readTeamJsonFromLib, writeTeamJson as writeTeamJsonFromLib } from './lib/team-json.js';
import { type AppContext, type AppConfig } from './lib/context.js';
import { handleOrgChart } from './handlers/orgchart.js';
import { handleTokenStatsDetail } from './handlers/token-stats-detail.js';
import { scanAllSkills, handleRefreshSkills, handleSkills, handleToggleSkill, getMemberSkills, updateMemberSkills, handleInstallSkill, handleOpenSkillDir } from './handlers/skills.js';
import { handleModels, handleSetModel } from './handlers/models.js';
import { openFolder, openFile, browseFolder, handleOpenFolder, handleOpenDir, handleOpenTeamDir, handleOpenFile, handleOpenTeamsoul, handleOpenTeamFile, handleBrowseFolder, handleBrowseFile } from './handlers/files.js';
import { getUpdateInfo } from './tracker.js';
import { handleScan, handleApply } from './handlers/install.js';
import { handleStartTeamMonitor, handleStopTeamMonitor, TEAM_CREATE_STAGES, isValidTeamName } from './handlers/team-monitor.js';
import { handleToggleHuman, handleToggleAutoCoordination, handleToggleMsgRobot } from './handlers/toggle.js';
import { handleGetMessages, handleGetMembers, handleGetUnreadCount, handleGetMessageCount, handleGetMemberUnread, handleMarkRead, handleMarkAllRead, handleExportCSV, handleExportHTML, handleSendMessage, handleToggleRead } from './handlers/messages.js';
import { handleHealthCheck, handleGetProjects, handleMemberStatus, handleRestartGateway } from './handlers/misc.js';
import { handleWorkspaceReset, handleCreateProject, handleDeleteProject, handleDeleteTeam, handleSwitchProject, handleRenameTeam, handleRenameProject } from './handlers/projects.js';
import { broadcastSSE, closeAllSSEConnections, closeAllSSEConnectionsForSwitch, ensureMemberStatusStream, handleSSEStream } from './handlers/sse.js';
import { handleError } from './lib/error-handler.js';
import { AppError } from './lib/errors.js';
import { tokenStatsService } from './lib/token-stats.js';
import { drawBox } from './lib/term-box.js';
import { zh, en } from './lib/i18n-strings.js';
import { normalizeLanguage, resolveDefaultLanguage } from './lib/lang.js';

// ============ 团队创建进度监控配置（导入自 handlers/team-monitor.ts）============

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ HTTP 服务器类 ============

export class ControlPanelServer {
  private server: ReturnType<typeof createServer> | null = null;
  private db: MessageDatabase;
  private config: ReturnType<typeof getConfig>;
  private sseClients: Set<SSEClient> = new Set();
  private teamJsonWatcher: ReturnType<typeof watch> | null = null;
  private isRunning: boolean = false;
  private memberStatusAbort: AbortController | null = null;
  private teamMonitor: { interval: ReturnType<typeof setInterval> | null; teamPath: string } = { interval: null, teamPath: '' };
  private _switchingProject = false;
  private _ctx: AppContext | null = null;
  private _routeTable: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => void> | null = null;
  
  /** 安装模式：config.json 或 coordclaw.json 缺失时自动进入 */
  public isInstallMode = false;
  
  // 统计信息
  private stats = { totalRequests: 0, apiRequests: 0, sseConnections: 0, startTime: null as Date | null };
  
  // ============ 动态端口（P1·跨平台·回收旧实例） ============

  private get pidFile() { return join(__dirname, '..', '.pid'); }

  private sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

  /** 检查进程是否存活（跨平台） */
  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return false;
    if (process.platform === 'win32') {
      try {
        const out = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'buffer', windowsHide: true });
        return out.toString().includes(`"${pid}"`);
      } catch { return false; }
    }
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** 异步检查端口是否空闲（跨平台·真异步） */
  private isPortFreeAsync(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const s = createNetServer();
      s.once('error', (e: NodeJS.ErrnoException) => {
        s.close();
        resolve(e.code !== 'EADDRINUSE');
      });
      s.once('listening', () => { s.close(); resolve(true); });
      s.listen(port); // 无 host，与实际 listen 一致
    });
  }

  /** 启动初期：清理指向死进程的 .pid / .pid.meta */
  private cleanupStalePid(): void {
    try {
      const pidPath = this.pidFile;
      if (!existsSync(pidPath)) return;
      const raw = readFileSync(pidPath, 'utf-8');
      const meta = JSON.parse(raw);
      if (!meta.pid || !this.isProcessAlive(meta.pid)) {
        try { unlinkSync(pidPath); } catch {}
        console.log(`[Port] 🧹 Cleaned dead pid residue (pid=${meta.pid || '?'})`);
      }
    } catch {
      try { unlinkSync(this.pidFile); } catch {}
    }
  }

  /** 轮询等待端口释放（覆盖 TIME_WAIT/释放延迟） */
  private async waitPortFree(port: number, maxTries = 20): Promise<boolean> {
    for (let i = 0; i < maxTries; i++) {
      if (await this.isPortFreeAsync(port)) return true;
      await this.sleep(Math.min(100 * Math.pow(2, i), 500));
    }
    return false;
  }

  /** 端口获取（异步·含回收旧实例 + fallback） */
  private async acquirePort(): Promise<number> {
    this.cleanupStalePid();
    const basePort = this.config.port;

    if (await this.isPortFreeAsync(basePort)) return basePort;

    // 端口被占 → 尝试回收自己的旧实例
    try {
      const pidPath = this.pidFile;
      if (existsSync(pidPath)) {
        const meta = JSON.parse(readFileSync(pidPath, 'utf-8'));
        const recordedPid = Number(meta.pid);
        const recordedCwd = String(meta.cwd || '');

        if (recordedPid && recordedPid !== process.pid &&
            this.isProcessAlive(recordedPid) &&
            recordedCwd === __dirname) {
          console.log(`[Port] 🪓 Detected old instance (pid=${recordedPid}, cwd=${__dirname}), reclaiming...`);

          if (process.platform === 'win32') {
            try { process.kill(recordedPid); } catch {}
          } else {
            try { process.kill(recordedPid, 'SIGTERM'); } catch {}
            await this.sleep(500);
            if (this.isProcessAlive(recordedPid)) {
              console.log('[Port] ⚠️ Old instance did not respond to SIGTERM, forcing SIGKILL');
              try { process.kill(recordedPid, 'SIGKILL'); } catch {}
            }
          }

          const freed = await this.waitPortFree(basePort);
          if (freed && await this.isPortFreeAsync(basePort)) {
            console.log(`[Port] ✅ Reclaimed successfully, port ${basePort} released`);
            return basePort;
          }
          console.log(`[Port] ⚠️ Port ${basePort} still not released after reclaim, fallback`);
        }
      }
    } catch { /* .pid 不存在/损坏 → 跳过回收 */ }

    // fallback
    const fallback1 = basePort + 1;
    console.log(`[Port] ⚠️ Port ${basePort} occupied, trying ${fallback1}`);
    if (await this.isPortFreeAsync(fallback1)) return fallback1;

    const fallback2 = fallback1 + 1;
    console.log(`[Port] ⚠️ Port ${fallback1} also occupied, trying ${fallback2}`);
    if (await this.isPortFreeAsync(fallback2)) return fallback2;

    throw new Error(`无法分配端口: ${basePort}、${fallback1}、${fallback2} 均被占用，请检查端口占用并结束冲突进程`);
  }

  /** 写 .pid（JSON，含 pid/cwd/port/time） */
  private registerPidMeta(port: number): void {
    const pidPath = this.pidFile;
    const meta = { pid: process.pid, cwd: __dirname, port, time: new Date().toISOString() };
    writeFileSync(pidPath, JSON.stringify(meta), 'utf-8');
    console.log(`[PID] Written: ${pidPath} (PID=${process.pid}, port=${port})`);
  }

  /** 安全清理 .pid（校验 ownership：pid 字段===自己才删，防竞态误删新实例文件） */
  private cleanupPidFiles(): void {
    try {
      const pidPath = this.pidFile;
      if (existsSync(pidPath)) {
        const meta = JSON.parse(readFileSync(pidPath, 'utf-8'));
        if (Number(meta.pid) === process.pid) {
          try { unlinkSync(pidPath); } catch {}
        }
      }
    } catch { /* 容错 */ }
  }
  
  constructor(options: { port?: number; skipConfig?: boolean } = {}) {
    // ★ db 恒为真实 MessageDatabase 实例：构造函数已容错，首装 coordclaw.json 缺失也不会抛。
    //   删除原 skipConfig 分支的「空壳桩对象」——它仅 isReady/connect/disconnect/reconnect 四个空方法，
    //   退出安装模式后 this.db 仍缺 getMembers/onChange 等，是前端 /api/members、SSE 报
    //   "getMembers is not a function" 的根因。统一为真实实例，与正常路径复用同一不变量。
    this.db = new MessageDatabase();

    if (!options.skipConfig) {
      this.config = getConfig(true);
      // ★ Token 统计：订阅变更 → 经 SSE 实时推前端
      tokenStatsService.subscribe((snap) => {
        this.broadcastSSE('token_stats_updated', { estTotalTokens: snap.estTotal });
      });
    } else {
      this.config = { port: parseInt(process.env.CONTROL_PANEL_PORT || '18790', 10), databasePath: '', projectRoot: '', projectName: '', currentUser: 'admin', currentUserId: '', corsOrigin: '*', language: resolveDefaultLanguage({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, localeHint: process.env.LANG || process.env.LC_ALL || '' }) } as any;
    }

    if (options.port) {
      this.config.port = options.port;
    }

  }

  /** 获取统一上下文（懒初始化） */
  private getContext(): AppContext {
    if (!this._ctx) {
      this._ctx = {
        db: this.db, config: this.config as unknown as AppConfig, sseClients: this.sseClients,
        stats: this.stats, teamJsonWatcher: this.teamJsonWatcher,
        teamMonitor: this.teamMonitor, memberStatusAbort: this.memberStatusAbort,
        sendJSON: (res, code, data) => this.sendJSON(res, code, data),
        broadcastSSE: (event, data) => this.broadcastSSE(event, data),
        closeAllSSEConnections: () => this.closeAllSSEConnections(),
        closeAllSSEConnectionsForSwitch: () => this.closeAllSSEConnectionsForSwitch(),
        restartTeamJsonWatcher: () => this.restartTeamJsonWatcher(),
        ensureMemberStatusStream: () => this.ensureMemberStatusStream(),
        refreshConfig: () => { this.config = getConfig(true); this.refreshContext(); },
        notifyProjectSwitched: () => this.notifyProjectSwitchedAuto(),
        restartGateway: (mode) => this.restartGateway(mode),
        resolveMemberId: (name) => this.resolveMemberId(name),
        resolveSenderId: (name) => this.resolveSenderId(name),
      };
    }
    return this._ctx;
  }

  /** 配置变更后刷新上下文 */
  private refreshContext(): void { if (this._ctx) { this._ctx.config = this.config as unknown as AppConfig; } }

  /**
   * GET /api/self-heal-openclaw — 启动自愈：检查 openclaw.json 的 CoordClaw 插件注册，
   * 若 enabled 不为 true 则全量重建 ①②③④⑦（不含 agentlist）。前端 SSE connected 后调用。
   * 幂等：健康系统只做一次布尔读取、零写入、零弹窗。
   */
  private handleSelfHealOpenClaw(res: ServerResponse): void {
    try {
      const dir = getOpenClawUserDir();
      const p = join(dir, OPENCLAW_JSON_FILENAME);
      if (!existsSync(p)) {
        this.sendJSON(res, 200, { repaired: false, reason: 'no-file' });
        return;
      }
      let cfg: any;
      try {
        cfg = readJsonFileSync(p);
      } catch (e) {
        console.warn('[SelfHeal] ⚠️ Failed to parse openclaw.json, skip self-heal:', e);
        this.sendJSON(res, 200, { repaired: false, reason: 'corrupt' });
        return;
      }
      if (isCoordClawPluginEnabled(cfg)) {
        this.sendJSON(res, 200, { repaired: false });
        return;
      }
      applyOpenClawRegistration(cfg, buildOpenClawRegCtx(dir));
      cfg.plugins.entries[PLUGIN_ID].enabled = true;
      writeOpenClawJson(cfg, p);
      console.log('[SelfHeal] ✅ Auto-fixed openclaw.json plugin registration');
      this.sendJSON(res, 200, { repaired: true });
    } catch (e) {
      // getOpenClawUserDir 未安装时抛 COORDCLAW_NOT_INSTALLED → 静默跳过（交给安装流程）
      console.warn('[SelfHeal] ⏭️ Not installed or skipped:', (e as Error)?.message);
      this.sendJSON(res, 200, { repaired: false, reason: 'no-install' });
    }
  }

  /** 构建路由表（懒加载） */
  private getRouteTable(): Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => void> {
    if (!this._routeTable) {
      this._routeTable = {
        'GET /api/messages': (req, res, url) => this.handleGetMessages(url, res),
        'GET /api/messages/count': (_req, res) => this.handleGetMessageCount(res),
        'GET /api/members': (_req, res) => this.handleGetMembers(res),
        'GET /api/unread-count': (_req, res) => this.handleGetUnreadCount(res),
        'GET /api/member-unread': (_req, res, url) => this.handleGetMemberUnread(url, res),
        'POST /api/mark-read': (req, res) => this.handleMarkRead(req, res),
        'POST /api/mark-all-read': (req, res) => this.handleMarkAllRead(req, res),
        'POST /api/export-csv': (req, res) => this.handleExportCSV(req, res),
        'POST /api/export-html': (req, res) => this.handleExportHTML(req, res),
        'POST /api/send-message': (req, res) => this.handleSendMessage(req, res),
        'POST /api/toggle-read': (req, res) => this.handleToggleRead(req, res),
        'POST /api/workspace-reset': (req, res) => this.handleWorkspaceReset(req, res),
        'POST /api/create-project': (req, res) => this.handleCreateProject(req, res),
        'POST /api/delete-project': (req, res) => this.handleDeleteProject(req, res),
        'POST /api/delete-team': (req, res) => this.handleDeleteTeam(req, res),
        'POST /api/rename-team': (req, res) => this.handleRenameTeam(req, res),
        'POST /api/rename-project': (req, res) => this.handleRenameProject(req, res),
        'POST /api/open-folder': (req, res) => this.handleOpenFolder(req, res),
        'POST /api/open-file': (req, res) => this.handleOpenFile(req, res),
        'POST /api/open-dir': (req, res) => this.handleOpenDir(req, res),
        'POST /api/open-team-dir': (req, res) => this.handleOpenTeamDir(req, res),
        'POST /api/open-team-rule': (req, res) => this.handleOpenTeamFile(req, res, TEAM_RULE_FILENAME),
        'GET /api/browse-folder': (req, res) => this.handleBrowseFolder(req, res),
        'GET /api/browse-file': (req, res) => this.handleBrowseFile(req, res),
        'GET /api/team-file': (req, res) => this.handleOpenTeamFile(req, res, TEAM_RULE_FILENAME),
        'GET /api/org-chart': (req, res) => this.handleOrgChart(req, res),
        'GET /api/token-stats-detail': (req, res) => this.handleTokenStatsDetail(req, res),
        'POST /api/open-teamsoul': (req, res) => this.handleOpenTeamsoul(req, res),
        'POST /api/start-team-monitor': (req, res) => this.handleStartTeamMonitor(req, res),
        'POST /api/stop-team-monitor': (req, res) => this.handleStopTeamMonitor(req, res),
        'POST /api/toggle-human': (req, res) => this.handleToggleHuman(req, res),
        'POST /api/toggle-auto-coordination': (req, res) => this.handleToggleAutoCoordination(req, res),
        'POST /api/toggle-msg-robot': (req, res) => this.handleToggleMsgRobot(req, res),
        'POST /api/restart-gateway': (req, res) => this.handleRestartGateway(req, res),
        'GET /api/sse-stream': (req, res) => this.handleSSEStream(req, res),
        'GET /api/member-status': (req, res) => this.handleMemberStatus(req, res),
        'GET /api/health': (_req, res) => this.handleHealthCheck(res),
        'GET /api/config': (_req, res) => this.handleGetConfig(res),
        'GET /api/update-info': (_req, res) => this.handleUpdateInfo(res),
        'POST /api/config': (req, res) => this.handlePostConfig(req, res),
        'GET /api/projects': (_req, res) => this.handleGetProjects(res),
        'GET /api/member-skills': (req, res) => this.getMemberSkills(req, res),
        'PUT /api/member-skills': (req, res) => this.updateMemberSkills(req, res),
        'POST /api/install-skill': (req, res) => this.handleInstallSkill(req, res),
        'GET /api/skills': (req, res) => this.handleSkills(req, res),
        'POST /api/skills/refresh': (req, res) => this.handleRefreshSkills(req, res),
        'POST /api/skills/toggle': (req, res) => this.handleToggleSkill(req, res),
        'POST /api/register-team': (req, res) => this.handleRegisterTeam(req, res),
        'POST /api/import-team-tpkg': (req, res) => this.handleImportTeamTpkg(req, res),
        'POST /api/export-team-tpkg': (req, res) => this.handleExportTeamTpkg(req, res),
        'POST /api/project-switch': (req, res) => this.handleSwitchProject(req, res),
        'GET /api/open-skill-dir': (req, res) => this.handleOpenSkillDir(req, res),
        'GET /api/models': (req, res) => this.handleGetModels(req, res),
        'POST /api/model-config': (req, res) => this.handleSetModel(req, res),
        'POST /api/restore-database': (req, res) => this.handleRestoreDatabase(req, res),
        'GET /api/database-status': (_req, res) => this.handleGetDatabaseStatus(res),
        'GET /api/self-heal-openclaw': (_req, res) => this.handleSelfHealOpenClaw(res),
      };
    }
    return this._routeTable;
  }
  
  /**
   * 启动服务器（异步端口获取 + 回收旧实例 + 可重试 listen）
   */
  async start(): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        const acquiredPort = await this.acquirePort();
        this.config.port = acquiredPort;

        if (!this.isInstallMode && this.config.databasePath) {
          this.db.connect();
          this.db.startBackupWatcher();
          // ★ 损坏回调 → SSE 广播，前端弹窗
          this.db.onCorruption = () => this.broadcastSSE('database_corrupted', {
            corrupted: true,
            backupAvailable: this.db.backupAvailable,
            backupCorrupt: this.db.backupCorrupt,
            restoring: false,
          });
        } else if (this.isInstallMode) {
          console.log('[Server] 🔧 Install mode, skipping database connection');
        } else {
          console.log('[Server] 📭 Empty project mode, skipping database connection');
        }

        this.server = createServer((req, res) => this.handleRequest(req, res));

        // 可重试 listen 循环（EADDRINUSE → 自动 +1 fallback）
        const tryListenLoop = (port: number, tried = new Set<number>()) => {
          if (tried.size >= 3) {
            return reject(new Error(`无法分配端口: 已尝试 ${[...tried].join(', ')} 均被占用`));
          }
          tried.add(port);

          this.server!.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
              this.server!.close(); // 清理失败的 server
              console.log(`[Port] ⚠️ Port ${port} bind failed (EADDRINUSE), trying ${port + 1}`);
              this.server = createServer((req, res) => this.handleRequest(req, res));
              tryListenLoop(port + 1, tried);
            } else {
              reject(error);
            }
          });

          this.server!.listen(port, () => {
            this.isRunning = true;
            this.stats.startTime = new Date();
            this.config.port = port;
            this.registerPidMeta(port);

            // 注册优雅退出 handler（仅 listen 成功后）
            const gracefulShutdown = () => {
              console.log('\n[Server] 🛑 Received exit signal, cleaning up...');
              if (this.server) {
                this.server.close(() => { this.cleanupPidFiles(); process.exit(0); });
              } else {
                this.cleanupPidFiles();
                process.exit(0);
              }
            };
            process.once('SIGTERM', gracefulShutdown);
            process.once('SIGINT', gracefulShutdown);
            process.once('SIGQUIT', gracefulShutdown);

            if (!this.isInstallMode) {
              this.setupJsonWatchers();
              this.scanAllSkills();
            }

            const url = `http://localhost:${port}`;
            this.printStartupBanner(url);
            resolve(url);
          });
        };

        tryListenLoop(acquiredPort);

      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      console.log('\n[Server] 🛑 Stopping control panel service...');
      
      // 关闭所有SSE连接
      this.closeAllSSEConnections();
      
      if (this.server) {
        this.server.close(() => {
          // 断开数据库连接 + 清理 pid 文件
          this.db.disconnect();
          this.cleanupPidFiles();
          
          this.isRunning = false;
          this.server = null;
          
          this.printShutdownStats();
          resolve();
        });
      } else {
        this.db.disconnect();
        this.cleanupPidFiles();
        resolve();
      }
    });
  }
  
  /**
   * 检查是否运行中
   */
  public isReady(): boolean {
    return this.isRunning && this.db.isReady();
  }
  
  // ============ 核心请求处理 ============
  
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.stats.totalRequests++;
    
    const url = new URL(req.url || '/', `http://localhost:${this.config.port}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';
    
    try {
      this.setCommonHeaders(res);
      
      if (method === 'OPTIONS') {
        this.handlePreflight(res);
        return;
      }
      
      // ★ 安装向导路由（始终可用：与 isInstallMode 锁解耦，支持主动进入安装页新增/管理平台）
      if (pathname === '/api/install/scan' && method === 'GET') {
        handleScan(req, res);
        return;
      }
      if (pathname === '/api/install/apply' && method === 'POST') {
        handleApply(req, res);
        return;
      }
      if (pathname === '/api/install/complete' && method === 'POST') {
        this.tryExitInstallMode(res);
        return;
      }

      // ★ 安装模式锁：未安装时整站重定向安装页
      if (this.isInstallMode) {
        // 安装模式也支持静态资源
        if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/png/') || pathname.startsWith('/auto/')) {
          const filePath = pathname.slice(1);
          const contentType = this.getContentType(pathname);
          this.serveStaticFile(res, filePath, contentType);
          return;
        }
        // 其余路径返回安装页面
        this.serveStaticFile(res, 'install.html', 'text/html; charset=utf-8');
        return;
      }
      
      // 路由分发
      if (pathname === '/' || pathname === '/index.html' || pathname === '') {
        this.serveStaticFile(res, 'index.html', 'text/html; charset=utf-8');
        return;
      }
      if (pathname === '/install.html') {
        this.serveStaticFile(res, 'install.html', 'text/html; charset=utf-8');
        return;
      }
      
      // 静态资源路由
      if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/png/') || pathname.startsWith('/auto/')) {
        // ★ plugins.json 不存在时返回 failed，避免控制台 404
        if (pathname === '/auto/plugins.json' && !existsSync(joinStatic('auto', 'plugins.json'))) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"status":"failed"}');
          return;
        }
        const filePath = pathname.slice(1); // 去掉前导 /
        const contentType = this.getContentType(pathname);
        this.serveStaticFile(res, filePath, contentType);
        return;
      }
      
      // ★ 路由表驱动分发
      const routeKey = `${method} ${pathname}`;
      const handlers = this.getRouteTable();
      if (handlers[routeKey]) {
        this.stats.apiRequests++;
        await handlers[routeKey](req, res, url);
        return;
      }

      // 404 未找到
      this.sendJSON(res, 404, {
        error: 'Not Found',
        path: pathname,
        method,
        message: `请求的资源 ${pathname} 不存在`,
      });
      
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('COORDCLAW_NOT_INSTALLED')) {
        console.log('[Server] 🔧 coordclaw.json missing, switching to install mode');
        this.isInstallMode = true;
        res.writeHead(302, { 'Location': '/install.html' });
        res.end();
        return;
      }
      handleError(res, this.generateRequestId(), error);
    }
  }
  
  // ============ API 处理器 ============
  
  private async handleGetMessages(url: URL, res: ServerResponse): Promise<void> { await handleGetMessages(this.getContext(), url, res); }
  
  private handleGetMembers(res: ServerResponse): void { handleGetMembers(this.getContext(), res); }

  private handleGetUnreadCount(res: ServerResponse): void { handleGetUnreadCount(this.getContext(), res); }

  private handleGetMessageCount(res: ServerResponse): void { handleGetMessageCount(this.getContext(), res); }

  private handleGetMemberUnread(url: URL, res: ServerResponse): void { handleGetMemberUnread(this.getContext(), url, res); }

  private handleMarkRead(req: IncomingMessage, res: ServerResponse): void { handleMarkRead(this.getContext(), req, res); }
  private handleMarkAllRead(req: IncomingMessage, res: ServerResponse): void { handleMarkAllRead(this.getContext(), req, res); }
  private handleExportCSV(req: IncomingMessage, res: ServerResponse): void { handleExportCSV(this.getContext(), req, res); }
  private handleExportHTML(req: IncomingMessage, res: ServerResponse): void { handleExportHTML(this.getContext(), req, res); }

  /**
   * POST /api/send-message - 发送消息
   */
  private handleSendMessage(req: IncomingMessage, res: ServerResponse): void { handleSendMessage(this.getContext(), req, res); }

  /**
   * POST /api/toggle-read - 切换单条消息的已读/未读
   */
  private handleToggleRead(req: IncomingMessage, res: ServerResponse): void { handleToggleRead(this.getContext(), req, res); }

  /**
   * POST /api/workspace-reset - 团队重置：代理到 OpenClaw Gateway
   * 功能：清空所有成员的 session + workspace，重建 SOUL.md
   */
  private async handleWorkspaceReset(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleWorkspaceReset(this.getContext(), req, res); }

  /**
   * POST /api/create-project - 创建项目：代理到 CoordClaw Center
   */
  private async handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleCreateProject(this.getContext(), req, res); }

  /**
   * POST /api/delete-project - 删除项目：代理到 CoordClaw Center
   */
  private async handleDeleteProject(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleDeleteProject(this.getContext(), req, res); }

  /**
   * POST /api/delete-team - 删除团队：代理到 CoordClaw Center，成功后刷新缓存
   */
  private async handleDeleteTeam(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleDeleteTeam(this.getContext(), req, res); }

  /**
   * POST /api/rename-team - 重命名团队：直接写 coordclaw.json 并同步 team.json
   */
  private async handleRenameTeam(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleRenameTeam(this.getContext(), req, res); }
  private async handleRenameProject(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleRenameProject(this.getContext(), req, res); }

  /**
   * POST /api/start-team-monitor - 启动团队创建进度监控（SSE 推送）
   */
  private handleStartTeamMonitor(req: IncomingMessage, res: ServerResponse): void {
    handleStartTeamMonitor(req, res, this.teamMonitor, (e, d) => this.broadcastSSE(e, d));
  }

  /**
   * POST /api/stop-team-monitor - 停止团队创建进度监控
   */
  private handleStopTeamMonitor(_req: IncomingMessage, res: ServerResponse): void {
    handleStopTeamMonitor(_req, res, this.teamMonitor);
  }

  private openFolder(p: string): void { openFolder(p); }
  private openFile(p: string): void { openFile(p); }

  /** POST /api/open-folder */
  /**
   * GET /api/open-skill-dir?name=xxx — 打开技能目录
   */
  private handleOpenSkillDir(req: IncomingMessage, res: ServerResponse): void {
    handleOpenSkillDir(req, res, p => this.openFolder(p));
  }

  private handleOpenFolder(req: IncomingMessage, res: ServerResponse): void {
    handleOpenFolder(req, res);
  }

  /**
   * POST /api/open-dir — 打开项目目录
   * 参数: { projId }
   */
  private handleOpenDir(req: IncomingMessage, res: ServerResponse): void {
    handleOpenDir(req, res);
  }

  /**
   * POST /api/open-team-dir — 打开团队模板目录
   * 参数: { teamId }
   */
  private handleOpenTeamDir(req: IncomingMessage, res: ServerResponse): void {
    handleOpenTeamDir(req, res);
  }

  /**
   * POST /api/open-file — 打开项目下文件
   * 参数: { projId, subPath }
   */
  private handleOpenFile(req: IncomingMessage, res: ServerResponse): void {
    handleOpenFile(req, res);
  }

  /**
   * POST /api/open-teamsoul — 打开 teamsoul.md
   * 参数: { teamId }
   */
  private handleOpenTeamsoul(req: IncomingMessage, res: ServerResponse): void {
    handleOpenTeamsoul(req, res);
  }

  /**
   * POST /api/open-team-rule — 打开团队 RULE.md
   */
  private handleOpenTeamFile(req: IncomingMessage, res: ServerResponse, filename: string): void {
    handleOpenTeamFile(req, res, filename);
  }


  /**
   * GET /api/org-chart — 从 team.json 生成组织架构 HTML
   */
  private handleOrgChart(req: IncomingMessage, res: ServerResponse): void {
    handleOrgChart(this.config, req, res);
  }

  /**
   * GET /api/token-stats-detail — 从 token-stats.jsonl 聚合、按成员(sessionKey)匹配生成明细页
   */
  private handleTokenStatsDetail(req: IncomingMessage, res: ServerResponse): void {
    handleTokenStatsDetail(this.config, req, res);
  }

  /**
   * GET /api/member-status - 代理 Gateway session-snapshot
   */
  private async handleMemberStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> { await handleMemberStatus(this.getContext(), _req, res); }

  /**
   * POST /api/register-team
   * 响应前（串行，决定回包速度）：① team-create → ③ 删除日志
   * 响应后（fire-and-forget，不阻塞回包）：② session-reset → ④ cache-refresh → 软重启 Gateway
   */
  /**
   * 注册核心（供 /api/register-team 与 /api/import-team-tpkg 共用）
   * ① team-create → ③ 删除日志；响应后 fire-and-forget：② session-reset / ④ cache-refresh / 软重启 Gateway
   * teamId 由调用方显式传入（不再依赖 teamMonitor.teamPath，导入流程复用安全）
   * 仅当 team-create >= 400 时抛错；删日志为 best-effort，绝不向外抛
   */
  private async registerTeamCore(teamId: string): Promise<string[]> {
    const gatewayUrl = resolveGatewayUrl(this.config);
    if (!gatewayUrl) throw AppError.gateway('无法获取 OpenClaw Gateway 地址');

    const hdrs = { 'Content-Type': 'application/json' };
    const steps: string[] = [];
    const teamPath = join(getOpenClawUserDir(), 'coordclaw-teams', teamId);

    // ① team-create
    console.log(`[RegisterTeam] ① team-create: ${teamId}`);
    const createRes = await fetch(`${gatewayUrl}/coordclaw-plugin/coordclawcenter/team-create`, {
      method: 'POST', headers: hdrs, body: JSON.stringify({ teamId }),
    });
    const createBody = await createRes.text();
    steps.push(`team-create (${createRes.status})`);
    if (createRes.status >= 400) throw AppError.gateway(`team-create 失败: ${createBody}`);

    // ③ 删除 .createteamok.log 和 .monitoring.log（best-effort，绝不抛）
    try {
      const okFile = join(teamPath, '.createteamok.log');
      if (existsSync(okFile)) { unlinkSync(okFile); steps.push('deleted .createteamok.log'); }
      const mlFile = join(teamPath, '.monitoring.log');
      if (existsSync(mlFile)) { unlinkSync(mlFile); steps.push('deleted .monitoring.log'); }
    } catch (e) { console.error('[RegisterTeam] Failed to delete log (ignored):', e); }

    // ② session-reset（fire-and-forget，不阻塞响应）
    const sessionKey = 'agent:main:coordclawabcdefg';
    fetch(`${gatewayUrl}/coordclaw-plugin/coordclawcenter/session-reset`, {
      method: 'POST', headers: hdrs, body: JSON.stringify({ sessionKey }),
    }).then(() => console.log('[RegisterTeam] ② session-reset done'))
      .catch((e) => console.error('[RegisterTeam] ② session-reset failed:', e));

    // ④ cache-refresh（fire-and-forget，不阻塞响应）
    fetch(`${gatewayUrl}/coordclaw-plugin/coordclawcenter/cache-refresh`, {
      method: 'POST', headers: hdrs,
    }).then(() => console.log('[RegisterTeam] ④ cache-refresh done'))
      .catch((e) => console.error('[RegisterTeam] ④ cache-refresh failed:', e));

    // ★ 注册成功后软重启 Gateway（同样 fire-and-forget，不阻塞响应）
    this.restartGateway('soft');
    return steps;
  }

  private async handleRegisterTeam(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let teamId = '';
    try { const d = await parseBody(req); teamId = d.teamId || ''; } catch {}
    teamId = teamId || this.teamMonitor.teamPath.split(/[\\/]/).pop() || '';
    if (!teamId) throw AppError.badRequest('未找到待注册的团队 ID');
    try {
      const steps = await this.registerTeamCore(teamId);
      console.log(`[RegisterTeam] ✅ Core done, responded to frontend: ${steps.join(' → ')}`);
      this.sendJSON(res, 200, { success: true, steps });
    } catch (error) {
      console.error('[RegisterTeam] ❌ Failed:', error);
      if (error instanceof AppError) throw error;
      throw AppError.gateway('注册团队失败', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * GET /api/browse-file — 打开系统文件选择框选 .tpkg（复用 browse-folder.py file 模式）
   */
  private handleBrowseFile(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const title = url.searchParams.get('title') || '选择团队包';
    const path = browseFolder(title, 'file');
    this.sendJSON(res, 200, { path: path || null });
  }

  /**
   * POST /api/import-team-tpkg — 导入 .tpkg 团队包
   * 流程：校验路径 → 读盘校验(PK头/大小) → Python zipfile 解压到临时目录(防 zip-slip/symlink)
   *       → 唯一顶层目录=teamId(校验命名) → 重名双查 → .createteamok.log 校验
   *       → 复制到 coordclaw-teams/<teamId>/ → 复用 registerTeamCore 注册
   *       → 注册失败删目录，保持 coordclaw.json 干净
   */
  private async handleImportTeamTpkg(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const MAX_FILE = 50 * 1024 * 1024;
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    const extractScript = join(__dirname, '..', 'scripts', 'extract-tpkg.py');
    let tmpDir = '';
    try {
      const body = await parseBody(req);
      const pkgPath = (body.path || '').trim();
      if (!pkgPath) throw AppError.badRequest('import_no_path');
      if (!pkgPath.toLowerCase().endsWith('.tpkg')) throw AppError.badRequest('import_not_tpkg');
      if (!existsSync(pkgPath)) throw AppError.notFound('import_file_not_found', [pkgPath]);

      const buf = readFileSync(pkgPath);
      if (buf.length === 0) throw AppError.badRequest('import_file_empty');
      if (buf.length > MAX_FILE) throw AppError.badRequest('import_too_large');
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw AppError.badRequest('import_invalid_pk');

      // 解压到临时目录（Python 标准库 zipfile，跨平台、零依赖）
      tmpDir = mkdtempSync(join(tmpdir(), 'coordclaw-tpkg-'));
      const result = spawnSync(pythonPath, [extractScript, pkgPath, tmpDir], { encoding: 'utf-8', timeout: 120000 });
      if (result.error) throw AppError.fileError('import_extract_failed', result.error.message);
      let parsed: any;
      try { parsed = JSON.parse((result.stdout || '').trim()); }
      catch { throw AppError.badRequest('import_extract_script_error', undefined, [((result.stdout || result.stderr || '').slice(0, 200))]); }
      if (!parsed.ok) throw AppError.badRequest('import_extract_error', undefined, [parsed.error || '未知错误']);

      // 顶层须恰好一个目录
      const topEntries = (parsed.topEntries || []).filter((n: string) => {
        try { return statSync(join(tmpDir, n)).isDirectory(); } catch { return false; }
      });
      if (topEntries.length !== 1) throw AppError.badRequest('import_invalid_structure');
      const teamId = topEntries[0];
      if (!isValidTeamName(teamId)) throw AppError.badRequest('import_invalid_team_name');
      if (!/^[A-Za-z][\w-]*$/.test(teamId)) throw AppError.badRequest('import_invalid_team_name_format');

      const teamsDir = join(getOpenClawUserDir(), 'coordclaw-teams');
      if (existsSync(join(teamsDir, teamId))) throw AppError.badRequest('import_team_exists', undefined, [teamId]);
      const cfg: any = readCoordClawJson();
      if (cfg.teams && cfg.teams.some((t: any) => t.id === teamId)) throw AppError.badRequest('import_team_exists_index', undefined, [teamId]);

      // 导入端要求包内含 .createteamok.log（团队创建完成的标记）；缺失即视为配置文件无效。
      // 这里返回 i18n key（alert_invalid_team_package），由前端 I18N.t 翻译，避免把内部文件名甩给用户。
      if (!existsSync(join(tmpDir, teamId, '.createteamok.log'))) throw AppError.badRequest('alert_invalid_team_package');

      cpSync(join(tmpDir, teamId), join(teamsDir, teamId), { recursive: true });

      try {
        const steps = await this.registerTeamCore(teamId);
        console.log(`[ImportTeam] ✅ Import complete: ${teamId} (${steps.join(' → ')})`);
        this.sendJSON(res, 200, { success: true, teamId, steps });
      } catch (regErr) {
        // 注册失败：删目录，保持 coordclaw.json 干净（registerTeamCore 仅在 team-create>=400 抛错，coordclaw.json 不会被写）
        try { rmSync(join(teamsDir, teamId), { recursive: true, force: true }); } catch {}
        throw regErr;
      }
    } catch (error) {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
      if (error instanceof AppError) {
        // 业务校验失败（4xx）属正常前置条件冲突，按 warn 记录；服务端错误（5xx）才按 error 记录
        const isServerErr = error.statusCode >= 500;
        const tag = isServerErr ? '❌' : '⚠️';
        if (isServerErr) {
          console.error(`[ImportTeam] ${tag} ${error.code}:`, error.message, error.details || '');
        } else {
          console.warn(`[ImportTeam] ${tag} ${error.code}:`, error.message, error.details || '');
        }
        throw error;
      }
      console.error('[ImportTeam] ❌ Failed:', error);
      throw AppError.badRequest('import_unexpected', undefined, [error instanceof Error ? error.message : String(error)]);
    }
  }

  /**
   * POST /api/export-team-tpkg — 导出团队为 .tpkg 包
   * 流程：teamId 校验 → 路径穿越防护 → 团队存在校验 → 拒绝正在创建中的团队
   *       → 缺 .createteamok.log 则临时生成（仅自创）→ 校验 teamsoul.md → 体积上限 → Python 打包
   *       → Content-Disposition 投递 → finally 清标记与临时文件
   * 注意：所有 AppError 必须在 res.writeHead(200,...) 之前抛出，错误经全局 JSON 处理器返回；
   *       否则触发下载会把下面的错误 JSON 当文件下载。
   */
  private async handleExportTeamTpkg(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const MAX_FILE = 50 * 1024 * 1024;
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    const packageScript = join(__dirname, '..', 'scripts', 'package-tpkg.py');
    let tmpDir = '';
    let teamPath = '';
    try {
      const body = await parseBody(req);
      const teamId = (body.teamId || '').trim();
      if (!teamId) throw AppError.badRequest('未提供 teamId');
      if (!isValidTeamName(teamId)) throw AppError.badRequest('团队 ID 非法（禁止 / \\ ..）');
      if (!/^[A-Za-z][\w-]*$/.test(teamId)) throw AppError.badRequest('团队 ID 格式非法（须以字母开头，仅含字母/数字/-/_）');

      // 权威定位：团队文件夹记录在 coordclaw.json 的 teams[].templatePath（兼容 ~ 与绝对路径）
      // 不得写死为 coordclaw-teams/<teamId>，否则模板类团队（如 teamstemplate/ 下）会被判不存在
      const resolvedTpl = resolveTeamTemplatePath(teamId);
      if (!resolvedTpl) throw AppError.notFound('团队不存在（未注册）：' + teamId);
      teamPath = resolve(resolvedTpl);
      if (!existsSync(teamPath) || !statSync(teamPath).isDirectory()) throw AppError.notFound('团队文件夹不存在：' + teamPath);
      // 窄边守卫：正在创建中的团队（含 .monitoring.log）不可导出，避免误触 monitor 阶段
      if (existsSync(join(teamPath, '.monitoring.log'))) throw AppError.badRequest('团队正在创建中，暂不可导出');

      // 导入端要求包内含 .createteamok.log；源文件夹可能缺失，也可能为只读模板目录
      // → 标记只注入包内（package-tpkg.py --marker），绝不写入/改动源文件夹
      const needMarker = !existsSync(join(teamPath, '.createteamok.log'));

      // 导出单边约束：缺 teamsoul.md 直接报错（真实位置为 .data/teamsoul.md，import 不强制，属已知不对称）
      if (!existsSync(join(teamPath, '.data', TEAMSOUL_FILENAME))) throw AppError.badRequest('团队缺少 ' + TEAMSOUL_FILENAME + '，无法导出为可导入的 .tpkg');

      // 体积上限（整文件夹，不跳过任何文件），与 import 对称
      let total = 0;
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir)) {
          const p = join(dir, e);
          const st = statSync(p);
          if (st.isDirectory()) { walk(p); continue; }
          total += st.size;
        }
      };
      walk(teamPath);
      if (total > MAX_FILE) throw AppError.badRequest('团队配置过大（超过 50MB），无法导出');

      // Python 打包（镜像 extract-tpkg.py 安全 idiom，零 npm 依赖、跨平台）
      tmpDir = mkdtempSync(join(tmpdir(), 'coordclaw-tpkgexp-'));
      const outPkg = join(tmpDir, teamId + '.tpkg');
      const pyArgs = [packageScript, teamPath, outPkg];
      if (needMarker) pyArgs.push('--marker');
      const result = spawnSync(pythonPath, pyArgs, { encoding: 'utf-8', timeout: 120000 });
      if (result.error) throw AppError.fileError('打包失败（Python 调用错误）', result.error.message);
      let parsed: any;
      try { parsed = JSON.parse((result.stdout || '').trim()); }
      catch { throw AppError.badRequest('打包脚本返回异常：' + ((result.stdout || result.stderr || '').slice(0, 200))); }
      if (!parsed.ok) throw AppError.badRequest(parsed.error || '打包失败');
      if (!existsSync(outPkg)) throw AppError.badRequest('打包产物缺失');

      const buf = readFileSync(outPkg);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + teamId + '.tpkg"',
      });
      res.end(buf);
    } catch (error) {
      console.error('[ExportTeam] ❌ Failed:', error);
      if (error instanceof AppError) throw error;
      throw AppError.badRequest('导出团队失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    }
  }

  private stopTeamMonitor(): void {
    if (this.teamMonitor.interval) {
      clearInterval(this.teamMonitor.interval);
      this.teamMonitor.interval = null;
      this.teamMonitor.teamPath = '';
    }
  }

  /**
   * 重启 Gateway 进程
   * @param mode 'soft' 用 SIGUSR1（等活跃任务排空）| 'hard' 用 SIGTERM（立刻）
   */
  async restartGateway(mode: 'soft' | 'hard'): Promise<{ success: boolean; message: string }> {
    const pid = readGatewayPid();
    if (!pid) return { success: false, message: '未找到 gatewayPid' };
    const isWin = process.platform === 'win32';
    const signal = mode === 'hard' ? 'SIGTERM' : 'SIGHUP';  // O1: SIGHUP 替代 SIGUSR1（避免被 Node.js inspector 截获）
    const cmd = isWin
      ? `taskkill /PID ${pid}` + (mode === 'hard' ? ' /F' : '')
      : `node -e "try{process.kill(${pid},'${signal}')}catch(e){console.error(e.message);process.exitCode=1}"`;
    const { exec } = await import('node:child_process');
    return new Promise((resolve) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error && !isWin) {
          console.error(`[Gateway] Restart failed (${mode}):`, stderr || error.message);
          resolve({ success: false, message: `重启失败: ${stderr || error.message}` });
        } else {
          console.log(`[Gateway] ${mode === 'hard' ? 'Hard' : 'Soft'} restart signal sent (PID=${pid})`);
          resolve({ success: true, message: '重启信号已发送' });
        }
      });
    });
  }

  // ============ team.json 读写辅助方法 ============

  /**
   * 读取 team.json
   */
  private readTeamJson(): any {
    return readTeamJsonFromLib(this.config.projectRoot);
  }

  private writeTeamJson(data: any): void {
    writeTeamJsonFromLib(this.config.projectRoot, data);
  }

  // ============ 切换人类用户启用状态 ============

  /**
   * POST /api/toggle-human - 切换人类用户启用状态
   * 读取 team.json → 切换 humanmember.enabled → 写回
   */
  private async handleToggleHuman(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    handleToggleHuman(this.getContext(), req, res, body);
  }

  // ============ 切换消息路由启用状态 ============

  /**
   * POST /api/toggle-auto-coordination - 切换自动协同开关
   */
  private handleToggleAutoCoordination(_req: IncomingMessage, res: ServerResponse): void { handleToggleAutoCoordination(this.getContext(), _req, res); }

  /**
   * POST /api/toggle-msg-robot - 切换消息路由启用状态
   * msg_robot 是布尔值，直接翻转 true ↔ false
   * 切换后调用 Gateway cache-refresh 接口刷新缓存
   */
  private handleToggleMsgRobot(_req: IncomingMessage, res: ServerResponse): void { handleToggleMsgRobot(this.getContext(), _req, res); }

  /**
   * POST /api/restart-gateway
   * Body: { mode?: 'soft' | 'hard' }  默认 soft（SIGUSR1）
   */
  private async handleRestartGateway(req: IncomingMessage, res: ServerResponse): Promise<void> { await handleRestartGateway(req, res, (mode) => this.restartGateway(mode)); }

  private handleSSEStream(_req: IncomingMessage, res: ServerResponse): void { handleSSEStream(this.getContext(), _req, res); }

  /** 确保 Gateway SSE 成员状态流已订阅 */
  private ensureMemberStatusStream(): void { ensureMemberStatusStream(this.getContext()); }
  
  private handleHealthCheck(res: ServerResponse): void { handleHealthCheck(this.getContext(), res); }

  /** 项目切换公共方法：DB 重连 + 广播 + 通知前端刷新 */
  private notifyProjectSwitched(newConfig: ControlPanelConfig): void {
    this.config = newConfig;
    this.restartTeamJsonWatcher();
    const newDbPath = resolveDatabasePath(newConfig.projectRoot);
    this.db.reconnect(newDbPath);
    this.broadcastSSE('project_switched', {
      projectRoot: newConfig.projectRoot,
      projectName: newConfig.projectName,
      teamName: newConfig.teamName,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Server] 🔄 Project switched: ${newConfig.projectName} (${newConfig.projectRoot})`);
  }

  /** 无参版本：用于 ctx（使用当前 this.config） */
  private notifyProjectSwitchedAuto(): void {
    this.notifyProjectSwitched(this.config);
  }

  private handleGetConfig(res: ServerResponse): void {
    const config = getConfig(true);

    if (config.projectRoot && config.projectRoot !== this.config.projectRoot && !this._switchingProject) {
      this._switchingProject = true;
      try {
        console.log(`[Server] 🔄 Detected projectRoot change, auto-switching...`);
        console.log(`   ${this.config.projectRoot} → ${config.projectRoot}`);
        this.notifyProjectSwitched(config);
      } finally {
        this._switchingProject = false;
      }
    }

    // 返回部分配置信息（隐藏敏感字段如 authToken）
    const safeConfig = {
      service: 'CoordClaw Control Panel',
      version: config.version || '0.0.0',
      currentUser: config.currentUser,
      currentUserId: config.currentUserId,
      members: config.members,
      humanMember: config.humanMember,
      teamName: config.teamName,
      msgRobot: config.msgRobot,
      autoCoordination: config.autoCoordination,
      corsOrigin: config.corsOrigin,
      demo_mode: false,
      gatewayUrl: resolveGatewayUrl(this.config) || '',
      webchatUrl: resolveWebchatUrl() || '',
      projectName: config.projectName,
      projectRoot: config.projectRoot,
      estTotalTokens: config.estTotalTokens || 0,
      language: config.language || 'zh',
      startupStatus: config.startupStatus || 'ok',
    };

    this.sendJSON(res, 200, safeConfig);
  }

  private handleUpdateInfo(res: ServerResponse): void {
    const info = getUpdateInfo();
    this.sendJSON(res, 200, info || {});
  }

  /** 更新 coordclaw.json 中的 language 等简单字段 */
  private async handlePostConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await parseBody(req);
      const coordclaw = readCoordClawJson();
      if (body.language) coordclaw.language = body.language;
      writeCoordClawJson(coordclaw);
      this.sendJSON(res, 200, { success: true, language: body.language });
    } catch (e: any) {
      throw AppError.badRequest(e.message || '更新配置失败');
    }
  }

  /**
   * GET /api/projects - 获取所有团队的项目列表（用于切换）
   */
  /**
   * GET /api/browse-folder - 打开系统文件夹选择对话框（跨平台，使用 Python tkinter）
   */
  /**
   * 扫描所有 extraDirs 收集技能名 → 源目录映射（启动时加载，手动刷新）
   */
  private scanAllSkills(): Record<string, { path: string; desc: string }> { return scanAllSkills(); }

  private handleRefreshSkills(_req: IncomingMessage, res: ServerResponse) { handleRefreshSkills(_req, res).catch(e => console.error('[Skills] refresh error:', e)); }

  private handleSkills(req: IncomingMessage, res: ServerResponse) { handleSkills(req, res).catch(e => console.error('[Skills] list error:', e)); }

  private handleToggleSkill(req: IncomingMessage, res: ServerResponse) { handleToggleSkill(req, res).catch(e => console.error('[Skills] toggle error:', e)); }

  private getMemberSkills(req: IncomingMessage, res: ServerResponse) { getMemberSkills(req, res).catch(e => console.error('[Skills] member error:', e)); }

  /**
   * PUT /api/member-skills — 更新成员 skills 数组
   */
  private updateMemberSkills(req: IncomingMessage, res: ServerResponse) { updateMemberSkills(req, res).catch(e => console.error('[Skills] update error:', e)); }

  private handleInstallSkill(req: IncomingMessage, res: ServerResponse) { handleInstallSkill(req, res); }

  /**
   * GET /api/models — 获取可用模型列表
   */
  private handleGetModels(_req: IncomingMessage, res: ServerResponse) { handleModels(_req, res).catch(e => console.error('[Models] list error:', e)); }

  /**
   * POST /api/model-config — 设置全局模型
   */
  private handleSetModel(req: IncomingMessage, res: ServerResponse) { handleSetModel(req, res).catch(e => console.error('[Models] set error:', e)); }

  /**
   * POST /api/restore-database — 从备份恢复数据库
   */
  private handleRestoreDatabase(_req: IncomingMessage, res: ServerResponse) {
    const ok = this.db.restoreFromBackup();
    if (ok) {
      this.broadcastSSE('database_restored', { success: true });
      sendJSON(res, 200, { success: true });
    } else {
      sendJSON(res, 500, { success: false, error: '恢复失败' });
    }
  }

  /** GET /api/database-status */
  private handleGetDatabaseStatus(res: ServerResponse) {
    sendJSON(res, 200, {
      corrupted: this.db.isCorrupted,
      backupAvailable: this.db.backupAvailable,
      backupCorrupt: this.db.backupCorrupt,
      restoring: this.db.isRestoring,
    });
  }

  /**
   * ★ 公共方法：打开系统文件夹选择对话框，返回路径或空字符串
   */
  browseFolder(title = '选择文件夹'): string { return browseFolder(title); }

  private handleBrowseFolder(req: IncomingMessage, res: ServerResponse): void {
    handleBrowseFolder(req, res);
  }

  private handleGetProjects(res: ServerResponse): void { handleGetProjects(res); }

  /**
   * POST /api/switch-project - 切换激活项目
   * 请求体: { projectId: "coordclawproject_0002" }
   */
  private handleSwitchProject(req: IncomingMessage, res: ServerResponse): void { handleSwitchProject(this.getContext(), req, res); }

  /**
   * 关闭所有 SSE 连接（项目切换时使用，不清空集合以便重连检测）
   */
  private closeAllSSEConnectionsForSwitch(): void { closeAllSSEConnectionsForSwitch(this.sseClients); }

  // ============ 安装模式退出 ============

  private tryExitInstallMode(res: ServerResponse): void {
    // ① 网关：唯一裁决成功/失败；失败不动状态、可重试
    let config;
    try {
      config = ConfigResolver.getInstance().resolve(true);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      sendJSON(res, 200, { success: false, message: '配置尚未就绪: ' + reason });
      return;
    }
    this.config = config;
    // ② 接线：best-effort，任何辅助异常只告警、不阻断进入、不污染状态
    this.wireRuntimeBestEffort(config);
    // ③ 接线全绿后才退出安装模式并承诺成功
    this.isInstallMode = false;
    console.log('[Server] ✅ Installation complete, exiting install mode');
    sendJSON(res, 200, { success: true });
  }

  /** 运行期接线容错原语：复用 self-heal / tracker 既有 try/catch 包容约定 */
  private safe(label: string, fn: () => void): void {
    try { fn(); } catch (e) { console.warn(`[init] ${label} skipped:`, e instanceof Error ? e.message : String(e)); }
  }

  /** 进入时运行期接线（监听/技能扫描/库重连），任一失败仅告警，绝不回滚安装状态 */
  private wireRuntimeBestEffort(config: any): void {
    this.safe('db.reconnect', () => { if (config.databasePath) this.db.reconnect(config.databasePath); });
    this.safe('registerPidMeta', () => this.registerPidMeta(config.port));
    this.safe('setupJsonWatchers', () => this.setupJsonWatchers());
    this.safe('scanAllSkills', () => this.scanAllSkills());
  }

  // ============ 静态文件服务 ============
  
  private serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
    serveStaticFile(res, filePath, contentType);
  }
  
  // ============ 辅助方法 ============
  
  private setCommonHeaders(res: ServerResponse): void {
    setCommonHeaders(res, this.config.corsOrigin);
  }
  
  private handlePreflight(res: ServerResponse): void {
    handlePreflight(res);
  }
  
  private sendJSON(res: ServerResponse, statusCode: number, data: any): void {
    sendJSON(res, statusCode, data);
  }
  
  private getContentType(pathname: string): string {
    return getContentType(pathname);
  }
  
  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * ★ 将成员姓名解析为 agent_id（用于 ID 精确匹配，杜绝编码问题）
   */
  private resolveMemberId(name: string): string {
    const member = this.config.members.find(m => m.name === name);
    return member?.agent_id || '';
  }

  /**
   * ★ 解析 sender_id（同时支持团队成员 agent_id 和 humanMember 的 human_id）
   */
  private resolveSenderId(name: string): string {
    // 先查团队成员
    const member = this.config.members.find(m => m.name === name);
    if (member?.agent_id) return member.agent_id;
    // 再查 humanMember（数组）
    const human = this.config.humanMember?.find(h => h.name === name);
    if (human?.human_id) return human.human_id;
    return '';
  }
  
  /**
   * 广播SSE事件给所有连接的客户端
   */
  private broadcastSSE(event: string, data: any): void { broadcastSSE(this.sseClients, event, data); }
  
  /**
   * ★ 监听 team.json 和 coordclaw.json 变化，外部工具修改后可实时推送
   */
  private setupJsonWatchers(): void {
    this.setupTeamJsonWatcherInternal();
    this.setupCoordClawJsonWatcher();
    this.setupOpenClawJsonWatcher();
  }

  /** ★ 监听 openclaw.json 变更 → 推送模型列表刷新 */
  private setupOpenClawJsonWatcher(): void {
    const openClawJsonPath = join(getOpenClawUserDir(), OPENCLAW_JSON_FILENAME);
    if (!existsSync(openClawJsonPath)) return;
    try {
      let debounce: NodeJS.Timeout | null = null;
      watch(openClawJsonPath, (eventType) => {
        if (eventType !== 'change') return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log('[OpenClawWatcher] 🔔 Model config changed');
          this.broadcastSSE('models_changed', { timestamp: new Date().toISOString() });
          debounce = null;
        }, 300);
      });
      console.log(`[OpenClawWatcher] 📁 Watching openclaw.json`);
    } catch (e: any) { console.warn('[OpenClawWatcher] ⚠️ Watch failed:', e.message); }
  }

  private setupCoordClawJsonWatcher(): void {
    const coordClawPath = resolveCoordClawJsonPath();
    const watchPaths = [COORDCLAW_CONFIG_PATH, coordClawPath];
    let debounceTimer: NodeJS.Timeout | null = null;
    for (const jsonPath of watchPaths) {
      if (!existsSync(jsonPath)) { console.warn(`[ConfigWatcher] ⚠️ File does not exist: ${jsonPath}`); continue; }
      try {
        watch(jsonPath, (eventType) => {
          if (eventType !== 'change') return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            console.log(`[ConfigWatcher] 🔔 ${jsonPath.split(/[\\/]/).pop()} changed`);
            if (jsonPath === coordClawPath && !existsSync(coordClawPath)) {
              console.log('[ConfigWatcher] 🔧 coordclaw.json lost, switching to install mode');
              this.isInstallMode = true;
            }
            clearCoordClawCache();
            this.broadcastSSE('config_changed', { source: 'config', timestamp: new Date().toISOString() });
            debounceTimer = null;
          }, 300);
        });
        console.log(`[ConfigWatcher] 📁 Watching ${jsonPath.split(/[\\/]/).pop()}`);
      } catch (e) { console.warn(`[ConfigWatcher] ⚠️ Watch failed: ${jsonPath}`, e); }
    }
  }
  private setupTeamJsonWatcherInternal(): void {
    const teamJsonPath = resolveTeamJsonPath(this.config.projectRoot);

    if (!existsSync(teamJsonPath)) {
      console.warn('[TeamWatcher] ⚠️ team.json does not exist, skipping file watch:', teamJsonPath);
      return;
    }

    try {
      let debounceTimer: NodeJS.Timeout | null = null;

      this.teamJsonWatcher = watch(teamJsonPath, (eventType) => {
        if (eventType !== 'change') return;

        // 防抖：短时间内多次变化合并为一次推送
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`[TeamWatcher] 🔔 Detected team.json change (${new Date().toLocaleTimeString()})`);

          // 清除 ConfigResolver 缓存，确保下次读取最新数据
          ConfigResolver.getInstance().clearCache();

          // 广播 team_changed 给 SSE 客户端（轻量刷新：成员+开关+消息）
          this.broadcastSSE('team_changed', {
            timestamp: new Date().toISOString(),
          });

          debounceTimer = null;
        }, 300); // 300ms 防抖
      });

      this.teamJsonWatcher.on('error', (err) => {
        console.warn('[TeamWatcher] ⚠️ File watch error:', err.message);
        this.teamJsonWatcher?.close();
        setTimeout(() => this.restartTeamJsonWatcher(), 1000);
      });

      console.log(`[TeamWatcher] 📁 Enabled team.json file watch: ${teamJsonPath}`);
    } catch (error) {
      console.warn('[TeamWatcher] ⚠️ Failed to start team.json watch:', error);
    }
  }

  /**
   * 重启 team.json 文件监听（用于项目切换后指向新项目的 team.json）
   */
  private restartTeamJsonWatcher(): void {
    if (this.teamJsonWatcher) {
      this.teamJsonWatcher.close();
      this.teamJsonWatcher = null;
    }
    this.setupJsonWatchers();
  }

  private closeAllSSEConnections(): void { closeAllSSEConnections(this.sseClients); }
  
  // ============ 日志输出 ============

  private printStartupBanner(url: string): void {
    // 横幅框统一用 drawBox 绘制：最长文本决定内宽 + 富余，永不错位（displayWidth 见 term-box.ts）
    // 横幅按 coordclaw.json 语言本地化（首装无文件时由 skipConfig 的 resolveDefaultLanguage 猜测）
    const D = normalizeLanguage(this.config.language) === 'en' ? en : zh;
    const rows: Array<string | { sep: true }> = [
      `  🎛️  ${D.banner_title}`,
      { sep: true },
      `📍 ${D.banner_address}:   ${url}`,
      `📊 ${D.banner_panel}:   ${url}/`,
      `🔧 ${D.banner_install_manage}: ${url}/install.html`,
      `📡 API:    ${url}/api/messages`,
      `🔄 SSE:    ${url}/api/sse-stream`,
      `❤️  ${D.banner_health}:   ${url}/api/health`,
      { sep: true },
      `💾 ${D.banner_database}: ${this.config.databasePath}`,
      `🔗 ${D.banner_gateway}: ${resolveGatewayUrl(this.config) || D.banner_connecting}`,
      `👤 ${D.banner_current_user}: ${this.config.currentUser || D.banner_not_set}`,
    ];
    drawBox(rows).forEach((line) => console.log(line));
    console.log('');
  }
  
  private printShutdownStats(): void {
    const uptime = this.stats.startTime
      ? Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000)
      : 0;
    
    console.log('');
    console.log('[Server] 📊 Service stats:');
    console.log(`   ⏱️  Uptime: ${uptime} sec (${Math.floor(uptime / 60)} min)`);
    console.log(`   📨 Total requests: ${this.stats.totalRequests}`);
    console.log(`   🔌 API requests: ${this.stats.apiRequests}`);
    console.log(`   📡 SSE connections: ${this.stats.sseConnections}`);
    console.log('[Server] ✅ Control panel fully stopped');
    console.log('');
  }
}
