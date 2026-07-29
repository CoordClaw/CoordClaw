/**
 * 文件/文件夹操作处理器 — 提取自 server.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync, spawnSync, execFile } from 'node:child_process';
import { sendJSON, parseBody } from '../lib/response.js';
import { resolveProjectRoot, resolveTeamTemplatePath, TEAMSOUL_FILENAME } from '../config-resolver.js';
import { AppError } from '../lib/errors.js';

/** 打开文件夹（跨平台·P1 execFile 防命令注入） */
export function openFolder(p: string): void {
  try {
    if (process.platform === 'win32') {
      execFile('explorer', [p]);
    } else if (process.platform === 'darwin') {
      execFile('open', [p]);
    } else {
      execFile('xdg-open', [p]);
    }
  } catch { /* 静默：打开失败不应阻断 */ }
}

/** 打开文件（跨平台·P1 execFile 防命令注入） */
export function openFile(p: string): void {
  try {
    if (process.platform === 'win32') {
      execFile('explorer', [p]);
    } else if (process.platform === 'darwin') {
      execFile('open', [p]);
    } else {
      execFile('xdg-open', [p]);
    }
  } catch { /* 静默 */ }
}

/** 打开系统文件夹/文件选择对话框（跨平台原生）。mode='file' 时选择 .tpkg 包 */
export function browseFolder(title: string = '选择文件夹', mode: 'folder' | 'file' = 'folder'): string {
  try {
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = join(
      dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'browse-folder.py'
    );
    const result = spawnSync(pythonPath, [scriptPath, title, homedir(), mode], {
      encoding: 'utf-8', timeout: 120000, windowsHide: false
    });
    if (result.error) {
      console.error('[BrowseFolder] spawn error:', result.error.message);
      return '';
    }
    return (result.stdout || '').trim();
  } catch (error) {
    console.error('[BrowseFolder] ❌ Failed to open folder picker:', error);
    return '';
  }
}

/** POST /api/open-folder */
export async function handleOpenFolder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await parseBody(req);
    const rawPath = (data.path || '');
    if (!rawPath) throw AppError.notFound('路径不存在');
    const path = resolve(rawPath);
    if (!existsSync(path)) throw AppError.notFound('路径不存在');
    openFolder(path);
    sendJSON(res, 200, { success: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.fileError('打开文件夹失败', String(error));
  }
}

/** POST /api/open-dir */
export async function handleOpenDir(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { projId } = await parseBody(req);
    const root = resolveProjectRoot(projId);
    if (!root) throw AppError.notFound(`未找到项目: ${projId}`);
    openFolder(root);
    sendJSON(res, 200, { success: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.fileError('打开项目目录失败', String(error));
  }
}

/** POST /api/open-team-dir */
export async function handleOpenTeamDir(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { teamId } = await parseBody(req);
    const tmpl = resolveTeamTemplatePath(teamId);
    if (!tmpl) throw AppError.notFound(`未找到团队: ${teamId}`);
    openFolder(tmpl);
    sendJSON(res, 200, { success: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.fileError('打开团队目录失败', String(error));
  }
}

/** POST /api/open-file */
export async function handleOpenFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await parseBody(req);
    let filePath = body.path;
    if (!filePath) {
      const { projId, subPath } = body;
      const root = resolveProjectRoot(projId);
      if (!root) throw AppError.notFound(`未找到项目: ${projId}`);
      filePath = join(root, subPath);
    }
    filePath = resolve(filePath);
    if (!existsSync(filePath)) throw AppError.notFound(`文件不存在: ${filePath}`);
    openFile(filePath);
    sendJSON(res, 200, { success: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.fileError('打开文件失败', String(error));
  }
}

/** POST /api/open-teamsoul */
export async function handleOpenTeamsoul(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleOpenTeamFile(req, res, TEAMSOUL_FILENAME);
}

/** POST /api/open-team-file */
export async function handleOpenTeamFile(req: IncomingMessage, res: ServerResponse, filename: string): Promise<void> {
  try {
    const { teamId } = await parseBody(req);
    const tmpl = resolveTeamTemplatePath(teamId);
    if (!tmpl) throw AppError.notFound(`未找到团队: ${teamId}`);
    const filePath = join(tmpl, '.data', filename);
    if (!existsSync(filePath)) throw AppError.notFound(`文件不存在: ${filePath}`);
    openFile(filePath);
    sendJSON(res, 200, { success: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.fileError('打开团队文件失败', String(error));
  }
}

/** GET /api/browse-folder */
export function handleBrowseFolder(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const title = url.searchParams.get('title') || '选择文件夹';
  const path = browseFolder(title);
  sendJSON(res, 200, { path: path || null });
}

/** GET /api/browse-file — 选择 .tpkg 团队包（复用 browse-folder.py 的 file 模式） */
export function handleBrowseFile(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const title = url.searchParams.get('title') || '选择团队包';
  const path = browseFolder(title, 'file');
  sendJSON(res, 200, { path: path || null });
}
