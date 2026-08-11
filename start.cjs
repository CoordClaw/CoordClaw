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
const pluginDist = join(pluginDir, 'dist', 'index.js');

// ═══ 源码/产物时间戳比较：判断是否需要重新编译 ═══
// dist 已被 .gitignore 排除，git pull 不会更新它；只靠 "dist 是否存在" 判断会让
// 旧 dist 一直被复用。这里比较 "源码最新修改时间" 与 "产物时间"，源码更新则重编。
//
// 设计要点（顶层统一，避免逐产物修补）：
//  - 所有构建目标同构为 { cwd, sources[], dist }，共享同一组原语（扫描/安装/构建/导入）。
//  - 源扩展名统一为 .ts / .cjs / .mjs；显式排除 .d.ts，避免将来 tsconfig 把
//    declaration 输出落入源码树时，其 mtime ≥ dist 造成"每次启动都重编"的死循环。
const SOURCE_EXTS = ['.ts', '.cjs', '.mjs'];
const isSource = (name) =>
  !name.endsWith('.d.ts') && SOURCE_EXTS.some((e) => name.endsWith(e));

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test']);
function scanNewestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (isSource(e.name)) {
        try { const m = statSync(p).mtimeMs; if (m > newest) newest = m; } catch {}
      }
    }
  };
  walk(dir);
  return newest;
}
function needsCompile(sources, distFile) {
  if (!existsSync(distFile)) return true;
  const distMtime = statSync(distFile).mtimeMs;
  let srcMtime = 0;
  for (const d of sources) {
    const m = scanNewestMtime(d);
    if (m > srcMtime) srcMtime = m;
  }
  return srcMtime > distMtime;
}

// ═══ 统一 npm 原语 ═══
// args 为硬编码常量（'install' / 'run build'），无外部/用户输入拼接 → 无命令注入风险。
// shell:true 让 Windows cmd 可靠解析 npm.cmd，与 Linux/macOS /bin/sh 行为一致，跨平台兼容。
function runNpm(cwd, args) {
  execSync(`npm ${args}`, { cwd, stdio: 'inherit', shell: true });
}

// ═══ 读取配置 ═══
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf-8')); } catch {}
const config = { port: 18790, corsOrigin: '*', ...(pkg.config || {}) };

// ═══ 自动安装依赖 + 按需编译（同构构建目标，统一处理）═══
// plugin 产物（dist/index.js）由 OpenClaw 运行时加载；web 产物由本启动器导入启动。
const BUILD_TARGETS = [
  { name: 'plugin', cwd: pluginDir, sources: [pluginDir],                                       dist: pluginDist },
  { name: 'web',    cwd: webDir,    sources: [join(webDir, 'src'), join(webDir, 'scripts')],     dist: distPath },
];

for (const t of BUILD_TARGETS) {
  if (!existsSync(join(t.cwd, 'node_modules'))) {
    console.log(`[CoordClaw] Install ${t.name} dependencies...`);
    runNpm(t.cwd, 'install');
  }
  if (needsCompile(t.sources, t.dist)) {
    console.log(`[CoordClaw] Build ${t.name} (source changed, dist outdated)...`);
    runNpm(t.cwd, 'run build');
  }
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
