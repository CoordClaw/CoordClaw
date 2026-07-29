/**
 * P2a 存量迁移：将 coordclaw.json 中的 root 和 templatePath 从绝对路径转为 ~ 锚定（home 子树）。
 *
 * 幂等设计：已含 ~ 的路径自动跳过，非 home 子树路径保留绝对（J1 约束）。
 * 原子写入（writeJsonAtomic）防写中断。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCoordClawJsonPath } from "../shared/paths";
import { writeJsonSafe } from "../shared/json-atomic";
import { debug, info, warn, getEventId } from "../shared/logger";

const MODULE = "migrate";

/** 将 home 子树绝对路径锚定为 ~/relative；非 home 子树保留原文 */
function anchorToHome(abs: string): string {
  if (!abs) return abs;
  const norm = abs.replace(/\\/g, "/");
  if (norm.startsWith("~/")) return norm; // already anchored
  const home = os.homedir().replace(/\\/g, "/");
  if (norm.startsWith(home + "/") || norm === home) {
    return "~/" + norm.slice(home.length).replace(/^\//, "");
  }
  return abs; // not under home, keep as-is (J1)
}

/**
 * 执行存量迁移（幂等，可多次运行）。
 * 返回迁移数量，0 表示无需迁移（所有路径已锚定或非 home 子树）。
 */
export async function migrateCoordClawJson(): Promise<number> {
  const jsonPath = getCoordClawJsonPath();
  if (!fs.existsSync(jsonPath)) {
    debug(MODULE, "[MIGRATE] coordclaw.json 不存在，跳过", getEventId());
    return 0;
  }

  let data: any;
  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    data = JSON.parse(raw);
  } catch (err: any) {
    warn(MODULE, `[MIGRATE] coordclaw.json 读取失败，跳过: ${err.message}`, getEventId());
    return 0;
  }

  let migrated = 0;

  // Migrate projects[].root
  const teams = data.teams || [];
  for (const team of teams) {
    for (const proj of team.projects || []) {
      if (!proj.root) continue;
      const anchored = anchorToHome(proj.root);
      if (anchored !== proj.root) {
        debug(MODULE, `[MIGRATE] root: ${proj.root} → ${anchored}`, getEventId());
        proj.root = anchored;
        migrated++;
      }
    }
  }

  // Migrate teams[].templatePath
  for (const team of teams) {
    if (!team.templatePath) continue;
    const anchored = anchorToHome(team.templatePath);
    if (anchored !== team.templatePath) {
      debug(MODULE, `[MIGRATE] templatePath: ${team.templatePath} → ${anchored}`, getEventId());
      team.templatePath = anchored;
      migrated++;
    }
  }

  if (migrated === 0) {
    debug(MODULE, "[MIGRATE] 所有路径已锚定或不在 home 子树，无需迁移", getEventId());
    return 0;
  }

  const r = writeJsonSafe(jsonPath, data);
  if (!r.ok) {
    warn(MODULE, `[MIGRATE] 写入失败: ${r.error}`, getEventId());
    return 0;
  }
  info(MODULE, `[MIGRATE] ✅ 迁移完成: ${migrated} 个路径已锚定为 ~`, getEventId());

  return migrated;
}
