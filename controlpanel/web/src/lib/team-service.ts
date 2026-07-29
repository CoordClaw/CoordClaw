/**
 * 团队 / 项目重命名业务（公用纯函数）。
 *
 * 设计为「公用」：不依赖 ctx、不触发缓存刷新、不读单例配置，
 * 只按调用方给定的 coordclaw.json 路径做文件读写。因此可被 HTTP handler、
 * 对话指令、批量操作等多场景直接复用，也便于单元测试。
 *
 * 流程（顺序即权威）：
 *   1. 校验名称（黑名单）
 *   2. 读 coordclaw.json，定位团队
 *   3. no-op 守卫：trim 后名称相等 → 直接返回 changed:false，跳过一切读写 / 扫描 / 刷新
 *   4. 重名检测（排除自身，trim + 大小写不敏感）
 *   5. 写 coordclaw.json（teams[].name）
 *   6. 按 coordclaw.json 索引遍历该团队所有 project 的 root，
 *      同步各自 team.json 的 team_name（merge 写回，缺失文件跳过并告警）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, resolveTeamJsonPath } from '../config-resolver.js';
import { validateResourceName } from './validate.js';

export type RenameTeamCode =
  | 'OK'
  | 'EMPTY'
  | 'INVALID_CHAR'
  | 'TOO_LONG'
  | 'DUPLICATE'
  | 'NOT_FOUND';

export interface RenameTeamResult {
  ok: boolean;
  /** 是否实际发生了写入（false 表示 no-op / 失败未写） */
  changed: boolean;
  code: RenameTeamCode;
  reason?: string;
}

export interface RenameTeamParams {
  /** coordclaw.json 的绝对路径（由调用方解析，避免依赖单例，便于测试与复用） */
  coordClawPath: string;
  teamId: string;
  rawName: string;
}

interface TeamClawProject {
  id?: string;
  name?: string;
  root: string;
  status?: string;
  [key: string]: any;
}

interface TeamClawTeam {
  id: string;
  name: string;
  templatePath?: string;
  projects?: TeamClawProject[];
  [key: string]: any;
}

interface TeamClawConfig {
  teams: TeamClawTeam[];
  [key: string]: any;
}

/** 读取 JSON（自动处理 BOM 头，与 config-resolver.readJsonFileSync 语义一致） */
function readJsonFileSync(filePath: string): any {
  const raw = readFileSync(filePath, 'utf-8');
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(clean);
}

/**
 * 同步某个项目 team.json 的指定字段（merge 写回，保留其它字段）。
 * 供 renameTeam（team_name）/ renameProject（project_name）公用，避免重复造轮子。
 * @returns true=已同步，false=team.json 缺失被跳过
 */
function syncTeamJsonField(root: string, field: 'team_name' | 'project_name', value: string): boolean {
  const teamJsonPath = resolveTeamJsonPath(expandPath(root));
  if (!existsSync(teamJsonPath)) {
    console.warn(`[team-service] ⚠️ Skipping missing team.json: ${teamJsonPath}`);
    return false;
  }
  const tj = readJsonFileSync(teamJsonPath);
  tj[field] = value;
  writeFileSync(teamJsonPath, JSON.stringify(tj, null, 2), 'utf-8');
  return true;
}

/**
 * 重命名团队。
 */
