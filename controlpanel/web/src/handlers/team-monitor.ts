/**
 * 团队创建进度监控处理器
 *
 * 新任务发现机制（与 AI 侧 createteam.py 约定）：
 *   AI 在建团队目录后，于 base 目录（coordclaw-teams/）写 `.newteam.lock`，内容 = 团队目录名。
 *   monitor 不扫子目录找新任务，只 existsSync(base/.newteam.lock) 单点检测；
 *   读到名 → 校验为单段目录名 → 目录存在即新任务（写 dir/.monitoring.log + 删 base 标记），
 *   目录不存在即过期标记（续旧 + 删 base 标记）。无标记则续旧或 idle。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendJSON } from '../lib/response.js';
import { getOpenClawUserDir, TEAMSOUL_FILENAME, TEAM_RULE_FILENAME } from '../config-resolver.js';

/** 活动锁标记：存在于被监控的团队目录内，用于续旧 / 防重复锁定 */
export const MONITORING_LOG = '.monitoring.log';

/** 新任务标记：存在于 base 目录（coordclaw-teams/），内容 = 团队目录名 */
export const NEWTEAM_LOCK = '.newteam.lock';

/** 团队创建进度监控配置 */
export const TEAM_CREATE_STAGES = [
  { stage: 1, name: '团队目录已建立',   prompt: '【提示：请根据create-coordclaw-team 技能（SKILL）创建团队，请务必了解全过程步骤，据AI特点进行组织架构设计和项目目录结构设计，必须按SKILL要求让用户确定有关事项。】',                                    check: (p: string) => existsSync(p) },
  { stage: 2, name: '项目结构已创建',    prompt: '【提示：请回顾create-coordclaw-team 技能（SKILL）步骤，根据组织架构设计和项目特点设计结构目录，必须按SKILL要求让用户确定有关事项。】',                                                            check: (p: string) => existsSync(join(p, 'worklog')) },
  { stage: 3, name: '成员个性化配置文件已生成',   prompt: '【提示：请回顾create-coordclaw-team 技能（SKILL）步骤，根据组织关系及能力要求编写成员个体特征文件，必须按SKILL要求让用户确定有关事项。】',                                                                  check: (p: string) => existsSync(join(p, '.data', TEAMSOUL_FILENAME)) },
  { stage: 4, name: '团队规则文件已生成',    prompt: '【提示：请回顾create-coordclaw-team 技能（SKILL）步骤，根据组织关系及岗位要求编写成员团队协作规则，团队规则不要和SKILL步骤混淆，必须按SKILL要求让用户确定有关事项。】',                                                                  check: (p: string) => existsSync(join(p, '.data', TEAM_RULE_FILENAME)) },
  { stage: 5, name: '团队配置已通过核查',    prompt: '【提示：现在创建团队进入最后阶段，最后必须按照SKILL要求使用脚本进行自动化验证，严禁做SKILL规定外的事项。】',                                                           check: (p: string) => existsSync(join(p, '.createteamok.log')) },
];

// ★ 同步说明：阶段名称 & 提示词的翻译版本在 static/js/i18n.js 🔥 区域。修改提示词时请同步更新 i18n.js 的中英双语词条

export interface TeamMonitorState {
  interval: ReturnType<typeof setInterval> | null;
  teamPath: string;
}

function stopInterval(tm: TeamMonitorState): void {
  if (tm.interval) {
    clearInterval(tm.interval);
    tm.interval = null;
  }
}

/** 校验标记内容必须是单段目录名，禁止路径遍历（/ \ ..） */
export function isValidTeamName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === name.trim() &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
  );
}

