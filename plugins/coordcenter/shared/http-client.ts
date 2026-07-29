import { debug, info, warn, error, getEventId } from "./logger";
import { formatUtcToLocalHHMM } from "./time";
import {
  getCompactionConfig,
  getMsgReminderCount,
  resetMsgReminderCount,
  getLastCompactionTime,
  setLastCompactionTime,
} from "../message-routing/internal-state";
import { getSessionRecordBySessionKey } from "../message-routing/cache/manager";
import { getReceivedUnreadMessages } from "../message-routing/database/manager";
import { callGatewayRpc } from "./gateway-rpc";
import { renderTemplate } from "./template";
import { getCheckMessage } from "./message-picker";
import { AgentDispatchContext, UnreadMessageInfo } from "./types";

function resolveSessionLane(key: string): string {
  const cleaned = (key || "").trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

const COMPACTION_DEBOUNCE_MS = 5 * 60 * 1000;

function classifyMsgTag(message: string): string {
  if (message.startsWith('[工具提醒]')) return 'msg6';
  if (message.startsWith('[系统提醒]')) return 'system';
  if (message.startsWith('[任务状态提醒]')) return 'msg2';
  if (message.startsWith('[会话中止]')) return 'msg5';
  if (message.startsWith('[工作流提醒]')) return 'msg1';
  return 'unknown';
}

const rpcQueue: Array<{
  task: () => Promise<void>;
  resolve: () => void;
  reject: (err: any) => void;
  sessionKey: string;
  msgTag: string;
  enqueuedAt: number;
}> = [];
const MAX_RPC_QUEUE_SIZE = 100;
let isRpcProcessing = false;
let lastRpcSendTime = 0;
const RPC_INTERVAL_MS = 1000;

async function processRpcQueue(): Promise<void> {
  if (isRpcProcessing) return;
  isRpcProcessing = true;

  try {
    while (rpcQueue.length > 0) {
      const now = Date.now();
      const elapsed = now - lastRpcSendTime;
      if (elapsed < RPC_INTERVAL_MS && lastRpcSendTime > 0) {
        const waitTime = RPC_INTERVAL_MS - elapsed;
        debug('rpc-client', `RPC queue: waiting ${waitTime}ms before next request (queueDepth=${rpcQueue.length})`, getEventId());
        await new Promise(r => setTimeout(r, waitTime));
      }

      const item = rpcQueue.shift()!;
      lastRpcSendTime = Date.now();
      info('rpc-client', `[RPC-QUEUE] 消费 #${item.msgTag} → ${item.sessionKey.slice(0, 16)}... (队列剩余=${rpcQueue.length}, 排队等待=${Date.now() - item.enqueuedAt}ms)`, getEventId());

      try {
        await item.task();
        item.resolve();
      } catch (err: any) {
        item.reject(err);
      }
    }
  } finally {
    isRpcProcessing = false;
  }

  if (rpcQueue.length > 0) {
    processRpcQueue();
  }
}

async function sendViaRpcInternal(
  sessionKey: string,
  message: string,
  logger: any
): Promise<void> {
  const rpcStartTime = Date.now();
  const msgTag = classifyMsgTag(message);
  const messagePreview = message.length > 80 ? message.slice(0, 80) + '...' : message;
  info('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... 开始 | content="${messagePreview}"`, getEventId());

  const { getSessionQueueTracker } = await import("../message-routing/session-queue-tracker");

  const laneKey = resolveSessionLane(sessionKey);
  const cmdqSymbol = Symbol.for("openclaw.commandQueueState");
  const cmdState = (globalThis as any)[cmdqSymbol];
  const laneState = cmdState?.lanes?.get(laneKey);
  const pendingQueueSize = laneState?.queue?.length ?? 0;
  if (pendingQueueSize > 0) {
    info('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... ❌ 跳过 | LANE-BLOCKED pendingQueue=${pendingQueueSize}`, getEventId());
    throw new Error(`TOCTOU-LANE-BLOCKED: pendingQueue=${pendingQueueSize}`);
  }

  if (!getSessionQueueTracker().isIdle(sessionKey)) {
    info('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... ❌ 跳过 | TOCTOU-SKIP session not idle`, getEventId());
    throw new Error('TOCTOU-SKIP: session not idle');
  }

  // 等待进行中的 session reset 完成，避免新 dispatch 触发 session 文件冲突
  const { getResettingPromise } = await import("../session-reset/handler");
  const resetting = getResettingPromise(sessionKey);
  if (resetting) {
    info('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... ⏳ 等待 reset 完成`, getEventId());
    await resetting;
    info('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... ✅ reset 完成，继续`, getEventId());
  }

  try {
    await callGatewayRpc({
      method: "sessions.send",
      params: {
        key: sessionKey,
        message,
      },
      expectFinal: false,
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - rpcStartTime;
    info('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... ✅ 完成 | RPC OK (${elapsed}ms)`, getEventId());
  } catch (err: any) {
    const elapsed = Date.now() - rpcStartTime;
    error('rpc-client', `[RPC-SEND] #${msgTag} → ${sessionKey.slice(0, 16)}... 💥 失败 | ${err.message} (${elapsed}ms)`, getEventId());
    throw err;
  }
}

function sendViaRpc(
  sessionKey: string,
  message: string,
  logger: any
): Promise<void> {
  const msgTag = classifyMsgTag(message);

  // 队列满时，仅丢弃 msg1（任务状态提醒），msg2/msg5 不可丢
  if (rpcQueue.length >= MAX_RPC_QUEUE_SIZE) {
    if (msgTag === 'msg1' || msgTag === 'unknown') {
      debug('rpc-client', `[RPC-QUEUE] 队列已满(${rpcQueue.length})，丢弃低优先级 #${msgTag}`, getEventId());
      return Promise.resolve();
    }
    warn('rpc-client', `[RPC-QUEUE] 队列已满但仍保持关键消息 #${msgTag}`, getEventId());
  }

  return new Promise<void>((resolve, reject) => {
    rpcQueue.push({
      task: () => sendViaRpcInternal(sessionKey, message, logger),
      resolve,
      reject,
      sessionKey,
      msgTag,
      enqueuedAt: Date.now()
    });
    debug('rpc-client', `[RPC-QUEUE] 入队 #${msgTag} → ${sessionKey.slice(0, 16)}... (队列深度=${rpcQueue.length})`, getEventId());
    processRpcQueue();
  });
}

export async function maybeCompactBeforeDispatch(
  targetSessionKey: string,
  logger: any
): Promise<void> {
  const config = getCompactionConfig();
  if (!config?.enabled) return;

  const count = getMsgReminderCount(targetSessionKey);
  const countThreshold = config.msg_count_threshold ?? 20;
  let shouldCompact = count >= countThreshold;

  if (!shouldCompact) {
    const record = getSessionRecordBySessionKey(targetSessionKey);
    const startedAt = record?.startedAt;
    if (startedAt) {
      const durationMs = Date.now() - new Date(startedAt).getTime();
      const durationMin = durationMs / 60_000;
      const durationThreshold = config.window_duration_minutes ?? 25;
      if (durationMin >= durationThreshold) {
        shouldCompact = true;
        info('rpc-client', `[COMPACTION] 窗口时长 ${durationMin.toFixed(1)}min >= ${durationThreshold}min, 触发压缩 | sessionKey=${targetSessionKey.slice(0, 16)}...`, getEventId());
      }
    }
  } else {
    info('rpc-client', `[COMPACTION] msg提醒 ${count}次 >= ${countThreshold}次, 触发压缩 | sessionKey=${targetSessionKey.slice(0, 16)}...`, getEventId());
  }

  if (!shouldCompact) return;

  const lastTime = getLastCompactionTime(targetSessionKey);
  if (lastTime && (Date.now() - lastTime) < COMPACTION_DEBOUNCE_MS) {
    warn('rpc-client', `[COMPACTION] 防抖: ${Math.round((Date.now() - lastTime) / 1000)}s前刚压缩过, 跳过 | sessionKey=${targetSessionKey.slice(0, 16)}...`, getEventId());
    return;
  }

  const savedInstructions = process.env.LCM_CUSTOM_INSTRUCTIONS;
  if (config.focus_instructions) {
    process.env.LCM_CUSTOM_INSTRUCTIONS = config.focus_instructions;
    debug('rpc-client', `[COMPACTION] focus_instructions已设置 | sessionKey=${targetSessionKey.slice(0, 16)}...`, getEventId());
  }

  info('rpc-client', `[COMPACTION] 开始压缩 | sessionKey=${targetSessionKey.slice(0, 16)}...`, getEventId());
  const startTime = Date.now();

  try {
    await callGatewayRpc({
      method: "sessions.compact",
      params: { key: targetSessionKey },
      timeoutMs: 60_000,
    });
    const elapsed = Date.now() - startTime;
    setLastCompactionTime(targetSessionKey, Date.now());
    resetMsgReminderCount(targetSessionKey);
    info('rpc-client', `[COMPACTION] 压缩完成 | sessionKey=${targetSessionKey.slice(0, 16)}... | ${elapsed}ms`, getEventId());
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    error('rpc-client', `[COMPACTION] 压缩失败: ${err.message} | sessionKey=${targetSessionKey.slice(0, 16)}... | ${elapsed}ms`, getEventId());
  } finally {
    if (savedInstructions !== undefined) {
      process.env.LCM_CUSTOM_INSTRUCTIONS = savedInstructions;
    } else {
      delete process.env.LCM_CUSTOM_INSTRUCTIONS;
    }
  }
}

export async function sendTaskCompletionSignal(ctx: AgentDispatchContext): Promise<void> {
  const chainPrefix = ctx.chainId ? `[${ctx.chainId}] ` : '';
  if (ctx.pmSessionKey) {
    const msg2Raw = getCheckMessage(ctx.teamData, 'checktaskstatus', 'msg2', '无未读消息，如果团队任务完成，请汇报团队任务完成总结汇报，并请停止发送群聊消息；如果团队任务未完成，请群聊重新通知相关人员', ctx.pmSessionKey);
    const msg2 = renderTemplate(msg2Raw, ctx);
    const pmName = ctx.members?.[0]?.name || 'PM';
    debug('rpc-client', `${chainPrefix}sendTaskCompletionSignal: sending msg2 to ${pmName} (trigger=${ctx.agentName})`, getEventId());
    await sendViaRpc(ctx.pmSessionKey, `[任务状态提醒] ${msg2}`, ctx.logger);
    info('rpc-client', `${chainPrefix}sendTaskCompletionSignal: msg2 sent to ${pmName}`, getEventId());
  } else {
    warn('rpc-client', `${chainPrefix}sendTaskCompletionSignal: no PM sessionKey available (trigger=${ctx.agentName})`, getEventId());
  }
}

export async function sendT7TwoStepNotification(
  ctx: AgentDispatchContext,
  msg3: string,
  msg4: string,
  notifyFirstMember: boolean,
): Promise<void> {
  const chainPrefix = ctx.chainId ? `[${ctx.chainId}] ` : '';
  debug('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step1 - sending reminder to ${ctx.agentName} (notify_first=${notifyFirstMember})`, getEventId());
  const reminder = `[系统提醒] ${renderTemplate(msg3, ctx)}`;
  try {
    await sendViaRpc(ctx.sessionKey, reminder, ctx.logger);
    info('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step1 reminder sent to ${ctx.agentName}`, getEventId());
  } catch (err: any) {
    error('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step1 failed: ${err.message}`, getEventId());
  }

  if (!notifyFirstMember) {
    debug('rpc-client', `${chainPrefix}sendT7TwoStepNotification: notify_first_member=false, skip step2`, getEventId());
    return;
  }

  debug('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step2 - finding PM to send alert`, getEventId());
  const pm = ctx.members.find((m: any) => m.authority_level === "L4");
  if (pm?.sessionKey) {
    const alert = `[系统提示] ${renderTemplate(msg4, ctx)}`;
    try {
      await sendViaRpc(pm.sessionKey, alert, ctx.logger);
      info('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step2 alert sent to PM ${pm.name}`, getEventId());
    } catch (err: any) {
      error('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step2 failed: ${err.message}`, getEventId());
    }
  } else {
    warn('rpc-client', `${chainPrefix}sendT7TwoStepNotification: step2 skipped - no PM sessionKey found`, getEventId());
  }
}

export async function sendT7Notification(ctx: AgentDispatchContext): Promise<void> {
  const chainPrefix = ctx.chainId ? `[${ctx.chainId}] ` : '';
  const msg3 = getCheckMessage(ctx.teamData, 'checktaskfeedback', 'msg3', '你没有发送群聊消息，请执行该标准动作', ctx.sessionKey);
  const msg4 = getCheckMessage(ctx.teamData, 'checkmemberstatus', 'msg4', '<#name#>已经停止响应，但是没有进行群聊反馈信息', ctx.sessionKey);
  const notifyFirstMember = !!ctx.teamData.notify_first_member;

  debug('rpc-client', `${chainPrefix}sendT7Notification: sending T7 groupchat reminder to ${ctx.agentName} (notify_first=${notifyFirstMember})`, getEventId());
  await sendT7TwoStepNotification(
    ctx,
    msg3,
    msg4,
    notifyFirstMember,
  );
  info('rpc-client', `${chainPrefix}sendT7Notification: T7 notification completed for ${ctx.agentName}`, getEventId());
}

function formatTime(isoString: string): string {
  // 外部时间戳统一为 UTC：先解析为 UTC 绝对时刻，再按本地时区展示 HH:MM（仅展示，不用于比较）
  return formatUtcToLocalHHMM(isoString);
}

function truncateContent(text: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

function buildUnreadSummary(messages: UnreadMessageInfo[]): string {
  if (!messages || messages.length === 0) return '';
  const valid = messages.filter(m => m.sender && m.created_at);
  if (valid.length === 0) return '';
  const lines = valid.map((m, i) => {
    const time = formatTime(m.created_at);
    const sender = m.sender || '未知';
    const content = truncateContent(m.content || '', 50);
    return `${i + 1}. [${time}] ${sender}: ${content}`;
  });
  return '\n\n📋 未读消息摘要:\n' + lines.join('\n');
}

export async function sendUnreadOnlyReminder(ctx: AgentDispatchContext): Promise<void> {
  const chainPrefix = ctx.chainId ? `[${ctx.chainId}] ` : '';
  const msg1Raw = getCheckMessage(ctx.teamData, 'checkunread', 'msg1', '群聊有未读消息，请查收并执行标准操作完成任务', ctx.sessionKey);
  const msg1 = renderTemplate(msg1Raw, ctx);

  let summary = '';
  if (ctx.projectRoot) {
    try {
      const messages = await getReceivedUnreadMessages(ctx.projectRoot, ctx.agentId);
      summary = buildUnreadSummary(messages);
    } catch (err: any) {
      debug('rpc-client', `${chainPrefix}sendUnreadOnlyReminder: failed to fetch unread summary: ${err.message}`, getEventId());
    }
  }

  const fullMsg = summary ? msg1 + summary : msg1;
  debug('rpc-client', `${chainPrefix}sendUnreadOnlyReminder: sending msg1 to ${ctx.agentName}`, getEventId());
  await sendViaRpc(ctx.sessionKey, fullMsg, ctx.logger);
  info('rpc-client', `${chainPrefix}sendUnreadOnlyReminder: msg1 sent to ${ctx.agentName}`, getEventId());
}

export async function sendUnreadReminder(ctx: AgentDispatchContext): Promise<void> {
  const chainPrefix = ctx.chainId ? `[${ctx.chainId}] ` : '';
  const msg1Raw = getCheckMessage(ctx.teamData, 'checkunread', 'msg1', '群聊有未读消息，请查收并执行标准操作完成任务', ctx.sessionKey);
  const msg3Raw = getCheckMessage(ctx.teamData, 'checktaskfeedback', 'msg3', '你没有发送群聊消息，请执行该标准动作', ctx.sessionKey);
  const msg1 = renderTemplate(msg1Raw, ctx);
  const msg3 = renderTemplate(msg3Raw, ctx);

  let summary = '';
  if (ctx.projectRoot) {
    try {
      const messages = await getReceivedUnreadMessages(ctx.projectRoot, ctx.agentId);
      summary = buildUnreadSummary(messages);
    } catch (err: any) {
      debug('rpc-client', `${chainPrefix}sendUnreadReminder: failed to fetch unread summary: ${err.message}`, getEventId());
    }
  }

  const mergedMsg = `[系统提醒] ${msg1}\n\n${msg3}${summary}`;
  debug('rpc-client', `${chainPrefix}sendUnreadReminder: sending merged message (msg1+msg3) to ${ctx.agentName}`, getEventId());
  await sendViaRpc(ctx.sessionKey, mergedMsg, ctx.logger);
  info('rpc-client', `${chainPrefix}sendUnreadReminder: merged message sent to ${ctx.agentName}`, getEventId());
}

export async function sendAbortNotification(ctx: AgentDispatchContext): Promise<void> {
  const chainPrefix = ctx.chainId ? `[${ctx.chainId}] ` : '';
  const msg5Raw = getCheckMessage(ctx.teamData, 'checkdeadlockstatus', 'msg5', '当前会话已被外部中止，如果团队任务完成，请汇报总结，并停止发送群聊消息', ctx.sessionKey);
  const msg5 = renderTemplate(msg5Raw, ctx);
  debug('rpc-client', `${chainPrefix}sendAbortNotification: sending msg5 to ${ctx.agentName}`, getEventId());
  await sendViaRpc(ctx.sessionKey, `[会话中止] ${msg5}`, ctx.logger);
  info('rpc-client', `${chainPrefix}sendAbortNotification: msg5 sent to ${ctx.agentName}`, getEventId());
}

export async function sendMsg6Directly(sessionKey: string, agentName: string, msg6Content: string): Promise<void> {
  info('rpc-client', `[msg6] → ${agentName}(${sessionKey.slice(0, 16)}...) 准备发送 | content="${msg6Content.slice(0, 60)}..."`, getEventId());
  try {
    await sendViaRpc(sessionKey, `[工具提醒] ${msg6Content}`, console);
    info('rpc-client', `[msg6] → ${agentName} ✅ 已送达`, getEventId());
  } catch (err: any) {
    if (err.message === 'TOCTOU-SKIP' || err.message?.includes('cancel dispatch')) {
      info('rpc-client', `[msg6] → ${agentName} ⏭️ 跳过 | session not idle, 取消发送`, getEventId());
    } else {
      error('rpc-client', `[msg6] → ${agentName} 💥 失败 | ${err.message}`, getEventId());
    }
  }
}