export function renameTeam(params: RenameTeamParams): RenameTeamResult {
  const { coordClawPath, teamId, rawName } = params;

  // 1. 校验
  const v = validateResourceName(rawName);
  if (!v.ok) {
    return { ok: false, changed: false, code: v.code, reason: v.reason };
  }
  const norm = rawName.trim();

  // 2. 读取 coordclaw.json
  if (!existsSync(coordClawPath)) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: 'coordclaw.json 不存在' };
  }
  const config: TeamClawConfig = readJsonFileSync(coordClawPath);
  if (!Array.isArray(config.teams)) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: 'coordclaw.json 结构异常' };
  }

  // 3. 定位团队
  const team = config.teams.find((t) => t.id === teamId);
  if (!team) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: `未找到团队: ${teamId}` };
  }

  // 4. no-op 守卫：trim 后相等则不读写（权威判定，避免无效读写）
  if (team.name.trim() === norm) {
    return { ok: true, changed: false, code: 'OK' };
  }

  // 5. 重名检测（排除自身，trim + 大小写不敏感）
  const dup = config.teams.some(
    (t) => t.id !== teamId && t.name.trim().toLowerCase() === norm.toLowerCase()
  );
  if (dup) {
    return { ok: false, changed: false, code: 'DUPLICATE', reason: `名称已存在: ${norm}` };
  }

  // 6. 写 coordclaw.json
  team.name = norm;
  writeFileSync(coordClawPath, JSON.stringify(config, null, 2), 'utf-8');

  // 7. 按 coordclaw.json 索引同步全部 team.json（公用 syncTeamJsonField）
  const projects = team.projects || [];
  let synced = 0;
  let skipped = 0;
  for (const project of projects) {
    if (syncTeamJsonField(project.root, 'team_name', norm)) synced++;
    else skipped++;
  }

  return {
    ok: true,
    changed: true,
    code: 'OK',
    reason: `已重命名并同步 ${synced} 个 team.json${skipped ? `，跳过 ${skipped} 个缺失文件` : ''}`,
  };
}

export interface RenameProjectParams {
  /** coordclaw.json 的绝对路径（由调用方解析，避免依赖单例，便于测试与复用） */
  coordClawPath: string;
  teamId: string;
  projectId: string;
  rawName: string;
}

/**
 * 重命名项目。
 * 流程镜像 renameTeam，区别：
 *   - 定位对象为「团队下的某个项目」（项目唯一标识为 id）
 *   - 重名检测范围限「同团队内」（排除自身，trim + 大小写不敏感）
 *   - 仅同步「该项目自己」的 team.json 的 project_name（renameTeam 是同步整个团队所有项目的 team_name）
 */
export function renameProject(params: RenameProjectParams): RenameTeamResult {
  const { coordClawPath, teamId, projectId, rawName } = params;

  // 1. 校验
  const v = validateResourceName(rawName);
  if (!v.ok) {
    return { ok: false, changed: false, code: v.code, reason: v.reason };
  }
  const norm = rawName.trim();

  // 2. 读取 coordclaw.json
  if (!existsSync(coordClawPath)) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: 'coordclaw.json 不存在' };
  }
  const config: TeamClawConfig = readJsonFileSync(coordClawPath);
  if (!Array.isArray(config.teams)) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: 'coordclaw.json 结构异常' };
  }

  // 3. 定位团队
  const team = config.teams.find((t) => t.id === teamId);
  if (!team) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: `未找到团队: ${teamId}` };
  }

  // 4. 定位项目（项目唯一标识为 id）
  const project = (team.projects || []).find((p) => p.id === projectId);
  if (!project) {
    return { ok: false, changed: false, code: 'NOT_FOUND', reason: `未找到项目: ${projectId}` };
  }

  // 5. no-op 守卫：trim 后相等则不读写（权威判定，避免无效读写）
  if ((project.name || '').trim() === norm) {
    return { ok: true, changed: false, code: 'OK' };
  }

  // 6. 重名检测（同团队内，排除自身，trim + 大小写不敏感）
  const dup = (team.projects || []).some(
    (p) => p.id !== projectId && (p.name || '').trim().toLowerCase() === norm.toLowerCase()
  );
  if (dup) {
    return { ok: false, changed: false, code: 'DUPLICATE', reason: `团队内已存在同名项目: ${norm}` };
  }

  // 7. 写 coordclaw.json
  project.name = norm;
  writeFileSync(coordClawPath, JSON.stringify(config, null, 2), 'utf-8');

  // 8. 同步该项目 team.json 的 project_name（merge 写回，缺失跳过）
  const synced = syncTeamJsonField(project.root, 'project_name', norm);

  return {
    ok: true,
    changed: true,
    code: 'OK',
    reason: synced ? '已重命名并同步 team.json' : '已重命名（team.json 缺失，已跳过同步）',
  };
}
