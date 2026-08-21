/**
 * Token 统计独立模块。
 *
 * 数据源：{projectRoot}/.data/data/token-stats.jsonl（与 coordclaw.db 同目录）。
 *   projectRoot 直接复用 config-resolver 解析出的 active 项目根目录，不自行猜测路径。
 *
 * 计算口径：按 sessionId 去重、取每个会话的 MAX(estTotal) 后累加。
 *   与插件 coordcenter/token-stats/pool.ts 的 deduped() 语义一致——
 *   同一会话会随运行多次 append 递增的 estTotal，朴素求和会严重重复计数。
 *
 * 监控：复用 file-watcher（监听 .data/data 目录、过滤 token-stats.jsonl），
 *   变更即重算并通过 subscribe 通知订阅者（server 据此 SSE 推前端）。
 *
 * 可扩展性：后续新增维度（如 rawUser 求和、按 agent 拆分、时间序列）
 *   只在本模块内扩展，调用方（config-resolver / server / 前端）无需改动。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_SUBDIR } from '../config-resolver.js';
import { FileWatcher } from './file-watcher.js';

export interface TokenStatsEntry {
  sessionId: string;
  estTotal: number;
  [key: string]: unknown;
}

export interface TokenStatsSnapshot {
  /** 去重累加后的累计 estTotal */
  estTotal: number;
  /** 去重后的会话数 */
  sessionCount: number;
}

/** 用于聚合的成员信息（复用 config-resolver 解析出的 members，不重新读 team.json） */
export interface BreakdownMember {
  name: string;
  agent_id: string;
  sessionKey?: string;
  role?: string;
  role_label?: string;
}

/** 单个成员的 token 聚合（仅 est 类，排除 raw 与轮次） */
export interface MemberTokenStat {
  name: string;
  agentId: string;
  role: string;
  roleLabel: string;
  sessionCount: number;
  estTotal: number;
  estInputTotal: number;
  estAsstOutput: number;
  estSysPrompt: number;
  estUser: number;
  estAsstHistory: number;
  estToolResult: number;
}

/** 按成员聚合后的整体明细 */
export interface TokenBreakdown {
  byMember: MemberTokenStat[];
  unmatched: { sessionCount: number; estTotal: number; estInputTotal: number; estAsstOutput: number };
  total: number;
  sessionCount: number;
}

/** 单条会话明细（按 sessionId 去重后的代表记录，按 ts 倒序排列） */
export interface SessionTokenRow {
  sessionId: string;
  sessionKey: string;
  ts: number;
  estTotal: number;
  estSysPrompt: number;
  estUser: number;
  estAsstHistory: number;
  estToolResult: number;
  estAsstOutput: number;
}

const ZERO_MEMBER = (): MemberTokenStat => ({
  name: '', agentId: '', role: '', roleLabel: '', sessionCount: 0,
  estTotal: 0, estInputTotal: 0, estAsstOutput: 0, estSysPrompt: 0,
  estUser: 0, estAsstHistory: 0, estToolResult: 0,
});

/**
 * 单一匹配真相源：给定记录的 sessionKey，返回其在 members 中的下标；-1 表示未匹配任何成员。
 * 两级匹配（聚合与表格标签共用，确保两处行为一致、不分化）：
 *   ① 配置会话优先：记录.sessionKey === 成员.sessionKey，或以其为前缀（兼容 :heartbeat 等后缀）。
 *   ② agent_id 退回：匹配不到时，若 sessionKey 形如 agent:<agent_id>:... 且第 2 段等于成员.agent_id，
 *      则归到该成员（应对"同 agent 开新会话、sessionKey 变而 agent_id 不变"的场景）。
 * 注意：agent_id 退回归于格式假设——新 sessionKey 须保持 agent:<agent_id>:...；若格式丢弃 agent_id，
 *      则退回失效（记录仍进 unmatched，优雅降级，与现状一致）。
 */
