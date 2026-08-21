/**
 * 配置文件统一访问层（L2）
 *
 * 职责：coordclaw.json / team.json / config.json / openclaw.json 唯一的读写封装。
 * - 路径真源来自 shared/paths.ts（不在此重复拼接）。
 * - 原子写来自 shared/json-atomic.ts 的 writeJsonSafe（含 EPERM/EBUSY 退避重试）。
 * - 项目根目录解析来自 prompt-injection 的 resolveProjectRoot（cache-refresh Layer1 单一真源）。
 *
 * 设计约束（铁律）：
 *  1. 不私藏 projectRoot 副本 —— 每次都经 resolveProjectRoot 取活值。
 *  2. 不引入镜像缓存层 —— 只读盘，缓存权威在 prompt-injection。
 *  3. 不改任何业务逻辑 —— 仅统一"从哪里读、写到哪、怎么写"。
 *  4. 返回契约：写函数返回 { ok, error }；readJsonFile 在解析/缺文件时抛错（调用方自管 try/catch）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  getCoordClawJsonPath,
  getOpenClawJsonPath,
  getTeamJsonPath,
  getTeamDataDir,
  getConfigJsonPath,
} from "./paths";
import { resolveProjectRoot } from "../prompt-injection";
import { writeJsonSafe } from "./json-atomic";
import { syncTeamData } from "./cache-coordinator";

const BOM = "﻿";
function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

// ==================== 读 ====================

/** 读取原始字符串（用于回滚快照，保留修改前原文，不解析） */
export function readConfigRaw(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

/** 统一读取 JSON 文件：去 BOM + 解析；缺文件 / 解析错误时抛错（调用方自管 try/catch） */
export function readJsonFile<T = any>(filePath: string): T {
  return JSON.parse(stripBom(fs.readFileSync(filePath, "utf-8"))) as T;
}

/** coordclaw.json；explicitPath 用于 environment 的覆盖路径（默认取真源） */
export function readCoordClawJson(explicitPath?: string): any {
  return readJsonFile(explicitPath || getCoordClawJsonPath());
}

/** openclaw.json */
export function readOpenClawJson(): any {
  return readJsonFile(getOpenClawJsonPath());
}

/** 插件配置 config.json */
export function readPluginConfig(): any {
  return readJsonFile(getConfigJsonPath());
}

/** 项目级 team.json（同步，调用方已知 projectRoot） */
export function readTeamJson(projectRoot: string): any {
  return readJsonFile(getTeamJsonPath(projectRoot));
}

/** 团队级 team.json（同步，teamId 聚合目录） */
export function readTeamJsonByTeam(teamId: string): any {
  return readJsonFile(path.join(getTeamDataDir(teamId), "team.json"));
}

/** 当前激活项目级 team.json（async，复用 Layer1 单一真源解析 projectRoot） */
export async function readActiveTeamJson(): Promise<any> {
  return readTeamJson(await resolveProjectRoot(getCoordClawJsonPath()));
}

// ==================== 写（复用 L0，保 { ok, error } 契约） ====================

/** coordclaw.json；explicitPath 用于回滚等显式路径写 */
export function writeCoordClawJson(data: unknown, explicitPath?: string): { ok: boolean; error?: string } {
  return writeJsonSafe(explicitPath || getCoordClawJsonPath(), data);
}

/** openclaw.json */
export function writeOpenClawJson(data: unknown): { ok: boolean; error?: string } {
  return writeJsonSafe(getOpenClawJsonPath(), data);
}

/** 插件配置 config.json */
export function writePluginConfig(data: unknown): { ok: boolean; error?: string } {
  return writeJsonSafe(getConfigJsonPath(), data);
}

/** 项目级 team.json 写（active-root 糖；多 root 写请直接 writeJsonSafe 显式 path） */
export function writeTeamJson(projectRoot: string, data: unknown): { ok: boolean; error?: string } {
  const r = writeJsonSafe(getTeamJsonPath(projectRoot), data);
  // 单一出口契约：落盘即同步运行时缓存与会话索引，保证最终一致。
  // syncTeamData 首步 clearLoaderCache 同步不可抛，且全程 try/catch 不 reject，
  // 故 fire-and-forget 既不会吞掉磁盘写结果，也不会产生未处理 rejection。
  if (r.ok) void syncTeamData();
  return r;
}

/** 团队级 team.json 写 */
export function writeTeamJsonByTeam(teamId: string, data: unknown): { ok: boolean; error?: string } {
  return writeJsonSafe(path.join(getTeamDataDir(teamId), "team.json"), data);
}
