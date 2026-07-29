/**
 * CoordClaw 控制面板 - 主入口
 * 
 * 启动方式：
 * 1. 直接运行: node dist/index.js
 * 2. 开发模式: tsx src/index.ts
 * 3. npm start: 使用编译后的版本
 * 
 * 环境变量：
 * - CONTROL_PANEL_PORT: 服务端口 (默认 3000)
 * - CONTROL_PANEL_USER: 当前用户名 (默认 '林锐')
 * - CORS_ORIGIN: CORS 允许的来源 (默认 '*')
 */

import { ControlPanelServer } from './server.js';
import { ConfigResolver } from './config-resolver.js';
import { initTracker, shutdownTracker } from './tracker.js';
import { drawBox } from './lib/term-box.js';
import { zh, en } from './lib/i18n-strings.js';
import { resolveDefaultLanguage } from './lib/lang.js';

// ============ 全局错误处理 ============

process.on('uncaughtException', (error) => {
  console.error('[Main] 💥 Uncaught exception:', error);
  gracefulShutdown(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] 💥 Unhandled promise rejection:', promise, 'reason:', reason);
});

// ============ 优雅关闭 ============

let serverInstance: ControlPanelServer | null = null;

async function gracefulShutdown(signal: number | string): Promise<void> {
  console.log(`\n[Main] 🛑 Received shutdown signal (${signal}), gracefully stopping...`);
  
  // ★ 上报关闭事件（fire-and-forget，不阻塞退出）
  shutdownTracker();
  
  if (serverInstance) {
    try {
      await serverInstance.stop();
    } catch (error) {
      console.error('[Main] ❌ Error stopping server:', error);
      process.exit(1);
    }
  }
  
  process.exit(0);
}

// 注册信号处理
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // kill命令

// ============ 主函数 ============

export async function main(): Promise<void> {
  const startTime = Date.now();
  
  console.log('');
  const startupLang = resolveDefaultLanguage({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, localeHint: process.env.LANG || process.env.LC_ALL || '' });
  const startupDict = startupLang === 'en' ? en : zh;
  drawBox([`  🚀 ${startupDict.banner_starting}  `]).forEach(function (line) { console.log(line); });
  console.log('');
  
  try {
    // 解析配置
    console.log('[Main] 📋 Loading configuration...');
    try {
      ConfigResolver.getInstance().resolve(true);
    } catch (configError: any) {
      if (configError.message?.includes('COORDCLAW_NOT_INSTALLED')) {
        console.log('[Main] 🔧 Not installed detected, entering install mode...');
        serverInstance = new ControlPanelServer({ skipConfig: true });
        serverInstance.isInstallMode = true;
        const url = await serverInstance.start();
        console.log(`[Main] 🔧 Install wizard started: ${url}`);
        console.log('');
        console.log('[Main] 💡 Open the above address in a browser to complete installation');
        console.log('');
        await new Promise<never>(() => {});
        return;
      }
      throw configError;
    }
    
    // 创建并启动服务器
    serverInstance = new ControlPanelServer();
    
    const url = await serverInstance.start();
    
    // ★ 初始化使用量追踪
    initTracker();
    
    const startupTime = Date.now() - startTime;
    console.log(`[Main] ✅ Startup complete! Took ${startupTime}ms`);
    console.log(`[Main] 🌐 Visit: ${url}`);
    console.log('');
    console.log('[Main] 💡 Tips:');
    console.log('   - Press Ctrl+C to stop the service');
    console.log('   - Visit /api/health for health status');
    console.log('   - Visit /api/config for configuration info');
    console.log('');
    
    // 保持进程运行
    await new Promise<never>(() => {}); // 永不 resolve
    
  } catch (error) {
    console.error('[Main] ❌ Startup failed:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('EADDRINUSE')) {
        console.error('\n[Main] 🔧 Solution:');
        console.error('   1. Change port: set CONTROL_PANEL_PORT=3001');
        console.error('   2. Or terminate the process occupying the port');
      }
      
      if (error.message.includes('COORDCLAW_NOT_INSTALLED')) {
        console.error('\n[Main] 🔧 Solution:');
        console.error('   1. Ensure CoordClaw is installed correctly');
        console.error('   2. Ensure config.json is correct (openclawUserDir / coordclawJsonPath)');
        console.error('   3. Confirm the project status is active');
      }
    }
    
    process.exit(1);
  }
}

// ============ 导出（供 OpenClaw 集成使用） ============

/**
 * 启动控制面板服务（供外部调用）
 */
export async function startControlPanel(options?: { port?: number }): Promise<string> {
  if (!serverInstance) {
    serverInstance = new ControlPanelServer(options);
    return serverInstance.start();
  }
  
  throw new Error('控制面板已在运行中');
}

/**
 * 停止控制面板服务（供外部调用）
 */
export async function stopControlPanel(): Promise<void> {
  if (serverInstance) {
    await serverInstance.stop();
    serverInstance = null;
  }
}

/**
 * 获取服务实例（用于高级操作）
 */
export function getControlPanelInstance(): ControlPanelServer | null {
  return serverInstance;
}

export { ControlPanelServer } from './server.js';

// ============ 入口点 ============

if (process.argv[1]?.endsWith('index.ts') || 
    process.argv[1]?.endsWith('index.js') ||
    import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default { startControlPanel, stopControlPanel, getControlPanelInstance };