/** 读 base/.newteam.lock，返回团队目录名；文件不存在 / 读失败 / 内容非法返回 null */
function readNewTeamLock(monitorDir: string): string | null {
  const lockPath = join(monitorDir, NEWTEAM_LOCK);
  if (!existsSync(lockPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8').trim();
  } catch {
    return null;
  }
  return isValidTeamName(raw) ? raw : null;
}

/** 删除 base/.newteam.lock（失败无害：幂等重锁） */
function clearNewTeamLock(monitorDir: string): void {
  try { unlinkSync(join(monitorDir, NEWTEAM_LOCK)); } catch {}
}

/** 锁新任务：先写 dir/.monitoring.log（活动锁），再删 base/.newteam.lock（write-then-delete，崩溃窗口幂等） */
function lockNewTeam(monitorDir: string, name: string): void {
  const teamPath = join(monitorDir, name);
  try { writeFileSync(join(teamPath, MONITORING_LOG), ''); } catch {}
  clearNewTeamLock(monitorDir);
}

/** 找含 .monitoring.log 的目录（mtime 最新者）用于续旧；无则返回 null */
function findMonitoringDir(monitorDir: string): string | null {
  if (!existsSync(monitorDir)) return null;
  let best: string | null = null;
  let bestMtime = -1;
  try {
    const dirs = readdirSync(monitorDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const teamPath = join(monitorDir, d.name);
      if (!existsSync(join(teamPath, MONITORING_LOG))) continue;
      let mtime = 0;
      try { mtime = statSync(teamPath).mtimeMs; } catch {}
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = d.name;
      }
    }
  } catch {}
  return best;
}

/** 计算已完成阶段（连续前缀；复用 TEAM_CREATE_STAGES） */
function computeStage(teamPath: string): number {
  let stage = 0;
  for (const s of TEAM_CREATE_STAGES) {
    if (s.check(teamPath)) stage = s.stage;
    else break;
  }
  return stage;
}

/** 由"已完成阶段"返回下一阶段提示；全部完成返回 ''（start 与 interval 共用，统一回退） */
function nextStagePrompt(completedStage: number): string {
  const next = TEAM_CREATE_STAGES.find(s => s.stage > completedStage);
  return next ? next.prompt : '';
}

/** 广播进度事件（复用：start 与 interval 共用） */
function broadcastProgress(
  broadcastSSE: (event: string, data: any) => void,
  monitorDir: string,
  teamId: string,
  stage: number
): void {
  const dir = join(monitorDir, teamId);
  const teamsoul = join(dir, '.data', TEAMSOUL_FILENAME);
  const teamRule = join(dir, '.data', TEAM_RULE_FILENAME);
  broadcastSSE('team_create_progress', {
    teamId,
    dirPath: dir,
    teamsoulPath: existsSync(teamsoul) ? teamsoul : null,
    teamRulePath: existsSync(teamRule) ? teamRule : null,
    stage,
    nextPrompt: nextStagePrompt(stage),
    stages: TEAM_CREATE_STAGES.map(s => ({ ...s, done: s.stage <= stage })),
  });
}

