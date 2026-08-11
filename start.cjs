#!/usr/bin/env node
/**
 * CoordClaw 控制面板启动器
 *
 * 用法：node start.cjs
 *       npm start
 *      双击 start.bat (Windows)
 */

const { existsSync, readFileSync, statSync, readdirSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');

const rootDir = __dirname;
const webDir = join(rootDir, 'controlpanel', 'web');
const pluginDir = join(rootDir, 'plugins', 'coordcenter');
const distPath = join(webDir, 'dist', 'index.js');

// ═══ 源码/产物时间戳比较：判断是否需要重新编译 ═══
// dist 已被 .gitignore 排除，git pull 不会更新它；只靠 "dist 是否存在" 判断会让
// 旧 dist 一直被复用。这里比较 "源码最新修改时间" 与 "产物时间"，源码更新则重编。
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test']);
function dirNewestMtime(dir, ext = '.ts') {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.name.endsWith(ext)) {
        try { const m = statSync(p).mtimeMs; if (m > newest) newest = m; } catch {}
      }
    }
  };
  walk(dir);
  return newest;
}
function needsCompile(srcDirs, distFile, ext = '.ts') {
  if (!existsSync(distFile)) return true;
  const distMtime = statSync(distFile).mtimeMs;
  const srcMtime = Math.max(...srcDirs.map(d => dirNewestMtime(d, ext)));
  return srcMtime > distMtime;
}

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
if (needsCompile([pluginDir], pluginDist)) {
  console.log('[CoordClaw] Compile the plugin (source changed, dist outdated)...');
  execSync('npm run build', { cwd: pluginDir, stdio: 'inherit' });
}

// ═══ 自动构建 Web ═══
if (needsCompile([join(webDir, 'src'), join(webDir, 'scripts')], distPath)) {
  console.log('[CoordClaw] Build the control panel (source changed, dist outdated)...');
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
