/**
 * CoordClaw Center
 *
 * v19.50 — 团队协调中枢系统
 *
 * 架构：信号层 + 功能分发 + Channel 扩展
 * - 信号层：每个钩子/事件只注册一次（before_prompt_build / before_tool_call / agent_end）
 * - 功能层：各功能模块独立处理，互不干扰
 * - Channel 层：webchat Channel + webchat-widget SDK
 *
 * 功能模块（25个）：
 * - prompt-injection：规则注入（before_prompt_build → 注入通用+角色规则）
 * - message-routing：消息路由（信号状态机 + 三阶段消息分发）
 * - session-whitelist：sessionKey 白名单校验（before_tool_call）
 * - session-reset：会话重置 HTTP 路由
 * - session-delete：会话删除 HTTP 路由
 * - session-abort：会话中止 HTTP 路由（停止Agent + msg5 通知）
 * - workspace-reset：团队重置 HTTP 路由（abort→清空workspace→重建SOUL→reset）
 * - session-steer：会话引导 HTTP 路由（向运行中Agent注入消息）
 * - test-rpc：RPC 测试消息发送（Gateway RPC sessions.send）
 * - cache-refresh：缓存刷新 HTTP 路由（轻量文件重载）
 * - cache-sync：数据同步 HTTP 路由（增量运行时数据同步）
 * - session-key-generator：批量SessionKey生成 HTTP 路由
 * - session-snapshot：会话状态快照 HTTP 路由
 * - webchat：Web Chat Channel（HTTP + WebSocket 流式聊天 UI）
 * - llm-input-dump：LLM 请求导出（完整 system 提示词 + historyMessages，按 runId 分目录持久化）
 * - force-route：强制路由 HTTP 路由（跳过信号层直接触发消息分发）
 * - team-create：新建团队 HTTP 路由（两阶段团队创建流程）
 * - project-create：新建项目 HTTP 路由（模板复制 + sessionKey生成 + team.json写入）
 * - project-delete：删除项目 HTTP 路由（销毁session + 移除coordclaw.json条目）
 * - project-switch：切换激活项目 HTTP 路由（全局唯一active + team.json网关刷新）
 * - team-delete：删除团队 HTTP 路由（移除agents + 移除coordclaw.json注册）
 * - api-docs：交互式 API 文档页（服务端渲染 ROUTE_REGISTRY 数据驱动页面）
 * - webchat-widget：WebChat Widget SDK（可嵌入前端聊天组件，复用 WebSocket 协议）
 */

import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// ---- 初始化模块 ----
import { initEnvironment, type BootContext } from "./init/environment";
import type { GatewayRpcOptions } from "./shared/gateway-rpc";
import { initRoutes } from "./init/routes";
import { initBroadcast } from "./init/broadcast";

// ---- 功能模块 ----
import { resolveProjectRoot, loadProjectTeamJson } from "./prompt-injection";
import { handlePromptInjection, type PromptInjectionConfig } from "./prompt-injection";
import { isCheckEnabled, getCheckMessage } from "./shared/message-picker";
import { handleSessionWhitelist, type SessionWhitelistConfig } from "./session-whitelist";
import {
  onPromptBuild,
  onAgentEnd,
  initAgentActivity,
  onSessionIdle,
  getSessionQueueTracker,
  transitionToEnded,
  getSessionActivityCache,
  getConfig,
  globalLlmState,
} from "./message-routing";
import type { TokenUsage } from "./shared/types";
import { applyRuntimeConfig, llmErrorConfig, HEALTH_RESCUE_LIMIT } from "./shared/runtime-config";
import { deleteSnapshotFile, writeSnapshotFile, writePulseNotification } from "./session-snapshot";
import { registerLlmInputDumpHook } from "./llm-input-dump";
import { computeAndPersist, cacheSystemPrompt, setSessionApi } from "./token-stats/pool";
import { debug, info, warn, error, getEventId } from "./shared/logger";

// ==================== 模块级状态 ====================

const PLUGIN_NAME = 'CoordClaw Center';
const PLUGIN_VERSION = 'v19.50';
const PLUGIN_DESCRIPTION = 'v19.50 — 团队协调中枢系统。';