export function matchSessionKeyToMember(sk: string, members: BreakdownMember[]): number {
  if (!sk) return -1;
  const seg = sk.split(':');
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const mk = m.sessionKey || '';
    if (mk && (sk === mk || sk.startsWith(mk + ':'))) return i;                 // ① 配置会话（精确 + 后缀）
    if (m.agent_id && seg[0] === 'agent' && seg[1] === m.agent_id) return i;    // ② agent_id 退回
  }
  return -1;
}

/**
 * 读取 jsonl，按 sessionId 去重（保留 estTotal 最大的整条记录，保证各 est 字段一致），
 * 再按成员 sessionKey 匹配聚合。实时读盘、无缓存。
 * 匹配规则见 matchSessionKeyToMember：先严格匹配成员.sessionKey（精确/其后缀），匹配不到按 agent_id 段退回。
 */
export function readBreakdown(filePath: string, members: BreakdownMember[]): TokenBreakdown {
  const result: TokenBreakdown = {
    byMember: [],
    unmatched: { sessionCount: 0, estTotal: 0, estInputTotal: 0, estAsstOutput: 0 },
    total: 0,
    sessionCount: 0,
  };
  if (!existsSync(filePath)) return result;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  // ① 按 sessionId 去重，保留 estTotal 最大的整条记录
  const bySession = new Map<string, any>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as any;
      const sid = obj.sessionId;
      if (!sid) continue;
      const v = Number(obj.estTotal) || 0;
      const prev = bySession.get(sid);
      if (!prev || v > (Number(prev.estTotal) || 0)) bySession.set(sid, obj);
    } catch {
      /* 跳过损坏行 */
    }
  }

  // ② 每个成员一个聚合桶（与 members 顺序/数量一致；用平行数组避免按 sessionKey 建 Map 的 '' 撞键问题）
  const stats: MemberTokenStat[] = members.map((m) => {
    const stat = ZERO_MEMBER();
    stat.name = m.name;
    stat.agentId = m.agent_id;
    stat.role = m.role || '';
    stat.roleLabel = m.role_label || '';
    return stat;
  });

  // ③ 聚合（匹配统一走 matchSessionKeyToMember，聚合与表格标签共用同一真相源）
  let total = 0;
  for (const obj of bySession.values()) {
    const est = Number(obj.estTotal) || 0;
    total += est;
    result.sessionCount++;
    const idx = matchSessionKeyToMember(obj.sessionKey || '', members);
    if (idx >= 0) {
      const target = stats[idx];
      target.sessionCount++;
      target.estTotal += est;
      target.estInputTotal += Number(obj.estInputTotal) || 0;
      target.estAsstOutput += Number(obj.estAsstOutput) || 0;
      target.estSysPrompt += Number(obj.estSysPrompt) || 0;
      target.estUser += Number(obj.estUser) || 0;
      target.estAsstHistory += Number(obj.estAsstHistory) || 0;
      target.estToolResult += Number(obj.estToolResult) || 0;
    } else {
      result.unmatched.sessionCount++;
      result.unmatched.estTotal += est;
      result.unmatched.estInputTotal += Number(obj.estInputTotal) || 0;
      result.unmatched.estAsstOutput += Number(obj.estAsstOutput) || 0;
    }
  }

  result.byMember = stats;
  result.total = total;
  return result;
}

/**
 * 读取 jsonl，按 sessionId 去重（保留 estTotal 最大的代表记录），
 * 返回按 ts 倒序排列的单条会话明细列表（最新在前）。不按成员聚合。
 * sessionKey 形如 agent:<agent_id>:<context>:<uuid>[:heartbeat]（第 2 段为 agent_id，非显示名），
 * 友好名解析交由调用方（handler）借助 config.members 完成，这里只取原始记录。
 */
