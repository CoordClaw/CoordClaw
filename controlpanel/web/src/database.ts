/**
 * 数据库访问层 - CoordClaw 消息数据库
 * 
 * 功能：
 * 1. 连接 SQLite 数据库（路径动态配置）
 * 2. 提供消息/成员查询接口（ID 匹配，编码安全）
 * 3. 支持已读状态管理
 * 4. 为 SSE 推送提供新消息检测
 */

import { DatabaseSync } from 'node:sqlite';  // F4: 静态导入，依赖 Node≥22（package.json engines 已强制）
import * as nodeSqlite from 'node:sqlite';      // 模块级 backup() 函数（Node 22+，@types/node 可能未声明，运行时存在）
import { existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDatabasePath, getConfig, type ControlPanelConfig } from './config-resolver.js';
import { DatabaseChangeMonitor } from './lib/database-change-monitor.js';
import { buildExportHTML, buildMembers } from './lib/htmlExport.js';

// ============ 类型定义 ============

export interface MessageRecord {
  id: number;
  msg_id?: string;
  conversation_id?: number;
  role: string;           // 'user' | 'assistant' | 'system' | 'tool'
  content: string;
  created_at: string;
  created_date?: string;   // YYYY-MM-DD 格式，供前端日期分隔线
  from_name?: string;
  from_id?: string;
  recipient?: string;
  recipient_id?: string;
  read_by?: string[];
  is_unread?: boolean;    // ★ 后端计算的未读状态
  view_count?: number;    // ★ 消息被查阅次数（来自 message_views 表）
}

export interface MemberRecord {
  name: string;
  agent_id?: string;
  unread_count: number;
  role?: string;
  last_active?: string;
  sessionKey?: string;
}

export interface MessagesResult {
  messages: MessageRecord[];
  count: number;
  total?: number;        // 总数（用于分页）
  firstMessageAt?: string | null;  // 当前筛选下首条消息时间（MIN(created_at)）
}

export interface MarkReadResult {
  success: boolean;
  marked_count: number;
  error?: string;
}

export interface SendMessageResult {
  success: boolean;
  message_id?: number;
  msg_id?: string;
  message?: any;         // 完整消息对象（前端直接追加用）
  error?: string;
}

export interface ToggleReadResult {
  success: boolean;
  is_read: boolean;      // 操作后状态：true=已读, false=未读
  error?: string;
}

// ============ 数据库类 ============


export class MessageDatabase {
  private db: DatabaseSync | null = null;
  private dbPath: string;
  private isConnected: boolean = false;
  private currentUser: string;
  private currentUserId: string;
  private members: Array<{ agent_id: string; name: string; sessionKey?: string }>;
  private humanMembers: any[] = [];
  private monitor: DatabaseChangeMonitor | null = null;
  private lastBackupAt: number = 0;
  private backupChain: Promise<void> = Promise.resolve(); // 串行化备份，避免并发争抢 .tmp
  public backupAvailable: boolean = false;
  public backupCorrupt: boolean = false;   // 备份本身也已损坏
  public isCorrupted: boolean = false;
  public isRestoring: boolean = false;     // 正在恢复中（防重复确认/幂等）
  public onCorruption?: () => void;        // 损坏时回调 → SSE 广播

  constructor(dbPath?: string) {
    // 容错：首装 / 未配置 coordclaw.json 时 getDatabasePath() 会抛 COORDCLAW_NOT_INSTALLED。
    // MessageDatabase 只是方法容器，未 connect 前不依赖路径，给空串即可，避免构造即抛导致
    // server 被迫退化为「缺方法的桩对象」（首装退出安装模式后 getMembers is not a function 根因）。
    try {
      this.dbPath = dbPath || getDatabasePath();
    } catch {
      this.dbPath = '';
    }
    let config: ControlPanelConfig;
    try {
      config = getConfig();
    } catch {
      config = {} as ControlPanelConfig;
    }
    this.currentUser = config.currentUser;
    this.currentUserId = config.currentUserId;
    this.members = config.members;
    this.humanMembers = (config.humanMember || []) as any[];
    // 初始化中心变更监测器，并订阅备份动作（备份自节流 ≥30s）
    this.monitor = new DatabaseChangeMonitor(this, { pollIntervalMs: 45_000, debounceMs: 300 });
    this.monitor.subscribe(() => this.onDatabaseChanged());
  }

  /** 轻型完整性校验：PRAGMA integrity_check 包装（小库全量，大库可换 quick_check）
   *  @param dbh 要校验的 DatabaseSync 句柄；若为 null 则读 .backup 校验 */
  private quickCheck(dbh?: DatabaseSync | null): boolean {
    try {
      if (dbh) {
        const r = dbh.prepare('PRAGMA integrity_check').get() as any;
        return r?.integrity_check === 'ok';
      }
      // 校验 .backup 文件：打开独立短暂连接
      const backupPath = this.dbPath + '.backup';
      if (!existsSync(backupPath)) return false;
      const tmpDb = new DatabaseSync(backupPath, { readonly: true });
      try {
        const r = tmpDb.prepare('PRAGMA integrity_check').get() as any;
        return r?.integrity_check === 'ok';
      } finally {
        tmpDb.close();
      }
    } catch {
      // 保守：报异常不判定损坏（防误报），跳过本次操作
      return false;
    }
  }

  /** 集中处理数据库损坏：标志+校验备份+广播 */
  private handleCorruption(): void {
    if (this.isCorrupted) return; // 避免重复
    this.isCorrupted = true;
    this.backupAvailable = existsSync(this.dbPath + '.backup');
    this.backupCorrupt = this.backupAvailable && !this.quickCheck();
    console.error(`[Database] 🔴 Database corrupted | backup available: ${this.backupAvailable} | backup also corrupted: ${this.backupCorrupt}`);
    this.onCorruption?.();
  }

