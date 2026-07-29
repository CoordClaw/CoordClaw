/**
 * Gateway 消息桥接 — chat.send RPC 发送 + chat.history 轮询模拟流式
 *
 * 不依赖 runtime.channel.reply 内部 API，全走已验证的公共 RPC
 */

import { buildChatSendParams } from "./chat-send";

export type StreamCallbacks = {
  /** 增量文本（delta），由各消费方自行拼接累积 */
  onPartialReply?: (delta: string) => void;
  onReply?: (text: string) => void;
  onIdle?: () => void;
  onError?: (err: string) => void;
};

const POLL_INTERVAL = 500;        // 轮询间隔 ms
// 终止条件（仅两条，极简）：
//   ① Gateway 显式 stopReason === "stop" —— 唯一业务终止
//   ② 前端 TCP 断开（isAborted 谓词）—— 连接都没了，停止推送
// 不依赖任何超时机制；RPC 瞬时错误忽略并继续轮询。

export function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text")
      .map((c: any) => c.text || "")
      .join("\n");
  }
  return "";
}

type RpcFn = (req: { method: string; params?: any; timeoutMs?: number }) => Promise<any>;

export async function sendToGateway(
  text: string,
  sessionKey: string,
  callbacks: StreamCallbacks,
  rpc?: RpcFn,
  isAborted?: () => boolean,
): Promise<void> {
  const callGatewayRpc: RpcFn = rpc ?? (await import("../shared/gateway-rpc")).callGatewayRpc;

  // 1. sessions.create → 确保 session 存在
  try {
    await callGatewayRpc({
      method: "sessions.create",
      params: { agentId: sessionKey, label: "webchat" },
      timeoutMs: 10_000,
    });
  } catch { /* ok if exists */ }

  // 2. chat.send → ACK（捕获失败，便于兜底回读已有完整对话，绝不丢失前端应得的回复）
  let sendErr: string | null = null;
  try {
    const sendResult = await callGatewayRpc({
      method: "chat.send",
      params: buildChatSendParams(sessionKey, text),
      timeoutMs: 15_000,
    });
    if (!sendResult?.runId) {
      sendErr = "chat.send rejected: no runId";
    }
  } catch (err: any) {
    sendErr = err?.message || String(err);
  }

  if (sendErr) {
    // 兜底：会话可能已结束/不可投递，但历史里可能已有完整回复 —— 把它推给前端
    try {
      const hist = await callGatewayRpc({
        method: "chat.history",
        params: { sessionKey, limit: 10 },
        timeoutMs: 5_000,
      });
      const messages: any[] = Array.isArray(hist?.messages) ? hist.messages : [];
      const lastMsg = messages.filter((m: any) => m.role === "assistant").pop();
      const content = lastMsg ? extractText(lastMsg.content) : "";
      if (content) {
        callbacks.onPartialReply?.(content); // 无历史部分，整段作为首段增量
        callbacks.onReply?.(content);
        callbacks.onIdle?.();
        return;
      }
    } catch { /* 回读失败，落到下面的 onError */ }
    callbacks.onError?.(sendErr);
    return;
  }

  // 3. chat.history 轮询 → 模拟流式
  let lastText = "";
  let replyText = "";
  let finished = false;

  const poll = async () => {
    try {
      const result = await callGatewayRpc({
        method: "chat.history",
        params: { sessionKey, limit: 10 },
        timeoutMs: 5_000,
      });
      const messages: any[] = Array.isArray(result?.messages) ? result.messages : [];

      // 取最后一条 assistant 消息
      const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];

      if (lastMsg) {
        const content = extractText(lastMsg.content);
        replyText = content;

        if (content !== lastText) {
          const delta = content.slice(lastText.length);
          lastText = content;
          if (delta) callbacks.onPartialReply?.(delta); // 增量，由各消费方自行拼接
        }

        // 完成判定：① Gateway 显式 stopReason === "stop"（唯一业务终止）
        const hasStop = lastMsg.stopReason === "stop";
        if (hasStop) {
          finished = true;
          callbacks.onReply?.(replyText);
          callbacks.onIdle?.();
          return;
        }
      }
      // 无 assistant 消息（模型尚未开始 / 生成中占位）：继续轮询，等 stop 或前端断开，不做超时判定
    } catch (err: any) {
      // 瞬时 RPC 抖动：忽略并继续轮询，等 stop 或 TCP 断
    }
  };

  while (!finished) {
    // ② 前端 TCP 断开：立即停止轮询，不再回调
    if (isAborted?.()) {
      finished = true;
      break;
    }
    await poll();
    if (!finished) await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}