export function readSessionList(filePath: string): SessionTokenRow[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const bySession = new Map<string, any>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as any;
      const sid = obj.sessionId;
      if (!sid) continue;
      const v = Number(obj.estTotal) || 0;
      const prev = bySession.get(sid);
      if (!prev || v > (Number(prev.estTotal) || 0)) bySession.set(sid, obj);
    } catch {
      /* 跳过损坏行 */
    }
  }
  const rows: SessionTokenRow[] = [];
  for (const obj of bySession.values()) {
    rows.push({
      sessionId: obj.sessionId,
      sessionKey: obj.sessionKey || '',
      ts: Number(obj.ts) || 0,
      estTotal: Number(obj.estTotal) || 0,
      estSysPrompt: Number(obj.estSysPrompt) || 0,
      estUser: Number(obj.estUser) || 0,
      estAsstHistory: Number(obj.estAsstHistory) || 0,
      estToolResult: Number(obj.estToolResult) || 0,
      estAsstOutput: Number(obj.estAsstOutput) || 0,
    });
  }
  rows.sort((a, b) => b.ts - a.ts); // 最新日期在前
  return rows;
}

/** 读取 jsonl，按 sessionId 去重取 MAX(estTotal) 后求和（纯函数，便于复用与测试） */
export function readCumulative(filePath: string): TokenStatsSnapshot {
  if (!existsSync(filePath)) return { estTotal: 0, sessionCount: 0 };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { estTotal: 0, sessionCount: 0 };
  }
  const bySession = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Partial<TokenStatsEntry>;
      const sid = obj.sessionId;
      const v = Number(obj.estTotal) || 0;
      if (!sid) continue;
      const prev = bySession.get(sid) ?? 0;
      if (v > prev) bySession.set(sid, v); // 同会话保留最大累计值
    } catch {
      /* 跳过损坏行 */
    }
  }
  let total = 0;
  for (const v of bySession.values()) total += v;
  return { estTotal: total, sessionCount: bySession.size };
}

class TokenStatsService {
  private projectRoot = '';
  private watcher: FileWatcher | null = null;
  private cached: TokenStatsSnapshot = { estTotal: 0, sessionCount: 0 };
  private subscribers = new Set<(s: TokenStatsSnapshot) => void>();

  /** 设置项目根目录；与当前一致且已在监听则跳过，否则重启监听并重算 */
  setProjectRoot(root: string): void {
    if (!root) {
      this.stopWatcher();
      this.cached = { estTotal: 0, sessionCount: 0 };
      this.emit();
      return;
    }
    if (this.projectRoot === root && this.watcher) return;
    this.projectRoot = root;
    this.recompute();
    this.startWatcher();
  }

  get estTotal(): number { return this.cached.estTotal; }
  get snapshot(): TokenStatsSnapshot { return { ...this.cached }; }

  /** 按成员聚合的实时明细（每次调用重新读盘，绕开 watcher 缓存） */
  getBreakdown(members: BreakdownMember[]): TokenBreakdown {
    return readBreakdown(this.filePath(), members);
  }

  /** 按会话去重、按 ts 倒序的明细列表（每次调用重新读盘） */
  getSessionList(): SessionTokenRow[] {
    return readSessionList(this.filePath());
  }

  /** 订阅变更（立即回调一次当前快照）；返回取消订阅函数 */
  subscribe(cb: (s: TokenStatsSnapshot) => void): () => void {
    this.subscribers.add(cb);
    cb(this.cached);
    return () => { this.subscribers.delete(cb); };
  }

  private filePath(): string {
    return join(this.projectRoot, DB_SUBDIR, 'token-stats.jsonl');
  }

  private recompute(): void {
    this.cached = readCumulative(this.filePath());
    this.emit();
  }

  private startWatcher(): void {
    this.stopWatcher();
    const dir = join(this.projectRoot, DB_SUBDIR);
    this.watcher = new FileWatcher(dir, () => this.recompute(), {
      filterFilename: 'token-stats.jsonl',
      debounceMs: 300,
      pollFallbackMs: 30000,
    });
    this.watcher.start();
  }

  private stopWatcher(): void {
    if (this.watcher) { this.watcher.stop(); this.watcher = null; }
  }

  private emit(): void {
    for (const cb of this.subscribers) {
      try { cb(this.cached); } catch { /* noop */ }
    }
  }
}

export const tokenStatsService = new TokenStatsService();
