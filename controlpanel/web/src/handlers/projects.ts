/**
 * 项目 CRUD 处理器 — 提取自 server.ts
 * 所有 Gateway 调用统一通过 lib/gateway.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import type { AppContext } from '../lib/context.js';
import { sendJSON, parseBody } from '../lib/response.js';
import { resolveGatewayUrl, callGateway, notifyCacheRefresh } from '../lib/gateway.js';
import { resolveDatabasePath, resolveTeamJsonPath, readCoordClawJson, expandPath, resolveCoordClawJsonPath } from '../config-resolver.js';
import { renameTeam, renameProject } from '../lib/team-service.js';
import { AppError } from '../lib/errors.js';

/** POST /api/workspace-reset */
export async function handleWorkspaceReset(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const reason = data.reason || '';
    const payload: Record<string, string> = {};
    if (reason) payload.reason = reason;
    const result = await callGateway(ctx.config, '/coordclaw-plugin/coordclawcenter/workspace-reset',
      Object.keys(payload).length > 0 ? payload : undefined);
    if (!result.ok && result.status === 0) {
      throw AppError.gateway(result.data.error || '无法获取 Gateway 地址');
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.gateway('调用 Gateway 失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/create-project */
export async function handleCreateProject(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const { teamId, projectName, projectPath } = data;
    if (!teamId || !projectName || !projectPath) {
      throw AppError.validation('缺少必填参数: teamId, projectName, projectPath');
    }
    const coordclaw = readCoordClawJson();
    const team = coordclaw.teams.find((t: any) => t.id === teamId);
    const result = await callGateway(ctx.config, '/coordclaw-plugin/coordclawcenter/project-create',
      { teamId, projectName, projectPath, templatePath: team?.templatePath || '' });
    if (!result.ok && result.status === 0) {
      throw AppError.gateway(result.data.error || '无法获取 Gateway 地址');
    }
    if (result.data.success) {
      ctx.refreshConfig();
      ctx.db.reconnect(resolveDatabasePath(ctx.config.projectRoot));
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.gateway('创建项目失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/delete-project */
export async function handleDeleteProject(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const { teamId, projectId } = data;
    if (!teamId || !projectId) {
      throw AppError.validation('缺少必填参数: teamId, projectId');
    }
    const result = await callGateway(ctx.config, '/coordclaw-plugin/coordclawcenter/project-delete', { teamId, projectId });
    if (!result.ok && result.status === 0) {
      throw AppError.gateway(result.data.error || '无法获取 Gateway 地址');
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.gateway('删除项目失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/delete-team */
export async function handleDeleteTeam(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const { teamId } = data;
    if (!teamId) throw AppError.validation('缺少必填参数: teamId');
    const result = await callGateway(ctx.config, '/coordclaw-plugin/coordclawcenter/team-delete', { teamId });
    if (!result.ok && result.status === 0) {
      throw AppError.gateway(result.data.error || '无法获取 Gateway 地址');
    }
    notifyCacheRefresh(ctx.config);
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    if (result.ok) ctx.restartGateway('soft');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.gateway('删除团队失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/rename-team — 重命名团队（直接写 coordclaw.json + 同步 team.json） */
export async function handleRenameTeam(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const { teamId, newName } = data as { teamId?: string; newName?: string };
    if (!teamId || !newName) {
      throw AppError.validation('缺少必填参数: teamId, newName');
    }

    // 公用纯函数 renameTeam 负责：校验→定位→no-op 守卫→重名检测→写 coordclaw.json→同步全部 team.json
    const coordClawPath = resolveCoordClawJsonPath();
    const result = renameTeam({ coordClawPath, teamId, rawName: newName });

    if (!result.ok) {
      // 结构化业务码（EMPTY/INVALID_CHAR/TOO_LONG/DUPLICATE/NOT_FOUND）→ 前端按 code 映射 i18n
      ctx.sendJSON(res, 400, { success: false, code: result.code, error: result.reason || '重命名失败' });
      return;
    }

    // 仅当实际发生写入才刷新缓存与配置（no-op 时不刷新，避免无效副作用）
    if (result.changed) {
      notifyCacheRefresh(ctx.config);
      ctx.refreshConfig();
    }

    ctx.sendJSON(res, 200, {
      success: true,
      teamName: newName.trim(),
      changed: result.changed,
      reason: result.reason,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.validation('重命名团队失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/rename-project */
export async function handleRenameProject(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const teamId = data.teamId || '';
    const projectId = data.projectId || '';
    const newName = (data.newName || '').toString();
    if (!teamId || !projectId || !newName) {
      throw AppError.validation('缺少必填参数: teamId, projectId, newName');
    }

    // 公用纯函数 renameProject 负责：校验→定位 team→定位 project→no-op 守卫→同团队重名检测→写 coordclaw.json→同步该项目 team.json.project_name
    const coordClawPath = resolveCoordClawJsonPath();
    const result = renameProject({ coordClawPath, teamId, projectId, rawName: newName });

    if (!result.ok) {
      // 结构化业务码（EMPTY/INVALID_CHAR/TOO_LONG/DUPLICATE/NOT_FOUND）→ 前端按 code 映射 i18n
      ctx.sendJSON(res, 400, { success: false, code: result.code, error: result.reason || '重命名失败' });
      return;
    }

    // 仅当实际发生写入才刷新缓存与配置（no-op 时不刷新，避免无效副作用）
    if (result.changed) {
      notifyCacheRefresh(ctx.config);
      ctx.refreshConfig();
    }

    ctx.sendJSON(res, 200, {
      success: true,
      projectName: newName.trim(),
      changed: result.changed,
      reason: result.reason,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.validation('重命名项目失败', error instanceof Error ? error.message : String(error));
  }
}

/** POST /api/project-switch */
export async function handleSwitchProject(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const projectId = data.projectId || '';
    const teamId = data.teamId || '';
    if (!projectId || !teamId) {
      throw AppError.validation('缺少必填参数: teamId 和 projectId');
    }
    const projectsConfig = readCoordClawJson();
    let targetProject: { id: string; name: string; root: string } | null = null;
    for (const team of projectsConfig.teams) {
      const found = team.projects.find((p: any) => p.id === projectId);
      if (found) { targetProject = found; break; }
    }
    if (!targetProject) throw AppError.notFound(`未找到项目: ${projectId}`);
    const targetRoot = expandPath(targetProject.root);
    const teamJsonPath = resolveTeamJsonPath(targetRoot);
    const dbPath = resolveDatabasePath(targetRoot);
    if (!existsSync(teamJsonPath)) {
      throw AppError.notFound('目标项目 team.json 不存在');
    }
    if (!existsSync(dbPath)) {
      throw AppError.notFound('目标项目数据库不存在');
    }
    console.log(`[Server] ✅ Project switch pre-check passed: ${targetProject.name}`);

    const result = await callGateway(ctx.config, '/coordclaw-plugin/coordclawcenter/project-switch', { teamId, projectId });
    if (!result.ok) {
      throw AppError.gateway(result.data?.error || result.data?.message || 'Gateway 切换失败');
    }
    console.log(`[Server] ✅ Gateway project-switch succeeded`);
    ctx.refreshConfig();
    ctx.notifyProjectSwitched();
    notifyCacheRefresh(ctx.config);
    ctx.closeAllSSEConnectionsForSwitch();
    console.log(`[Server] 🔄 Switched project: ${projectId} → ${targetRoot}`);
    ctx.sendJSON(res, 200, { success: true, projectId, projectRoot: targetRoot, teamName: ctx.config.teamName, message: '项目切换成功' });
  } catch (error) {
    console.error('[Server] ❌ Failed to switch project:', error);
    if (error instanceof AppError) throw error;
    throw AppError.gateway('切换项目失败', error instanceof Error ? error.message : String(error));
  }
}
