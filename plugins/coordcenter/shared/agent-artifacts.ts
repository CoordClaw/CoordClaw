/**
 * agent 级产物的路径 / 门禁 / 删除单一真相源。
 *
 * 注册侧（team-create）复用 isAutoClaw / findAutoClawSettingsPath / getLobsterAIDbPath 三门禁；
 * 删除侧（team-delete）复用 removeAgentWorkspace / removeFromAutoClawCompat / removeFromLobsterAIDB 三个 remove。
 * 抽此模块使"删 = 注册的反操作"，避免路径/门禁逻辑在两处各写一份。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { getOpenClawUserDir, getWorkspaceDirForAgent } from "./paths";
import { warn, getEventId } from "./logger";

// ==================== 门禁 / 路径（注册侧与删除侧共用） ====================

/** 当前部署是否为 AutoClaw（按 openclaw 用户目录是否含 "autoclaw" 判定） */
export function isAutoClaw(): boolean {
  return getOpenClawUserDir().toLowerCase().includes("autoclaw");
}

/** 查找 AutoClaw settings.json 路径（Windows: %APPDATA%/AutoClaw/ 或 %APPDATA%/autoclaw/） */
export function findAutoClawSettingsPath(): string | null {
  const homedir = os.homedir();
  const candidates = [
    path.join(homedir, "AppData", "Roaming", "AutoClaw", "settings.json"),
    path.join(homedir, "AppData", "Roaming", "autoclaw", "settings.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** LobsterAI SQLite 路径（与 team-create syncToLobsterAIDB 逐字符一致，删除侧必须复用，禁止内联） */
export function getLobsterAIDbPath(): string {
  return path.join(getOpenClawUserDir(), "..", "..", "lobsterai.sqlite");
}

// ==================== REMOVE 操作（删除侧复用） ====================

/**
 * 删除每个 agent 的 workspace 目录（含 SOUL.md + 会话）。
 * 不含 teamDir/worklog（那是团队配置内容拷贝，保留给用户后悔，不属 agent 运行时产物）。
 * 幂等：目录不存在时 force:true 不报错；逐项 try/catch 防 Windows 文件锁。
 */
export function removeAgentWorkspace(agentIds: string[]): void {
  for (const id of agentIds) {
    if (!id) continue;
    try {
      fs.rmSync(getWorkspaceDirForAgent(id), { recursive: true, force: true });
    } catch (e: any) {
      const eventId = getEventId();
      warn("agent-artifacts", `[workspace] 删除失败 id=${id}: ${e.message}`, eventId);
    }
  }
}

/**
 * 从 AutoClaw 兼容层移除 agent 条目（settings.json.d.agents + openclaw.runtime.json.d.agents.list）。
 * gate isAutoClaw()；按 .id 过滤（与 add 侧 buildAgentEntry 写入的 id 同键）。
 * best-effort：失败仅 warn，不阻断删除。
 */
export function removeFromAutoClawCompat(agentIds: string[]): void {
  if (!isAutoClaw() || agentIds.length === 0) return;
  const target = new Set(agentIds);
  const eventId = getEventId();

  // settings.json：d.agents 是数组
  const settingsPath = findAutoClawSettingsPath();
  if (settingsPath && fs.existsSync(settingsPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      d.agents = (d.agents || []).filter((a: any) => !target.has(a.id));
      fs.writeFileSync(settingsPath, JSON.stringify(d, null, 2), "utf-8");
    } catch (e: any) {
      warn("agent-artifacts", `[AutoClaw] settings.json 清理失败: ${e.message}`, eventId);
    }
  }

  // openclaw.runtime.json：d.agents.list 是数组（独立路径，与 add 侧一致）
  const runtimePath = path.join(getOpenClawUserDir(), "openclaw.runtime.json");
  if (fs.existsSync(runtimePath)) {
    try {
      const d = JSON.parse(fs.readFileSync(runtimePath, "utf-8"));
      d.agents = d.agents || { defaults: {}, list: [] };
      d.agents.list = (d.agents.list || []).filter((a: any) => !target.has(a.id));
      fs.writeFileSync(runtimePath, JSON.stringify(d, null, 2), "utf-8");
    } catch (e: any) {
      warn("agent-artifacts", `[AutoClaw] runtime.json 清理失败: ${e.message}`, eventId);
    }
  }
}

/**
 * 从 LobsterAI SQLite 移除 agent 行。
 * gate db 存在；prepare().run() 逐 id 删除（V14 修正：node:sqlite 的 exec 不接受参数绑定，禁 exec 带参）。
 * best-effort：失败仅 warn。
 */
export function removeFromLobsterAIDB(agentIds: string[]): void {
  if (agentIds.length === 0) return;
  const dbPath = getLobsterAIDbPath();
  if (!fs.existsSync(dbPath)) return;
  const eventId = getEventId();
  try {
    const { DatabaseSync } = require("node:sqlite") as any;
    const db = new DatabaseSync(dbPath, { open: true });
    const stmt = db.prepare("DELETE FROM agents WHERE id = ?");
    for (const id of agentIds) stmt.run(id);
    db.close();
  } catch (e: any) {
    warn("agent-artifacts", `[LobsterAI] agents 清理失败: ${e.message}`, eventId);
  }
}