/** POST /api/start-team-monitor */
export function handleStartTeamMonitor(
  _req: IncomingMessage,
  res: ServerResponse,
  tm: TeamMonitorState,
  broadcastSSE: (event: string, data: any) => void
): void {
  try {
    const openclawUserDir = getOpenClawUserDir();
    const monitorDir = join(openclawUserDir, 'coordclaw-teams');

    if (!existsSync(monitorDir)) {
      try { mkdirSync(monitorDir, { recursive: true }); } catch {}
    }

    stopInterval(tm);

    let lockedTeamId = '';
    let lastCompletedStage = 0;

    // ★ 优先：base/.newteam.lock 指向的目录 = 新任务
    const newName = readNewTeamLock(monitorDir);
    if (newName) {
      const teamPath = join(monitorDir, newName);
      if (existsSync(teamPath)) {
        // 新任务：锁定并删除 base 标记
        lockNewTeam(monitorDir, newName);
        lockedTeamId = newName;
        lastCompletedStage = computeStage(teamPath);
        console.log(`[TeamMonitor] 🆕 Locked new team: ${newName} (stage ${lastCompletedStage})`);
      } else {
        // 过期标记：清理后转续旧
        console.log(`[TeamMonitor] ⚠️ .newteam.lock points to non-existent dir (${newName}), resuming stale lock`);
        clearNewTeamLock(monitorDir);
        const resume = findMonitoringDir(monitorDir);
        if (resume) {
          lockedTeamId = resume;
          lastCompletedStage = computeStage(join(monitorDir, resume));
          console.log(`[TeamMonitor] 🔄 Resume: ${resume} (stage ${lastCompletedStage})`);
        }
      }
    } else {
      // ★ 无新任务标记 → 续旧
      const resume = findMonitoringDir(monitorDir);
      if (resume) {
        lockedTeamId = resume;
        lastCompletedStage = computeStage(join(monitorDir, resume));
        console.log(`[TeamMonitor] 🔄 Resume: ${resume} (stage ${lastCompletedStage})`);
      }
    }

    tm.interval = setInterval(() => {
      try {
        if (!existsSync(monitorDir)) return;

        // ★ 每 tick 优先读 base 标记：新任务优先级最高（修复"启动后出现的锁被忽略"）
        const n = readNewTeamLock(monitorDir);
        if (n) {
          if (existsSync(join(monitorDir, n))) {
            // 新任务：锁定并删除 base 标记
            lockNewTeam(monitorDir, n);
            lockedTeamId = n;
            lastCompletedStage = 0;
            console.log(`[TeamMonitor] 🆕 Locked new team: ${n} (stage ${lastCompletedStage})`);
          } else {
            // 坏/过期标记：清理后继续（不锁定、不续旧到此）
            clearNewTeamLock(monitorDir);
            console.log(`[TeamMonitor] ⚠️ .newteam.lock points to non-existent dir (${n}), clearing stale marker`);
          }
        }

        // ★ 无当前锁定团队 → 续旧（仅当本轮未锁定新任务时）
        if (!lockedTeamId) {
          const r = findMonitoringDir(monitorDir);
          if (r) {
            lockedTeamId = r;
            lastCompletedStage = 0;
            console.log(`[TeamMonitor] 🔄 Resume: ${r}`);
          } else {
            return; // 仍无任务，下轮再试
          }
        }

        const teamPath = join(monitorDir, lockedTeamId);
        tm.teamPath = teamPath;

        // ★ 锁目录被删 → 重置锁并重分类（防卡死）
        if (!existsSync(teamPath)) {
          console.log(`[TeamMonitor] 🗑️ Monitor dir deleted: ${lockedTeamId}, resetting lock`);
          lockedTeamId = '';
          lastCompletedStage = 0;
          return;
        }

        const completedStage = computeStage(teamPath);
        if (completedStage !== lastCompletedStage) {
          lastCompletedStage = completedStage;
          broadcastProgress(broadcastSSE, monitorDir, lockedTeamId, completedStage);
          console.log(`[TeamMonitor] 📁 ${lockedTeamId} → stage ${completedStage}/${TEAM_CREATE_STAGES.length}`);
        }

        if (completedStage >= TEAM_CREATE_STAGES.length) {
          stopInterval(tm);
        }
      } catch (err) {
        console.warn('[TeamMonitor] ⚠️ Polling error:', err);
      }
    }, 2000);

    // ★ 返回响应（带回当前进度）
    const dirPath = lockedTeamId ? join(monitorDir, lockedTeamId) : null;
    const teamsoulPath = dirPath ? join(dirPath, '.data', TEAMSOUL_FILENAME) : null;
    const teamRulePath = dirPath ? join(dirPath, '.data', TEAM_RULE_FILENAME) : null;
    sendJSON(res, 200, {
      success: true,
      monitorDir,
      teamId: lockedTeamId || undefined,
      stage: lastCompletedStage || undefined,
      nextPrompt: nextStagePrompt(lastCompletedStage),
      stages: TEAM_CREATE_STAGES.map(s => ({ ...s, done: s.stage <= lastCompletedStage })),
      dirPath: dirPath || null,
      teamsoulPath: teamsoulPath && existsSync(teamsoulPath) ? teamsoulPath : null,
      teamRulePath: teamRulePath && existsSync(teamRulePath) ? teamRulePath : null,
    });
  } catch (error) {
    sendJSON(res, 500, { success: false, error: String(error) });
  }
}

/** POST /api/stop-team-monitor */
export function handleStopTeamMonitor(
  _req: IncomingMessage,
  res: ServerResponse,
  tm: TeamMonitorState
): void {
  stopInterval(tm);
  sendJSON(res, 200, { success: true });
}
