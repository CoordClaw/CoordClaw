/**
 * team.json 读写工具 — 从 server.ts 提取
 */

import { writeFileSync } from 'node:fs';
import { resolveTeamJsonPath, ConfigResolver, readJsonFileSync } from '../config-resolver.js';

/** 读取 team.json */
export function readTeamJson(projectRoot: string): any {
  const teamJsonPath = resolveTeamJsonPath(projectRoot);
  return readJsonFileSync(teamJsonPath);
}

/** 写入 team.json 并清除配置缓存 */
export function writeTeamJson(projectRoot: string, data: any): void {
  const teamJsonPath = resolveTeamJsonPath(projectRoot);
  writeFileSync(teamJsonPath, JSON.stringify(data, null, 2), 'utf-8');
  ConfigResolver.getInstance().clearCache();
  console.log(`[TeamJson] ✅ Updated ${teamJsonPath}`);
}