  /**
   * 连接数据库（带重试机制）
   */
  connect(): void {
    if (this.isConnected && this.db) {
      return;
    }
    
    const maxRetries = 3;
    const retryDelayMs = 1000; // 1秒
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Database] 🔌 Connecting to database... (attempt  ${attempt}/${maxRetries})`);
        console.log(`[Database] 📂 Path: ${this.dbPath}`);
        
        // 检查文件是否存在
        if (!existsSync(this.dbPath)) {
          throw new Error(`数据库文件不存在: ${this.dbPath}`);
        }
        
        // 创建数据库连接（只读为主，避免与QClaw冲突；写入用临时连接）
        let connectionSuccess = false;
        
        // 策略1: 只读模式（避免与QClaw数据库锁冲突）
        try {
          console.log('[Database]   Trying read-only mode...');
          this.db = new DatabaseSync(this.dbPath, { readonly: true });
          connectionSuccess = true;
          console.log('[Database]   ✅ Read-only connection succeeded (writes will use a temp connection)');
        } catch (readonlyError: any) {
          console.warn(`[Database]   ⚠️ Read-only mode failed (${readonlyError.message})`);
          
          // 策略2: 尝试读写模式
          try {
            console.log('[Database]   Trying read-write mode...');
            this.db = new DatabaseSync(this.dbPath);
            connectionSuccess = true;
            console.log('[Database]   ✅ Read-write connection succeeded');
          } catch (readwriteError: any) {
            console.error(`[Database]   ❌ Read-write mode also failed`);
            throw readwriteError;
          }
        }
        
        if (!connectionSuccess) {
          throw new Error('无法建立数据库连接');
        }
        
        // 配置 SQLite 优化参数（逐步执行，捕获单个失败）
        this.executePragmaSafely('PRAGMA busy_timeout = 10000');  // 10秒忙等待
        
        // 尝试设置WAL模式（如果失败则使用默认的delete模式）
        try {
          this.db!.exec('PRAGMA journal_mode = WAL');
          console.log('[Database]   ✅ WAL mode enabled');
        } catch (walError: any) {
          console.warn(`[Database]   ⚠️ WAL mode setup failed (${walError.message}), using default mode`);
        }
        
        this.executePragmaSafely('PRAGMA foreign_keys = ON');
        this.executePragmaSafely('PRAGMA cache_size = -65536');

        // 检测并记录数据库编码（仅用于调试）
        try {
          const encodingResult = this.db!.prepare('PRAGMA encoding').get() as any;
          console.log(`[Database]   📝 Database encoding: ${encodingResult?.encoding || 'unknown'}`);
        } catch (e) {
          console.warn('[Database]   ⚠️ Cannot detect database encoding');
        }

        this.isConnected = true;

        // 合并 WAL 确保读取最新数据
        try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* ignore */ }

        // ★ 连通性校验：打开成功 ≠ 数据完好，快速做一次完整性检查
        if (!this.quickCheck(this.db)) {
          console.error('[Database] 🔴 Connection succeeded but integrity check failed (soft corruption), marked as corrupted');
          try { this.db.close(); } catch (_) {}
          this.db = null;
          this.isConnected = false;
          this.handleCorruption();
          return;
        }

        // 验证表结构
        this.validateSchema();

        // 启动中心变更监测 + 立即做一次初始备份（刷新可能不完整的旧 .backup）
        if (this.isCorrupted) return; // 防御：校验路径可能已触发损坏标记
        this.monitor?.start();
        void this.doBackup();

        console.log('[Database] ✅ Database connected');
        return; // 成功，退出重试循环
        
      } catch (error: any) {
        console.error(`[Database] ❌ Attempt ${attempt} failed: ${error.message}`);
        
        // 清理失败的连接
        if (this.db) {
          try { this.db.close(); } catch (_) {}
          this.db = null;
        }
        
        // 如果是最后一次尝试，跳过数据库
        if (attempt === maxRetries) {
          this.isConnected = false;
          
          // ★ 统一损坏检测：malformed / not a database / corrupt / SQLITE_ERROR
          if (error.message?.includes('malformed') || error.message?.includes('not a database') ||
              error.message?.includes('corrupt') || error.code === 'ERR_SQLITE_ERROR') {
            this.handleCorruption();
          }
          
          console.warn(`\n[Database] ⚠️  After ${maxRetries} attempts still cannot connect, skipping database connection`);
          console.warn(`[Database]    Final error: ${error.message}`);
          console.warn(`[Database]    Error code: ${error.code || 'N/A'}`);
          console.warn('[Database] 💡 Possible causes:');
          console.warn('       1. Database is in use by another program (OpenClaw/CoordClaw)');
          console.warn('       2. File locked by antivirus software');
          console.warn('       3. Disk I/O temporarily unavailable');
          return;
        }
        
        // 等待后重试
        console.log(`[Database] ⏳ Waiting ${retryDelayMs}ms before retry...\n`);
        const start = Date.now();
        while (Date.now() - start < retryDelayMs) { /* 仅启动时，短暂阻塞可接受 */ }
      }
    }
  }
  
  /**
   * 安全执行PRAGMA（不因单个PRAGMA失败而中断）
   */
  private executePragmaSafely(sql: string): void {
    if (!this.db) return;
    
    try {
      this.db.exec(sql);
    } catch (error: any) {
      console.warn(`[Database]   ⚠️ PRAGMA execution warning: ${sql} -> ${error.message}`);
    }
  }
  
  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.db) {
      try {
        this.db.close();
        console.log('[Database] ✅ Disconnected');
      } catch (error) {
        console.error('[Database] ⚠️  Error while disconnecting:', error);
      }
      this.db = null;
      this.isConnected = false;
    }
  }
  
  /**
   * 检查是否已连接
   */
  public isReady(): boolean {
    return this.isConnected;
  }

  public isDemoMode(): boolean {
    return false;
  }
  
  // ============ 核心查询SQL构建（复用） ============

  /**
   * 核心消息查询 SQL 模板（所有查询复用此模板）
   * 特点：ID 列用于匹配（encoding safe），name 列用于展示
   */
  private get BASE_MESSAGE_SQL(): string {
    const viewJoin = ', COUNT(mv.msg_id) as view_count';
    const viewTable = ' LEFT JOIN message_views mv ON tm.msg_id = mv.msg_id';
    return `
    SELECT
      tm.rowid as id,
      tm.msg_id,
      tm.sender as from_name,
      tm.sender_id as from_id,
      tm.recipient,
      tm.recipient_id,
      tm.content,
      tm.created_at,
      DATE(tm.created_at, 'localtime') as created_date,
      GROUP_CONCAT(tmr.reader_name) as readers,
      GROUP_CONCAT(tmr.reader_id) as reader_ids${viewJoin}
    FROM team_messages tm
    LEFT JOIN team_message_reads tmr ON tm.msg_id = tmr.msg_id${viewTable}
    %WHERE_AND_GROUP%
  `;
  }

  /** 替换模板中的 %WHERE_AND_GROUP% 占位符 */
  private applyGroupOrder(sql: string, where: string = '', order: string = 'tm.rowid DESC', extraJoin: string = ''): string {
    return sql.replace('%WHERE_AND_GROUP%',
      `${extraJoin}
${where}
    GROUP BY tm.rowid, tm.msg_id, tm.sender, tm.sender_id, tm.recipient, tm.recipient_id, tm.content, tm.created_at
    ORDER BY ${order}`);
  }

  // ============ 三个核心接口（同源数据 + 统一状态 + 不同分类）============

  /**
   * 获取消息总数
   */
  getMessageCount(): number {
    this.ensureConnected();
    if (!this.isConnected) return 0;
    try {
      const stmt = this.db!.prepare('SELECT COUNT(*) as total FROM team_messages');
      const result = stmt.get() as any;
      return result?.total || 0;
    } catch { return 0; }
  }

  /**
   * 接口1：获取当前用户的未读消息数量（用于UI红点/数字）
   */
  getUnreadCount(): number {
    this.ensureConnected();

    if (!this.isConnected) return 0;
    try {
      // 按 recipient_id 精确过滤，避免全表扫描
      const sql = this.applyGroupOrder(this.BASE_MESSAGE_SQL, 'WHERE tm.recipient_id = ?');
      const stmt = this.db!.prepare(sql);
      const rows = stmt.all(this.currentUserId) as any[];

      // 统一计算未读状态
      const messages = this.batchCalculateUnreadStatus(rows);
      const count = messages.filter(m => m.is_unread).length;

      console.log(`[Database] 📊 Unread count: ${count} (total ${messages.length}, user:${this.currentUser}/${this.currentUserId})`);
      return count;
    } catch (error) {
      console.error('[Database] ❌ Failed to get unread count:', error);
      return 0;
    }
  }

  /**
   * 接口2：加载消息列表（用于分页展示消息内容）
   */
  getMessages(params: {
    limit?: number;
    since_id?: number;
    before_id?: number;
    member?: string;
    member_id?: string;
    sender?: string;
    from_date?: string;
    offset?: number;
    unread_only?: boolean;
    read_only?: boolean;
    keyword?: string;
  }): MessagesResult {
    this.ensureConnected();

    if (!this.isConnected) return { messages: [], count: 0, total: 0 };
    const limit = Math.min(params.limit || 100, 500);
    const offset = params.offset || 0;

    const filterConditions: string[] = [];
    const filterParams: any[] = [];
    const paginationConditions: string[] = [];
    const paginationParams: any[] = [];

    // 分页条件（不计入首条消息时间，见 H-A）
    if (params.since_id) {
      paginationConditions.push('tm.rowid > ?');
      paginationParams.push(params.since_id);
    }
    if (params.before_id) {
      paginationConditions.push('tm.rowid < ?');
      paginationParams.push(params.before_id);
    }
    if (params.from_date) {
      paginationConditions.push('tm.created_at >= ?');
      paginationParams.push(params.from_date);
    }

    // 筛选条件（计入首条消息时间）
    // 按 recipient_id 精确过滤（优先），兜底按 name
    if (params.member_id) {
      filterConditions.push('tm.recipient_id = ?');
      filterParams.push(params.member_id);
    } else if (params.member) {
      filterConditions.push('tm.recipient = ?');
      filterParams.push(params.member);
    }
    // SQL层直接过滤未读：recipient_id 不在 team_message_reads.reader_id 中
    if (params.unread_only) {
      filterConditions.push('tmr_r.reader_id IS NULL');
    }
    if (params.keyword) {
      filterConditions.push('tm.content LIKE ?');
      filterParams.push(`%${params.keyword}%`);
    }
    if (params.sender) {
      filterConditions.push('tm.sender_id = ?');
      filterParams.push(params.sender);
    }
    if (params.read_only) {
      filterConditions.push('tmr_r.reader_id IS NOT NULL');
    }

    const countJoin = params.unread_only || params.read_only
      ? ` LEFT JOIN team_message_reads tmr_r ON tm.msg_id = tmr_r.msg_id AND tmr_r.reader_id = tm.recipient_id`
      : '';

    const allConditions = [...filterConditions, ...paginationConditions];
    const allParams = [...filterParams, ...paginationParams];
    const whereClause = allConditions.length > 0
      ? ' WHERE ' + allConditions.join(' AND ')
      : '';
    // 首条消息时间只用筛选条件（排除分页），避免翻页把首条算错
    const filterWhereClause = filterConditions.length > 0
      ? ' WHERE ' + filterConditions.join(' AND ')
      : '';

    try {
      // 统计总数
      const countSql = `SELECT COUNT(*) as total FROM team_messages tm${countJoin}${whereClause}`;
      const countStmt = this.db!.prepare(countSql);
      const countResult = countStmt.get(...allParams) as any;
      const total = countResult?.total || 0;

      // 执行查询（用 BASE_MESSAGE_SQL 模板）
      const unreadJoin = (params.unread_only || params.read_only)
        ? ` LEFT JOIN team_message_reads tmr_r ON tm.msg_id = tmr_r.msg_id AND tmr_r.reader_id = tm.recipient_id`
        : '';
      const mainSql = this.applyGroupOrder(this.BASE_MESSAGE_SQL, whereClause, 'tm.rowid DESC', unreadJoin) + `
        LIMIT ? OFFSET ?
      `;
      const mainParams = [...allParams, limit, offset];
      const mainStmt = this.db!.prepare(mainSql);
      const rows = mainStmt.all(...mainParams) as any[];

      console.log(`[Database] 📥 Unified query: fetched ${rows.length} raw rows (same source)`);

      // 统一计算 is_unread
      let messages: MessageRecord[] = this.batchCalculateUnreadStatus(rows);

      // ★ 首条消息时间：仅用筛选条件（排除分页），取真正最早一条（created_at 升序、id 升序兜底精度）
      let firstMessageAt: string | null = null;
      try {
        const firstMsgSql = `SELECT tm.created_at as first_at FROM team_messages tm${countJoin}${filterWhereClause} ORDER BY tm.created_at ASC, tm.rowid ASC LIMIT 1`;
        const firstMsgStmt = this.db!.prepare(firstMsgSql);
        const firstMsgRow = firstMsgStmt.get(...filterParams) as any;
        firstMessageAt = firstMsgRow?.first_at || null;
      } catch (e) {
        console.warn('[Database] ⚠️ Failed to compute first message time:', (e as Error)?.message);
      }

      return { messages, count: messages.length, total, firstMessageAt };
    } catch (error) {
      console.error('[Database] ❌ Failed to query messages:', error);
      return { messages: [], count: 0 };
    }
  }

  /**
   * 接口3：获取特定成员的未读消息列表（点击成员时调用）
   *
   * 逻辑：该成员发出 + 发给当前用户 + 未读
   *
   * @param memberName - 成员名（前端传的显示名）
   * @param memberId - 成员 agent_id（精确匹配）
   */
  getMemberUnread(memberName: string, memberId?: string): MessageRecord[] {
    this.ensureConnected();

    if (!memberName) return [];
    if (!this.isConnected) return [];

    try {
      // 用 sender_id 过滤（精确匹配，有索引）
      const sql = this.applyGroupOrder(this.BASE_MESSAGE_SQL, `WHERE tm.recipient_id = ?
          AND tm.sender_id = ?`);
      const stmt = this.db!.prepare(sql);
      // senderId 优先，兜底 sender 名字
      const senderId = memberId || memberName;
      const rows = stmt.all(this.currentUserId, senderId) as any[];

      let messages = this.batchCalculateUnreadStatus(rows);

      // 内存过滤：仅未读
      messages = messages.filter(m => m.is_unread === true);

      console.log(`[Database] 👤 Member unread: ${memberName} → ${messages.length}`);
      return messages;
    } catch (error) {
      console.error('[Database] ❌ Failed to get member unread:', error);
      return [];
    }
  }

  /**
   * 获取成员列表及未读统计（同源数据 + 统一方法 + 内存分类）
   */
  getMembers(currentUserName?: string): MemberRecord[] {
    this.ensureConnected();

    if (!this.isConnected) return [];
    try {
      // 查询所有消息（含 reader_ids 用于计算未读）
      const sql = this.applyGroupOrder(this.BASE_MESSAGE_SQL);
      const stmt = this.db!.prepare(sql);
      const rows = stmt.all() as any[];

      // 统一计算 is_unread（ID 匹配，编码安全）
      let allMessages = this.batchCalculateUnreadStatus(rows);

      // ★ 以 team.json 成员为基底（权威源），再叠加上消息统计数据
      const memberMap = new Map<string, { unreadCount: number; lastActive: string }>();

      // 初始化全部 team.json 成员（含 humanMember）
      for (const m of this.members) {
        memberMap.set(m.name, { unreadCount: 0, lastActive: '' });
      }
      for (const h of this.humanMembers) {
        if (h.enabled && h.name && !memberMap.has(h.name)) {
          memberMap.set(h.name, { unreadCount: 0, lastActive: '' });
        }
      }

      // 遍历消息，叠加统计数据
      for (const msg of allMessages) {
        for (const name of [msg.from_name, msg.recipient]) {
          if (!name) continue;
          if (!memberMap.has(name)) {
            memberMap.set(name, { unreadCount: 0, lastActive: '' });
          }
          const stats = memberMap.get(name)!;
          if (msg.created_at > stats.lastActive) {
            stats.lastActive = msg.created_at;
          }
        }
        if (msg.recipient && msg.is_unread) {
          const stats = memberMap.get(msg.recipient);
          if (stats) stats.unreadCount++;
        }
      }

      // 从 team.json 获取角色信息（members + humanMember）
      const roleMap = new Map<string, string>();
      for (const m of this.members) {
        const role = (m as any).role;
        if (m.name && role) roleMap.set(m.name, role);
      }
      for (const h of this.humanMembers) {
        if (h.name && h.role) roleMap.set(h.name, h.role);
      }

      // 统一查找映射：按名字找 agent_id / sessionKey
      const agentIdMap = new Map<string, string>();
      const sessionKeyMap = new Map<string, string>();
      for (const m of this.members) {
        if (m.name && m.agent_id) agentIdMap.set(m.name, m.agent_id);
        if (m.name && m.sessionKey) sessionKeyMap.set(m.name, m.sessionKey);
      }
      for (const h of this.humanMembers) {
        if (h.enabled && h.name && h.human_id) agentIdMap.set(h.name, h.human_id);
      }

      const result: MemberRecord[] = [];
      for (const [name, stats] of memberMap) {
        result.push({
          name,
          agent_id: agentIdMap.get(name) || '',
          unread_count: stats.unreadCount,
          role: roleMap.get(name) || 'member',
          last_active: stats.lastActive,
          sessionKey: sessionKeyMap.get(name) || '',
        });
      }

      // ★ 按 team.json members + humanMember 顺序排序（未收录的排最后）
      const orderMap = new Map<string, number>();
      this.members.forEach((m, i) => { if (m.name) orderMap.set(m.name, i); });
      this.humanMembers.forEach((h, i) => {
        if (h.enabled && h.name && !orderMap.has(h.name)) orderMap.set(h.name, this.members.length + i);
      });
      result.sort((a, b) => {
        const ia = orderMap.get(a.name);
        const ib = orderMap.get(b.name);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return a.name.localeCompare(b.name);
      });

      console.log(`[Database] ✅ Member list loaded (${result.length}, team.json authoritative source)`);
      return result;

    } catch (error) {
      console.error('[Database] ❌ Failed to query members:', error);
      return [];
    }
  }
  
  /**
   * ★ 写操作辅助：优先主连接写入，只读时自动创建临时读写连接
   */
  private _withWrite<T>(operation: string, fn: (db: DatabaseSync) => T): T {
    const attempt = (db: DatabaseSync): T => {
      const result = fn(db);
      this.afterWrite(); // 写入成功后通知监测器（即时通道）
      return result;
    };
    try {
      return attempt(this.db!);
    } catch (error: any) {
      if (error?.code === 'ERR_SQLITE_ERROR' || error?.message?.includes('readonly')) {
        console.log(`[Database] 🔄 Primary connection is read-only, using temp write connection ${operation}...`);
        let tempDb: DatabaseSync | null = null;
        try {
          tempDb = new DatabaseSync(this.dbPath);
          return attempt(tempDb);
        } catch (tempError: any) {
          console.error(`[Database] ❌ Temp write connection ${operation} failed:`, tempError.message);
          throw tempError;
        } finally {
          if (tempDb) { try { tempDb.close(); } catch (_) {} }
        }
      }
      throw error;
    }
  }

  /**
   * 时区迁移：把历史裸本地时间统一迁为 ISO-8601 UTC（带 Z）。
   * - 复用 _withWrite 的「只读主连接→临时可写连接」回退，避免与 QClaw 锁冲突。
   * - 仅当存在旧格式（裸 "YYYY-MM-DD HH:MM:SS"）行时才执行，幂等。
   * - 迁移失败仅告警，不阻断服务。
   */
  /**
   * 标记消息已读（支持主连接只读时用临时读写连接写入）
   */
  markRead(messageIds: number[], reader: string): MarkReadResult {
    this.ensureConnected();

    if (!messageIds || messageIds.length === 0) {
      return { success: false, marked_count: 0, error: '消息ID列表为空' };
    }

    try {
      const result = this._withWrite('标记已读', (db) => {
        let markedCount = 0;
        for (const messageId of messageIds) {
          const msgStmt = db.prepare('SELECT msg_id, recipient_id FROM team_messages WHERE rowid = ?');
          const msgResult = msgStmt.get(messageId) as any;
          if (!msgResult || !msgResult.msg_id) {
            console.warn(`[Database]   ⚠️ Message ID ${messageId} does not exist or has no msg_id`);
            continue;
          }
          const nowIso = new Date().toISOString();
          const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO team_message_reads (msg_id, reader_name, reader_id, read_at)
            VALUES (?, ?, ?, ?)
          `);
          insertStmt.run(msgResult.msg_id, reader, this.currentUserId, nowIso);
          markedCount++;
        }
        return { markedCount };
      });
      console.log(`[Database] ✅ Marked read: ${result.markedCount}/${messageIds.length} messages by ${reader}`);
      return { success: true, marked_count: result.markedCount };
    } catch (error: any) {
      console.error('[Database] ❌ Failed to mark read:', error);
      return { success: false, marked_count: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 批量全部已读：一条 SQL，reader_id 用消息自己的 recipient_id */
  markAllRead(filters: {
    sender?: string;
    member?: string;
    member_id?: string;
    keyword?: string;
  } = {}): { marked_count: number } {
    this.ensureConnected();
    try {
      const conditions: string[] = ['tmr.msg_id IS NULL'];
      const params: any[] = [];

      if (filters.sender) {
        conditions.push('tm.sender_id = ?');
        params.push(filters.sender);
      }
      if (filters.member_id) {
        conditions.push('tm.recipient_id = ?');
        params.push(filters.member_id);
      } else if (filters.member) {
        conditions.push('tm.recipient = ?');
        params.push(filters.member);
      }
      if (filters.keyword) {
        conditions.push('tm.content LIKE ?');
        params.push(`%${filters.keyword}%`);
      }

      const nowIso = new Date().toISOString();
      const sql = `
        INSERT OR IGNORE INTO team_message_reads (msg_id, reader_name, reader_id, read_at)
        SELECT tm.msg_id, tm.recipient, tm.recipient_id, ?
        FROM team_messages tm
        LEFT JOIN team_message_reads tmr ON tm.msg_id = tmr.msg_id AND tmr.reader_id = tm.recipient_id
        WHERE ${conditions.join(' AND ')}
      `;

      const result = this._withWrite('批量已读', (db) => {
        const info = db.prepare(sql).run(nowIso, ...params) as any;
        return { markedCount: info.changes };
      });
      console.log(`[Database] ✅ Batch marked read: ${result.markedCount}`);
      return { marked_count: result.markedCount };
    } catch (e: any) {
      console.error('[Database] ❌ Failed to batch mark read:', e);
      return { marked_count: 0 };
    }
  }

  /** 构建导出过滤条件（CSV 与 HTML 共用，单一真相源） */
  private buildExportWhere(filters: { sender?: string; member_id?: string; keyword?: string; unread_only?: boolean; read_only?: boolean } = {}): { where: string; params: any[]; extraJoin: string } {
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let extraJoin = '';
    if (filters.sender)     { conditions.push('tm.sender_id = ?');  params.push(filters.sender); }
    if (filters.member_id)  { conditions.push('tm.recipient_id = ?'); params.push(filters.member_id); }
    if (filters.keyword)    { conditions.push('tm.content LIKE ?'); params.push(`%${filters.keyword}%`); }
    if (filters.unread_only || filters.read_only) {
      extraJoin = ' LEFT JOIN team_message_reads tmr_r ON tm.msg_id = tmr_r.msg_id AND tmr_r.reader_id = tm.recipient_id';
      if (filters.unread_only) conditions.push('tmr_r.msg_id IS NULL');
      if (filters.read_only)   conditions.push('tmr_r.msg_id IS NOT NULL');
    }
    return { where: conditions.join(' AND '), params, extraJoin };
  }

  /** 取全部导出行（已带 is_unread / view_count），供 CSV 与 HTML 共用 */
  private fetchExportRows(filters: { sender?: string; member_id?: string; keyword?: string; unread_only?: boolean; read_only?: boolean } = {}): any[] {
    this.ensureConnected();
    const { where, params, extraJoin } = this.buildExportWhere(filters);
    const sql = this.applyGroupOrder(this.BASE_MESSAGE_SQL, `WHERE ${where}`, 'tm.rowid ASC', extraJoin);
    return this.batchCalculateUnreadStatus(this.db!.prepare(sql).all(...params) as any[]);
  }

  /** 导出 CSV — 逐批回调，内存恒定 */
  exportCSV(
    filters: { sender?: string; member_id?: string; keyword?: string; unread_only?: boolean; read_only?: boolean } = {},
    onBatch: (rows: any[]) => void,
    batchSize: number = 500
  ): void {
    this.ensureConnected();
    const { where, params, extraJoin } = this.buildExportWhere(filters);
    const sql = this.applyGroupOrder(this.BASE_MESSAGE_SQL, `WHERE ${where}`, 'tm.rowid ASC', extraJoin) + `
      LIMIT ? OFFSET ?
    `;
    let offset = 0;
    while (true) {
      const rows = this.db!.prepare(sql).all(...params, batchSize, offset) as any[];
      if (!rows.length) break;
      onBatch(this.batchCalculateUnreadStatus(rows));
      offset += batchSize;
    }
  }

  /** 导出 HTML 单文件（白主题，可筛选，成员仅显示总数，UI 跟随 locale） */
  exportHTML(
    filters: { sender?: string; member_id?: string; keyword?: string; unread_only?: boolean; read_only?: boolean } = {},
    locale?: string
  ): string {
    this.ensureConnected();
    const rows = this.fetchExportRows(filters);
    const total = rows.length;
    const firstAt = total
      ? rows.reduce((min: string, r: any) => (r.created_at && r.created_at < min ? r.created_at : min), rows[0].created_at || '')
      : '';
    const senders = Array.from(new Set(rows.map((r: any) => r.from_name).filter(Boolean))).sort() as string[];
    const recipients = Array.from(new Set(rows.map((r: any) => r.recipient).filter(Boolean))).sort() as string[];
    const members = buildMembers(rows);
    return buildExportHTML({ messages: rows, members, total, firstAt, senders, recipients, locale });
  }

  /**
   * 发送消息（写入 team_messages 表）
   * 支持主连接只读时用临时读写连接写入
   */
  sendMessage(params: {
    sender: string;
    sender_id: string;
    recipient: string;
    recipient_id: string;
    content: string;
  }): SendMessageResult {
    this.ensureConnected();

    if (!params.sender || !params.recipient || !params.content) {
      return { success: false, error: '发送者、接收者和消息内容不能为空' };
    }

    if (!this.isConnected) return { success: false, error: '数据库未连接' };

    try {
      const result = this._withWrite('发送消息', (db) => {
        const msgId = (params as any).msg_id || 'msg-' + randomUUID();
        const nowIso = new Date().toISOString();
        const stmt = db.prepare(`
          INSERT INTO team_messages (msg_id, sender, sender_id, recipient, recipient_id, content, created_at, created_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, DATE(?, 'localtime'))
        `);
        stmt.run(msgId, params.sender, params.sender_id, params.recipient, params.recipient_id, params.content, nowIso, nowIso);
        const r = db.prepare('SELECT last_insert_rowid() as id').get() as any;
        return { msgId, newId: r?.id || 0 };
      });
      console.log(`[Database] ✅ Message sent: ${params.sender} → ${params.recipient} (${result.msgId})`);
      return { success: true, message_id: result.newId, msg_id: result.msgId };
    } catch (error: any) {
      console.error('[Database] ❌ Failed to send message:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 切换消息的已读/未读状态
   * - 已有 reader_name + reader_id 记录 → DELETE（变未读）
   * - 没有记录 → INSERT（变已读）
   */
  toggleRead(msgId: string, readerName: string, readerId: string): ToggleReadResult {
    this.ensureConnected();

    if (!msgId || !readerName || !readerId) {
      return { success: false, is_read: false, error: '参数不全' };
    }

    if (!this.isConnected) return { success: false, is_read: false, error: '数据库未连接' };

    try {
      const isRead = this._withWrite('toggle已读', (db) => {
        const checkStmt = db.prepare('SELECT 1 FROM team_message_reads WHERE msg_id = ? AND reader_id = ?');
        const existing = checkStmt.get(msgId, readerId);
        if (existing) {
          db.prepare('DELETE FROM team_message_reads WHERE msg_id = ? AND reader_id = ?').run(msgId, readerId);
          console.log(`[Database] 🔄 Message ${msgId} marked unread (reader=${readerName})`);
          return false;
        } else {
          const insStmt = db.prepare(`INSERT INTO team_message_reads (msg_id, reader_name, reader_id, read_at) VALUES (?, ?, ?, ?)`);
          insStmt.run(msgId, readerName, readerId, new Date().toISOString());
          console.log(`[Database] ✅ Message ${msgId} marked read (reader=${readerName})`);
          return true;
        }
      });
      return { success: true, is_read: isRead };
    } catch (error: any) {
      return { success: false, is_read: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 定向标记为已读（INSERT OR IGNORE） */
  markAsRead(msgId: string, readerName: string, readerId: string): ToggleReadResult {
    this.ensureConnected();
    if (!msgId || !readerName || !readerId) return { success: false, is_read: false };
    if (!this.isConnected) return { success: true, is_read: true };
    try {
      this._withWrite('markAsRead', (db) => {
        db.prepare(`INSERT OR IGNORE INTO team_message_reads (msg_id, reader_name, reader_id, read_at) VALUES (?, ?, ?, ?)`).run(msgId, readerName, readerId, new Date().toISOString());
        return true;
      });
      return { success: true, is_read: true };
    } catch (error: any) {
      return { success: false, is_read: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 定向标记为未读（DELETE） */
  markAsUnread(msgId: string, readerId: string): ToggleReadResult {
    this.ensureConnected();
    if (!msgId || !readerId) return { success: false, is_read: false };
    if (!this.isConnected) return { success: true, is_read: false };
    try {
      this._withWrite('markAsUnread', (db) => {
        db.prepare('DELETE FROM team_message_reads WHERE msg_id = ? AND reader_id = ?').run(msgId, readerId);
        return false;
      });
      return { success: true, is_read: false };
    } catch (error: any) {
      return { success: false, is_read: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 获取新消息（用于SSE推送）
   */
  getNewMessages(sinceId: number, limit: number = 20): MessageRecord[] {
    this.ensureConnected();

    if (!this.isConnected) return [];

    try {
      const sql = this.applyGroupOrder(this.BASE_MESSAGE_SQL, 'WHERE tm.rowid > ?', 'tm.rowid ASC') + `
        LIMIT ?
      `;
      const stmt = this.db!.prepare(sql);

      const rows = stmt.all(sinceId, limit) as any[];

      return this.batchCalculateUnreadStatus(rows);
    } catch (error) {
      console.error('[Database] ❌ Failed to get new messages:', error);
      return [];
    }
  }
  
  /**
   * 获取最大消息ID（用于SSE增量检测）
   */
  getMaxMessageId(): number {
    this.ensureConnected();

    if (!this.isConnected) return 0;

    try {
      const stmt = this.db!.prepare('SELECT COALESCE(MAX(rowid), 0) as max_id FROM team_messages');
      const result = stmt.get() as any;
      return result?.max_id || 0;
    } catch (error) {
      console.error('[Database] ❌ Failed to get max message ID:', error);
      return 0;
    }
  }
  
  // ============ 私有辅助方法（统一接口） ============

  /**
   * ★★★ 唯一的未读状态计算入口 ★★★
   *
   * 未读定义（ID 精确匹配，杜绝编码问题）：
   * team_message_reads 表中有 (msg_id, reader_id) 记录 → 已读
   * 无记录 → 未读
   *
   * @param row - 数据库查询的原始行（必须包含 recipient_id, reader_ids 等字段）
   * @returns MessageRecord - 包含统一计算的is_unread字段
   */
  private calculateMessageUnreadStatus(row: any): MessageRecord {
    const readers = row.readers ? row.readers.split(',').filter(Boolean) : [];
    const readerIds = row.reader_ids ? row.reader_ids.split(',').filter(Boolean) : [];
    const recipientId = row.recipient_id || row.recipient; // 兜底取 name（编码安全垫）

    return {
      id: row.id,
      msg_id: row.msg_id || '',
      role: 'user',
      content: this.truncateContent(row.content || '', 800),
      created_at: row.created_at,
      created_date: row.created_date || '',
      from_name: row.from_name || row.sender || '未知',
      from_id: row.from_id || '',
      recipient: row.recipient || '',
      recipient_id: row.recipient_id || '',
      read_by: readers,
      view_count: row.view_count ?? 0,
      // ★ ID 精确匹配：recipient_id 是否在 reader_ids 中
      is_unread: !readerIds.includes(recipientId)
    };
  }

  /**
   * 批量处理消息数组（统一添加is_unread状态）
   */
  private batchCalculateUnreadStatus(rows: any[]): MessageRecord[] {
    return rows.map(row => this.calculateMessageUnreadStatus(row));
  }

  private ensureConnected(): void {
    if (!this.isReady()) {
      this.connect();
    }
  }
  
  /**
   * 验证数据库表结构是否存在
   */
  private validateSchema(): void {
    const requiredTables = ['team_messages', 'team_message_reads'];

    for (const table of requiredTables) {
      try {
        const stmt = this.db!.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`);
        const result = stmt.get(table);

        if (!result) {
          console.warn(`[Database] ⚠️  Missing required table: ${table}`);
        }
      } catch (error) {
        console.warn(`[Database] ⚠️  Error validating table ${table}:`, error);
      }
    }

    // 检查并创建 message_views 表
    try {
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS message_views (
          view_id INTEGER PRIMARY KEY AUTOINCREMENT,
          msg_id TEXT NOT NULL,
          viewer_name TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          viewed_at TEXT NOT NULL,
          view_source TEXT DEFAULT 'inbox'
        )
      `);
      this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_message_views_msg_id ON message_views(msg_id)`);
      this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_message_views_viewer ON message_views(viewer_name, viewer_id)`);
      this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_message_views_time ON message_views(viewed_at)`);
      console.log(`[Database] message_views table: ready`);
    } catch {
      console.warn(`[Database] message_views table creation failed`);
    }
  }

  /**
   * 截断过长内容
   */
  private truncateContent(content: string, maxLength: number = 500): string {
    if (!content) return '';
    if (content.length <= maxLength) return content;
    
    return content.substring(0, maxLength) + '...(内容已截断)';
  }
  
  /**
   * 获取当前数据库路径
   */
  public getDbPath(): string {
    return this.dbPath;
  }

  /**
   * 重新连接到新的数据库（用于项目切换）
   * 关闭旧连接 → 更新路径 → 刷新配置 → 重新连接
   */
  public reconnect(newPath: string): void {
    // 1. 合并 WAL 并关闭现有连接
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* ignore */ }
      try { this.db.close(); } catch (_) { /* ignore */ }
      this.db = null;
      this.isConnected = false;
    }

    // 2. 更新路径
    this.dbPath = newPath;

    // 3. 刷新成员配置（新项目可能有不同的 team.json）
    const config = getConfig(true);
    this.currentUser = config.currentUser;
    this.currentUserId = config.currentUserId;
    this.members = config.members;
    this.humanMembers = (config.humanMember || []) as any[];

    // 4. 重新连接
    this.connect();

    console.log(`[Database] 🔄 Database switched: ${newPath}`);
  }

  /** ★ 启动数据库变更监测与备份（保留方法名以兼容调用方 server.ts） */
  startBackupWatcher(): void {
    this.monitor?.start();
  }

  stopBackupWatcher(): void {
    this.monitor?.stop();
  }

  /** 暴露给 SSE 等模块订阅数据库变更信号 */
  public onChange(listener: () => void | Promise<void>): () => void {
    if (!this.monitor) return () => {};
    return this.monitor.subscribe(listener);
  }

  /** 当前 data_version（供监测器用）；不可用时返回 null */
  public getDataVersion(): number | null {
    if (!this.db) return null;
    try {
      const r = this.db.prepare('PRAGMA data_version').get() as any;
      return typeof r?.data_version === 'number' ? r.data_version : null;
    } catch {
      return null;
    }
  }

  /** 控制面板自身写入成功后调用，即时触发变更信号 */
  private afterWrite(): void {
    this.monitor?.notifyChanged();
  }

  /** 变更信号 → 备份（自节流 ≥30s，避免频繁备份） */
  private async onDatabaseChanged(): Promise<void> {
    if (this.isCorrupted || this.isRestoring) return; // ★ 损坏/恢复中冻结备份
    const now = Date.now();
    if (now - this.lastBackupAt < 30_000) return;
    this.lastBackupAt = now;
    await this.doBackup();
  }

  /** 在线备份（串行化入口，避免并发争抢 .tmp 导致 EPERM / unable to open） */
  doBackup(): Promise<void> {
    if (this.isCorrupted || this.isRestoring) return Promise.resolve(); // ★ 冻结
    const run = this.backupChain.then(() => this._doBackupOnce());
    this.backupChain = run.catch(() => {});
    return run;
  }

  /** 在线备份：前验源库完整性(防污染) → node:sqlite 在线备份 → 原子替换 .backup */
  private async _doBackupOnce(): Promise<void> {
    if (!this.db || this.isCorrupted || this.isRestoring) return;
    const backupPath = this.dbPath + '.backup';
    const tmp = `${backupPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      rmSync(tmp, { force: true });
      rmSync(tmp + '-journal', { force: true });

      // ★ 门：备份前校验源库完整性，防止坏主库污染好备份
      if (!this.quickCheck(this.db)) {
        console.error('[Database] 🔴 Pre-backup integrity check failed (source soft corruption), backup frozen');
        this.handleCorruption();
        return;
      }

      await (nodeSqlite as any).backup(this.db, tmp);
      try {
        renameSync(tmp, backupPath);
      } catch {
        copyFileSync(tmp, backupPath);
      }
      rmSync(tmp, { force: true });
      rmSync(tmp + '-journal', { force: true });
      this.backupAvailable = true;
      console.log('[Database] 💾 Backup updated');
    } catch (e: any) {
      console.error('[Database] ❌ Backup failed:', e?.message || e);
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }

  /** ★ 从备份恢复数据库（幂等·防污染·防 WAL 污染） */
  restoreFromBackup(): boolean {
    const backupPath = this.dbPath + '.backup';
    if (!existsSync(backupPath)) return false;
    // 幂等：已经在恢复中则拒绝重复调用
    if (this.isRestoring) return false;
    this.isRestoring = true;
    try {
      // 校验备份本身完好，坏备份绝不恢复
      if (!this.quickCheck()) {
        this.backupCorrupt = true;
        console.error('[Database] 🔴 Backup corrupted, cannot restore');
        this.onCorruption?.();
        return false;
      }
      // 排空在途备份，断开连接
      this.disconnect();
      // 删除旧 WAL/SHM（防旧 WAL 配对新恢复的独立库文件导致再损坏）
      try { rmSync(this.dbPath + '-wal', { force: true }); } catch {}
      try { rmSync(this.dbPath + '-shm', { force: true }); } catch {}
      // 原子替换：备份 → 主库
      copyFileSync(backupPath, this.dbPath);
      // 重连（isRestoring 使内层 connect 跳过损坏分支，防重入）
      this.connect();
      // 重连后复核完整性
      if (!this.db || !this.quickCheck(this.db)) {
        throw new Error('恢复后完整性校验仍失败');
      }
      this.isCorrupted = false;
      this.backupAvailable = true;
      this.backupCorrupt = false;
      console.log('[Database] ♻️ Restored from backup');
      return true;
    } catch (e: any) {
      console.error('[Database] ❌ Restore failed:', e.message);
      return false;
    } finally {
      this.isRestoring = false;
    }
  }


}