const toolCallCounts = new Map<string, number>();
const sessionToolCallCounts = new Map<string, number>();
let lifecycleListenerRegistered = false;

let pluginActivated = false;
let healthPollTimerId: ReturnType<typeof setInterval> | null = null;

// ==================== 辅助函数 ====================

function extractTokenUsage(event: any): TokenUsage | null {
  try {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg?.role === 'assistant' && msg.usage && typeof msg.usage === 'object') {
        const u = msg.usage;
        const input = u.input ?? 0;
        const output = u.output ?? 0;
        const cacheRead = u.cacheRead ?? u.cache_read ?? 0;
        const cacheWrite = u.cacheWrite ?? u.cache_write ?? 0;
        return {
          input, output, cacheRead, cacheWrite,
          total: u.total ?? (input + output + cacheRead + cacheWrite),
        };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

export function getSessionToolCount(sessionKey: string): number {
  return sessionToolCallCounts.get(sessionKey) || 0;
}

export function resetSessionToolCount(sessionKey: string): void {
  sessionToolCallCounts.delete(sessionKey);
}

export async function sendMsg6(sessionKey: string, agentId: string): Promise<void> {
  const cfg = getConfig();
  const projectRoot = await resolveProjectRoot(cfg.jsonPath, cfg.cacheTtl);
  const teamData = await loadProjectTeamJson(projectRoot, cfg.cacheTtl) as any;
  const msgRobotEnabled = teamData?.msg_robot !== false && teamData?.msg_robot !== "false";
  if (!msgRobotEnabled || !isCheckEnabled(teamData, 'checktoolcall')) return;

  const member = (teamData?.members as any[])?.find((m: any) => m.agent_id === agentId || m.sessionKey === sessionKey);
  const agentName = member?.name || agentId;
  const msg6 = getCheckMessage(teamData, 'checktoolcall', 'msg6', '你在本次会话中没有调用任何工具，请在下一次会话中积极使用工具执行实际操作。', sessionKey)
    .replace(/<#name#>/g, agentName)
    .replace(/<#projectroot#>/g, projectRoot);
  const { sendMsg6Directly } = await import("./shared/http-client");
  await sendMsg6Directly(sessionKey, agentName, msg6);
}

// ==================== Step A: 设备配对 ====================

/** 在 Gateway 启动后、Control UI 连接前，抢先建立设备配对 */
async function ensureDevicePairing(ctx: BootContext): Promise<boolean> {
  let retries = 0;
  const maxRetries = 5;
  const retryDelayMs = 500;

  while (retries < maxRetries) {
    try {
      const { callGatewayRpc } = await import("./shared/gateway-rpc");
      await callGatewayRpc({ method: "sessions.list", params: {}, timeoutMs: 5000 });
      return true;
    } catch (err: any) {
      retries++;
      const msg = err?.message || String(err);
      if (msg.includes("pairing required") || msg.includes("1008")) {
        warn("plugin", `[INIT] 设备已被抢先配对，scope 可能不足: ${msg}`, getEventId());
        return false;
      }
      if (retries < maxRetries) {
        debug("plugin", `[INIT] 抢先配对第 ${retries} 次失败，${retryDelayMs}ms 后重试: ${msg}`, getEventId());
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  warn("plugin", `[INIT] 抢先配对 ${maxRetries} 次均失败`, getEventId());
  return false;
}

// ==================== Step E: 运行时服务 ====================

/** 启动健康轮询：兜底 events 漏洞，修复卡死的 processing */
function startHealthPoll(tracker: ReturnType<typeof getSessionQueueTracker>): void {
  const HEALTH_POLL_MS = 5_000;
  const idleObservedAt = new Map<string, number>();
  const diagLoggedAt = new Map<string, number>();

  if (healthPollTimerId) clearInterval(healthPollTimerId);
  healthPollTimerId = setInterval(async () => {
    try {
      const keys = tracker.getTrackedKeys();
      if (keys.length === 0) return;
      const cache = getSessionActivityCache();
      const quietWindowMs = tracker.getIdleConfirmMs() || 3000;

      const { sessionSignals } = await import('./message-routing/internal-state');

      // health_poll 全员状态快照（每 30s 一次）
      const diagParts: string[] = [];
      const diagCycle = diagLoggedAt.get('__cycle__') || 0;
      const doDiag = Date.now() - diagCycle >= 30_000;

      for (const sk of keys) {
        const c = cache.get(sk);
        if (!c) continue;

        if (c.status === 'processing') {
          const idle = tracker.isIdle(sk);

          if (doDiag) {
            const aid = (sk.startsWith('agent:') ? sk.split(':')[1] : sk).slice(0, 12);
            const obs = idleObservedAt.get(sk);
            diagParts.push(`${aid} fixable=${c.fixable} isIdle=${idle}${obs != null ? ' idleObserved=' + obs : ''}`);
          }

          if (c.fixable === true && idle) {
            const firstSeen = idleObservedAt.get(sk);
            const now = Date.now();
            if (!firstSeen) { idleObservedAt.set(sk, now); continue; }
            if (now - firstSeen < quietWindowMs) continue;
            idleObservedAt.delete(sk);
            // L4：用缓存记录中的真实 agentId，而非切 sessionKey（canonical key=agent:main:<random>，parts[1]='main' 是 lane 标识，非真实 agentId）
            const aid = c.agentId || sk;
            await transitionToEnded(sk, aid, 'health_poll');
            info('plugin', `[HEALTH-POLL] fixed stuck processing→ended (idle ${now - firstSeen}ms): ${aid} (${++globalLlmState.rescueCount}/${HEALTH_RESCUE_LIMIT})`, getEventId());
            if (globalLlmState.rescueCount >= HEALTH_RESCUE_LIMIT && !globalLlmState.error) {
              globalLlmState.error = true;
              warn('plugin', `[HEALTH-POLL-BLOCK] 全局${globalLlmState.rescueCount}次救活，路由已阻断`, getEventId());
            }
            writeSnapshotFile(sk);
            // token-stats: 健康轮询兜底也推一次（不阻塞）
            try {
              const cached = getSessionActivityCache().get(sk);
              const sid = cached?.runs?.[cached.runs.length - 1]?.sessionId;
              if (sid && getSessionQueueTracker().isTracked(sk)) computeAndPersist(sk, sid, aid).catch((err: any) => warn('token-stats', `[HEALTH-POLL] computeAndPersist 失败: ${err?.message}`, getEventId()));
            } catch {}
          } else {
            idleObservedAt.delete(sk);
          }
        }
      }

      if (doDiag && diagParts.length > 0) {
        diagLoggedAt.set('__cycle__', Date.now());
        for (const part of diagParts) {
          debug('session-queue', `[HEALTH-POLL] ${part}`, getEventId());
        }
      }

      // 清理孤儿 signal
      try {
        for (const [sk, sig] of sessionSignals) {
          if (!cache.has(sk)) {
            if (sig.routingTimer) clearTimeout(sig.routingTimer);
            if (sig.scavengerTimer) clearTimeout(sig.scavengerTimer);
            sessionSignals.delete(sk);
          }
        }
      } catch {}

      // 针对性清理 toolCallCounts
      const activeRunIds = new Set<string>();
      for (const [, record] of cache) {
        for (const run of record.runs || []) {
          if (run.runId) activeRunIds.add(run.runId);
        }
      }
      for (const runId of toolCallCounts.keys()) {
        if (!activeRunIds.has(runId)) toolCallCounts.delete(runId);
      }

      // 运行时日志轮转
      try {
        const { rotateAllLogs } = await import('./shared/logger') as any;
        const { getCoordClawLogsDir: getLogsDir } = await import('./shared/paths') as any;
        const dir = getLogsDir?.();
        if (dir) rotateAllLogs(dir);
      } catch {}
    } catch (_) { /* 轮询非致命 */ }
  }, HEALTH_POLL_MS);
}

// ==================== 异步初始化链 ====================

/** 异步初始化：配对 → Agent注册 → 项目配置 → 活动初始化 → 运行时服务 */
async function initAsync(ctx: BootContext, api: any): Promise<void> {
  // Step A: 设备配对
  try {
    const pairingOk = await ensureDevicePairing(ctx);
    if (pairingOk) {
      info("plugin", "[INIT] 设备抢先配对成功 (operator.admin)", getEventId());
    }
  } catch (err: any) {
    warn("plugin", `[INIT] 设备配对失败（非致命）: ${err.message}`, getEventId());
  }

  // Step B: Agent 注册（发现缺失 agent → 一次写入 openclaw.json + SOUL.md）
  try {
    const { registerMissingAgents } = await import("./team-create/handler");
    const regResult = await registerMissingAgents();
    if (regResult.agentsRepaired > 0) {
      info("plugin", `[INIT] Agent 注册: missing=${regResult.agentsMissing} registered=${regResult.agentsRepaired}`, getEventId());
    }
  } catch (err: any) {
    warn("plugin", `[INIT] Agent 注册失败（非致命）: ${err.message}`, getEventId());
  }

  // Step C: 项目配置（非致命，失败不影响运行时服务启动）
  let projectRoot = "";
  let teamData: any = null;
  try {
    projectRoot = await resolveProjectRoot(ctx.jsonPath, ctx.cacheTtl);
    teamData = await loadProjectTeamJson(projectRoot, ctx.cacheTtl) as any;
    applyRuntimeConfig(teamData);

    if ((globalThis as any).__coordClawLlmInputDump?.enabled) {
      registerLlmInputDumpHook(api);
    }
    deleteSnapshotFile();
  } catch (err: any) {
    warn("plugin", `[INIT] 项目配置加载失败（非致命），运行时服务继续启动: ${err.message}`, getEventId());
  }

  // Step D: 活动初始化（非致命）
  if (projectRoot) {
    try {
      await initAgentActivity(projectRoot);
    } catch (err: any) {
      warn("plugin", `[INIT] 活动初始化失败（非致命）: ${err.message}`, getEventId());
    }
  }

  // Step E: 运行时服务（必须执行，不受前面步骤影响）
  const tracker = getSessionQueueTracker();
  const idleConfirmMs = typeof teamData?.idle_confirm_ms === "number"
    ? teamData.idle_confirm_ms : 3000;
  tracker.setIdleConfirmMs(idleConfirmMs);

  tracker.setOnIdle(async (sessionKey: string, agentId: string, endedAt?: number) => {
    await onSessionIdle(sessionKey, agentId, endedAt);
    const cache = getSessionActivityCache();
    const cached = cache.get(sessionKey);
    if (cached) {
      cached.roundIndex = (cached.roundIndex ?? 0) + 1;
      cached.updatedAt = new Date().toISOString();
      writePulseNotification("session_idle", sessionKey, cached.roundIndex);
    }
    writeSnapshotFile(sessionKey);
  });
  tracker.setTrackedSessionKeys([]);

  // 启动健康轮询（始终启动，不依赖项目配置）
  startHealthPoll(tracker);

  // 异步加载团队 sessionKeys
  import("./shared/team-loader").then(async (teamLoader) => {
    try {
      const teamContext = await teamLoader.loadTeamContext(ctx.jsonPath, ctx.cacheTtl, "session-queue");
      const sessionKeys = teamContext.members
        .map((m: any) => m.sessionKey)
        .filter((k: string) => k && k.length > 0);
      tracker.setTrackedSessionKeys(sessionKeys);
      info('plugin', `[INIT] SessionQueueTracker initialized for ${sessionKeys.length} team members`, getEventId());
    } catch (teamErr: any) {
      debug('plugin', `[INIT] Team load for session-queue tracker failed (non-fatal): ${teamErr.message}`, getEventId());
      tracker.setTrackedSessionKeys([]);
    }
  });

  info('plugin', `[INIT] plugin initialization complete`, getEventId());
}

// ==================== 信号注册 ====================

/** 安全序列化（处理循环引用/函数/BigInt），用于原始事件日志打印 */
function safeStringify(value: any): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'undefined') return '[Undefined]';
      return v;
    }, 2);
  } catch (e: any) {
    return `[safeStringify failed: ${e?.message}]`;
  }
}

/** 注册 3 个 Gateway 信号钩子：before_tool_call / before_prompt_build / agent_end */
function registerSignals(api: any, ctx: BootContext): void {
  const promptInjectionConfig: PromptInjectionConfig = { jsonPath: ctx.jsonPath, cacheTtl: ctx.cacheTtl };
  const sessionWhitelistConfig: SessionWhitelistConfig = { jsonPath: ctx.jsonPath, cacheTtl: ctx.cacheTtl };

  // 信号0: llm_input — 缓存完整 system prompt（供 token-stats 使用）
  api.on("llm_input", async (event: any, ctx: any) => {
    const agentId = ctx?.agentId || ctx?.agent_id;
    const text = event?.systemPrompt;
    if (agentId && text) cacheSystemPrompt(agentId, text);
  });

  // 信号1: before_tool_call
  api.on("before_tool_call", async (event: any, _ctx: any) => {
    const runId = _ctx?.runId || event?.runId;
    const sessionKey = _ctx?.sessionKey || event?.sessionKey;
    const identifier = runId || sessionKey;
    if (identifier) {
      toolCallCounts.set(identifier, (toolCallCounts.get(identifier) || 0) + 1);
    }
    if (sessionKey) {
      sessionToolCallCounts.set(sessionKey, (sessionToolCallCounts.get(sessionKey) || 0) + 1);
    }

    const toolName = (event.toolName as string) ?? '';
    const params = event.params as Record<string, unknown> | undefined;
    const result = await handleSessionWhitelist(toolName, params, sessionWhitelistConfig);
    if (result) return result;
    return;
  });

  // 信号2: before_prompt_build
  api.on("before_prompt_build", async (_event: any, ctx: any) => {
    const agentId = ctx.agentId;
    if (!agentId) return;

    const injectResult = await handlePromptInjection(agentId, promptInjectionConfig);

    const sessionKey = ctx?.sessionKey || ctx?.session_id;
    const runId = ctx?.runId;
    if (sessionKey) {
      await onPromptBuild(sessionKey, agentId, runId);
    }

    return injectResult;
  });

  // 信号3: agent_end
  api.on("agent_end", async (_event: any, ctx: any) => {
    const currentSessionKey = ctx.sessionKey ?? "";
    const agentId = ctx.agentId ?? "";
    const trigger = ctx?.trigger;
    const runId = ctx?.runId;

    // [LLM-RAW] agent_end 原始数据（独立日志文件 2026-07-08-plugin-llm-raw.log）
    debug('llm-raw', `[RAW agent_end event]\n${safeStringify(_event)}\n[RAW agent_end ctx]\n${safeStringify(ctx)}`);

    // 正常 agent_end → 全局标志归零（通路正常）
    globalLlmState.error = false;
    globalLlmState.rescueCount = 0;
    // [AGENT-END-ERROR] 从 agent_end 消息数组最后一个 assistant errorCode 检测 LLM 错误
    if (llmErrorConfig.enabled) {
      const msgs = _event?.messages;
      if (Array.isArray(msgs)) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const ec = msgs[i]?.errorCode;
          if (ec != null) {
            const code = Number(ec);
            if (!isNaN(code) && llmErrorConfig.endcodes.includes(code)) {
              globalLlmState.error = true;
              info('plugin', `[AGENT-END-ERROR] errorCode=${code} → globalLlmError=true`, getEventId());
            }
            break;
          }
        }
      }
    }
    // token-stats: 每轮 run 推送统计（独立异步，不阻塞）
    // projectRoot 由 computeAndPersist 内部 resolveActiveProjectRoot() 复用 cache-refresh Layer 1 单一真源解析，此处无需冗余 set
    const sessionId = ctx?.sessionId;
    if (currentSessionKey && agentId && sessionId) {
      if (getSessionQueueTracker().isTracked(currentSessionKey)) computeAndPersist(currentSessionKey, sessionId, agentId).catch((err: any) => warn('token-stats', `[AGENT-END] computeAndPersist 失败: ${err?.message}`, getEventId()));
    }
    await onAgentEnd(currentSessionKey, agentId, trigger, runId);

    // 收敛 lane：agent_end 可靠终点，主动转会 ended
    if (currentSessionKey && agentId) {
      try { await transitionToEnded(currentSessionKey, agentId, 'agent_end', runId); } catch {}
    }

    // SSE 推送成员状态
    if (currentSessionKey) {
      try { writeSnapshotFile(currentSessionKey); } catch {}
    }

    const runToolCount = (runId ? toolCallCounts.get(runId) : 0) || 0;

    if (runId && currentSessionKey) {
      try {
        const tokens = extractTokenUsage(_event);
        const cache = getSessionActivityCache();
        const cached = cache.get(currentSessionKey);
        if (cached) {
          if (!cached.runs) cached.runs = [];
          const run = cached.runs[cached.runs.length - 1];
          if (run && run.runId === runId && !run.endedAt) {
            run.endedAt = new Date().toISOString();
            run.toolCount = runToolCount;
            if (tokens) run.tokens = tokens;
            cached.totalTokens += tokens?.total ?? 0;
            cached.totalToolCalls += runToolCount;
            cached.updatedAt = new Date().toISOString();
            writePulseNotification("agent_end", currentSessionKey, cached.roundIndex);
          }
        }
      } catch (snapErr: any) {
        warn('plugin', `[AGENT-END] snapshot record failed: ${snapErr.message}`, getEventId());
      }
    }

    try { getSessionQueueTracker().onAgentEnd(currentSessionKey, agentId, runId, trigger); } catch {}

    if (runId && currentSessionKey) {
      toolCallCounts.delete(runId);
      const sessionToolCount = sessionToolCallCounts.get(currentSessionKey) || 0;
      const hasUserRun = getSessionQueueTracker().hasUserRun(currentSessionKey);
      info('plugin', `[AGENT-END] agent=${agentId} runId=${String(runId).slice(0, 8)} trigger=${trigger} runToolCount=${runToolCount} sessionToolCount=${sessionToolCount} hasUserRun=${hasUserRun}`, getEventId());
    }
  });

  api.on("llm_output", async (event: any, ctx: any) => {

    // [LLM-RAW] llm_output 原始数据（独立日志文件 2026-07-08-plugin-llm-raw.log）
    debug('llm-raw', `[RAW llm_output event]\n${safeStringify(event)}\n[RAW llm_output ctx]\n${safeStringify(ctx)}`);
  });

  // 信号4: lifecycle — 旧版回退保留，仅 dump 观测，不参与状态判断
  try {
    if (lifecycleListenerRegistered) { /* already registered */ }
    else if (typeof api?.runtime?.events?.onAgentEvent === "function") {
      lifecycleListenerRegistered = true;
      api.runtime.events.onAgentEvent(async (evt: any) => {
      });
    }
  } catch { /* lifecycle 监听注册失败不影响主流程 */ }
}

// ==================== 插件入口 ====================

export default {
  id: "coordclawcenter",
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: emptyPluginConfigSchema,
  register(api: any) {
    // ---- 同步阶段 ----
    setSessionApi(api.runtime?.agent?.session);       // 注入框架会话 API，供 token-stats 直接取 sessionFile（与 setWebchatRuntime 对称）
    const ctx: BootContext = initEnvironment(api);   // Step 1: 环境引导（异步链 fire-and-forget，不阻塞路由注册）
    initRoutes(api, ctx);                              // Step 2: HTTP 路由
    registerSignals(api, ctx);                         // Step 4: 信号注册
    initBroadcast(api, ctx);                           // Step 5: 广播

    // LLM hook（reload-safe）
    if ((globalThis as any).__coordClawLlmInputDump?.enabled) {
      registerLlmInputDumpHook(api);
      debug('plugin', `[INIT] llm_input_dump: hook registered (reload-safe)`, getEventId());
    }

    // ---- 异步阶段 ----
    if (!pluginActivated) {
      pluginActivated = true;
      initAsync(ctx, api);
    }
  },
};
