#!/usr/bin/env node
/**
 * CoordClaw 控制面板启动器
 *
 * 用法：node start.cjs
 *       npm start
 *      双击 start.bat (Windows)
 */

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');

const rootDir = __dirname;
const webDir = join(rootDir, 'controlpanel', 'web');
const pluginDir = join(rootDir, 'plugins', 'coordcenter');
const distPath = join(webDir, 'dist', 'index.js');

// ═══ 读取配置 ═══
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf-8')); } catch {}
const version = pkg.version || '2.3';
const config = { port: 18790, corsOrigin: '*', ...(pkg.config || {}) };

// ═══ 自动安装 Web 依赖 ═══
const webNodeModules = join(webDir, 'node_modules');
if (!existsSync(webNodeModules)) {
  console.log('[CoordClaw] Install web dependencies...');
  execSync('npm install', { cwd: webDir, stdio: 'inherit' });
}

// ═══ 自动安装并编译插件 ═══
const pluginNodeModules = join(pluginDir, 'node_modules');
const pluginDist = join(pluginDir, 'dist', 'index.js');
if (!existsSync(pluginNodeModules)) {
  console.log('[CoordClaw] Install plugin dependencies...');
  execSync('npm install', { cwd: pluginDir, stdio: 'inherit' });
}
if (!existsSync(pluginDist)) {
  console.log('[CoordClaw] Compile the plugin...');
  execSync('npm run build', { cwd: pluginDir, stdio: 'inherit' });
}

// ═══ 自动构建 Web ═══
if (!existsSync(distPath)) {
  console.log('[CoordClaw] Build the control panel...');
  execSync('npm run build', { cwd: webDir, stdio: 'inherit' });
}

// ═══ 启动 ═══
process.env.CONTROL_PANEL_PORT = process.env.CONTROL_PANEL_PORT || String(config.port);
process.env.CONTROL_PANEL_USER = process.env.CONTROL_PANEL_USER || config.user || 'admin';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || config.corsOrigin || '*';

import(pathToFileURL(distPath).href).then(mod => {
  mod.main();
}).catch(err => {
  console.error('[CoordClaw] Startup failed:', err.message);
  process.exit(1);
});
