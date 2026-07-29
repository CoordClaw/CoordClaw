import http from "node:http";
import crypto from "node:crypto";

import { getWebchatPageHtml } from "./html";
import { getEventId } from "../shared/logger";
import { readRawBody } from "../shared/http-helpers";
import { DEFAULT_AGENT, FIRST_BYTE_MS } from "./http-stream";
import { buildChatSendParams } from "./chat-send";

// 模块级 logger：由 startGateway(params.log) 注入，供 generate()/onFrame() 等模块级函数共享。
// 未注入时为 undefined，配合 ?. 短路调用，避免 "log is not defined" ReferenceError（原 bug）。
let log: any;

// WS 连接 socket 类型：upgrade 回调给出的 socket 被 node:http 标为 Duplex（运行时实是 net.Socket，Duplex 子类）。
// 统一用 Duplex，避免 Duplex 不可赋 Socket 的 8 处类型冲突；函数仅用 write/once/on/end（均 Duplex 具备）。
type WsSocket = import("node:stream").Duplex;

let _runtime: any = null;
export function setWebchatRuntime(runtime: any) {
  _runtime = runtime;
  (globalThis as any).__coordclawRuntime = runtime;  // 供 config-writer 复用
}
/** 实际监听端口（auto-port fallback 后可能与配置不同） */
export let actualWebchatPort = 0;
export function getActualWebchatPort() { return actualWebchatPort; }
function getRuntime() {
  return _runtime;
}

/** 从 Gateway 拉取会话历史，WebSocket 和 HTTP 共用 */
async function fetchChatHistory(sessionKey: string): Promise<{ messages: any[]; error?: string }> {
  const { callGatewayRpc } = await import("../shared/gateway-rpc");
  const result = await callGatewayRpc({
    method: "chat.history",
    params: { sessionKey, limit: 100 },
    timeoutMs: 10_000,
  });
  return { messages: (result && result.messages) ? result.messages : [] };
}

interface ConnectedClient {
  socket: WsSocket;
  sessionKey: string;
  label?: string;
  lastPartialText: string;
}

const clients = new Map<string, ConnectedClient>();

/** 当前活跃的 HTTP server（关闭旧实例避免端口泄漏） */
let _server: http.Server | null = null;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function generateAcceptKey(clientKey: string): string {
  return crypto
    .createHash("sha1")
    .update(clientKey + WEBSOCKET_GUID)
    .digest("base64");
}

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const len = payload.length;

  let frame: Buffer;
  if (len < 126) {
    frame = Buffer.alloc(2 + len);
    frame[0] = 0x81;
    frame[1] = len;
    payload.copy(frame, 2);
  } else if (len < 65536) {
    frame = Buffer.alloc(4 + len);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.alloc(10 + len);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    payload.copy(frame, 10);
  }
  return frame;
}

function onFrame(socket: WsSocket, onText: (text: string) => void | Promise<void>): void {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let payloadLen = buffer[1] & 0x7f;

      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const frameLen = offset + maskLen + payloadLen;
      if (buffer.length < frameLen) return;

      if (opcode === 0x08) {
        socket.end();
        return;
      }

      if (masked) {
        const mask = buffer.slice(offset, offset + 4);
        offset += 4;
        for (let i = 0; i < payloadLen; i++) {
          buffer[offset + i] ^= mask[i % 4];
        }
      }

      const payload = buffer.slice(offset, offset + payloadLen);

      if (opcode === 0x01 || opcode === 0x00) {
        const result = onText(payload.toString("utf-8"));
        if (result && typeof (result as any).catch === "function") {
          (result as Promise<void>).catch((e: any) => {
            log?.error(`[webchat] onText handler error: ${e?.message || e}`, getEventId());
          });
        }
      }

      buffer = buffer.slice(frameLen);
    }
  });
}

function sendFrame(socket: WsSocket, text: string): void {
  try {
    socket.write(encodeFrame(text));
  } catch {}
}

// ==================== 降级与生成逻辑（§11.2 简化版 + §13 降级切换） ====================

/** per-session inflight 守卫 —— 同 key 在飞则拒（砍E：简单 Set） */
const inflight = new Set<string>();

/** 兜底轮询硬上限：杜绝 send 失败后 while(true) 永久挂起 + inflight 会话锁死（防御纵深，可调） */
const MAX_FALLBACK_MS = 5 * 60 * 1000;

/**
 * 非流式 RPC 兜底：chat.send → 轮询 chat.history 直到 stop → join 全文（砍B）
 * 复用 R2(callGatewayRpc)、R3(fetchChatHistory)、R4(extractText)
 */
async function rpcFallbackFull(
  text: string,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<string> {
  // 前端已断开则不发无谓的 chat.send（省一个 agent run）
  if (signal?.aborted) return "";

  const { callGatewayRpc } = await import("../shared/gateway-rpc");
  const { extractText } = await import("./gateway-ws");

  // baseline: 记录 send 前最后一条 assistant 消息的 seq
  let baseSeq = -1;
  try {
    const hist = await callGatewayRpc({
      method: "chat.history",
      params: { sessionKey, limit: 100 },
      timeoutMs: 10_000,
    });
    const msgs: any[] = Array.isArray(hist?.messages) ? hist.messages : [];
    const lastAsst = msgs.filter((m: any) => m.role === "assistant").pop();
    if (lastAsst?.__openclaw?.seq !== undefined) {
      baseSeq = lastAsst.__openclaw.seq;
    }
  } catch { /* baseline 取不到也继续 */ }

  // chat.send（失败 = 未入队 = 真失败，必须 fail-fast 上抛，由 generate 的 catch(e2) 转 onError）
  await callGatewayRpc({
    method: "chat.send",
    params: buildChatSendParams(sessionKey, text),
    timeoutMs: 15_000,
  });

  // 轮询直到 stop（受前端断开 + 硬上限约束，杜绝永久挂起）
  const POLL_MS = 500;
  const deadline = Date.now() + MAX_FALLBACK_MS;
  while (true) {
    if (signal?.aborted) throw new Error("client aborted");
    if (Date.now() > deadline) throw new Error("fallback timeout");
    try {
      const hist = await callGatewayRpc({
        method: "chat.history",
        params: { sessionKey, limit: 100 },
        timeoutMs: 10_000,
      });
      const msgs: any[] = Array.isArray(hist?.messages) ? hist.messages : [];
      const assistantMsgs = msgs.filter((m: any) =>
        m.role === "assistant" && ((m.__openclaw?.seq ?? -1) > baseSeq),
      );
      const last = assistantMsgs[assistantMsgs.length - 1];
      if (last && last.stopReason === "stop") {
        return assistantMsgs.map((m: any) => extractText(m.content)).join("\n");
      }
    } catch { /* 瞬时 RPC 错误，继续轮询 */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * 统一生成入口（三端点共用）
 *
 * - 主路径：Gateway HTTP SSE 真·逐 token 流式
 * - 兜底：非流式 RPC（仅在首包前失败且非 402/401 时触发，V19/V20/V21/V22）
 * - 并发锁：per-session inflight Set（砍E）
 */
async function generate(
  sessionKey: string,
  text: string,
  sink: (content: string) => void,
  opts: {
    clientSignal?: AbortSignal;
    onDone?: () => void;
    onError?: (err: string) => void;
  },
): Promise<void> {
  if (inflight.has(sessionKey)) {
    opts.onError?.("generating");
    return;
  }
  inflight.add(sessionKey);

  const gatewayAbort = new AbortController();
  const firstByteTimer = setTimeout(() => gatewayAbort.abort(), FIRST_BYTE_MS);

  // 前端 TCP 断 → 真停 Gateway run（S2）
  if (opts.clientSignal) {
    const onAbort = () => gatewayAbort.abort();
    opts.clientSignal.addEventListener("abort", onAbort, { once: true });
  }

  let started = false;

  try {
    const { fetchGatewaySSE, parseSSEDelta } = await import("./http-stream");
    const res = await fetchGatewaySSE(text, sessionKey, gatewayAbort.signal);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // 保留最后一个不完整行
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const delta = parseSSEDelta(line);
          if (delta !== null) {
            if (!started) {
              started = true;
              clearTimeout(firstByteTimer);
            }
            sink(delta);
          }
        }
      }
    }

    // 处理结尾 buffer（flush 最后的 line）
    if (buffer.startsWith("data: ")) {
      const delta = parseSSEDelta(buffer);
      if (delta !== null) {
        if (!started) {
          started = true;
          clearTimeout(firstByteTimer);
        }
        sink(delta);
      }
    }

    clearTimeout(firstByteTimer);
    opts.onDone?.();
  } catch (e: any) {
    gatewayAbort.abort();     // V21：永远先杀 Gateway run，杜绝双生成
    clearTimeout(firstByteTimer);

    // 额度/鉴权不降级（砍A）
    if (e.status && [402, 401].includes(e.status)) {
      opts.onError?.(`Gateway HTTP ${e.status} (${e.status === 402 ? "额度不足" : "鉴权失败"})`);
      return;
    }

    // post-200 中断只报错，绝不 RPC 双生成（V19）
    if (started) {
      opts.onError?.(e.message || String(e));
      return;
    }

    // —— 降级区：仅 pre-首包失败才到此 ——
    log?.info(`[webchat] Degrading to RPC fallback for ${sessionKey.slice(0, 40)} (${e.message || e})`, getEventId());
    try {
      const full = await rpcFallbackFull(text, sessionKey, opts.clientSignal);
      sink(full);
      opts.onDone?.();
    } catch (e2: any) {
      opts.onError?.(e2.message || String(e2));  // V22：兜底也失败 → 报错
    }
  } finally {
    clearTimeout(firstByteTimer);
    inflight.delete(sessionKey);
  }
}

// ==================== HTTP Server ====================

export async function startGateway(params: {
  account: { accountId: string; port: number };
  abortSignal: AbortSignal;
  cfg: any;
  log?: any;
  onReady: () => void;
  onError: (error: Error) => void;
}) {
  const { account, abortSignal, cfg: inputCfg, log: paramLog, onReady, onError } = params;
  log = paramLog;  // 注入模块级 logger（generate/onFrame 共享）

  let effectiveCfg = inputCfg;
  if (!effectiveCfg || Object.keys(effectiveCfg).length === 0) {
    const rt = getRuntime();
    if (rt?.config?.loadConfig) {
      try {
        effectiveCfg = rt.config.loadConfig();
        log?.info(`[webchat] Loaded full config via runtime.config.loadConfig(), keys=${Object.keys(effectiveCfg || {}).join(",")}`);
      } catch (cfgErr: any) {
        log?.warn(`[webchat] runtime.config.loadConfig() failed: ${cfgErr.message}, using empty cfg`);
      }
    }
  }
  const cfg = effectiveCfg;
  const PORT = account.port;

  const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  function jsonRes(res: http.ServerResponse, status: number, data: any) {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify(data));
  }

  let _sseEventId = 0;
  function sseRes(res: http.ServerResponse, event: string, data: string) {
    _sseEventId++;
    const lines = data.split("\n");
    let msg = "";
    for (const line of lines) {
      msg += `data: ${line}\n`;
    }
    if (event) {
      msg += `event: ${event}\n`;
    }
    msg += `id: ${_sseEventId}\n\n`;
    res.write(msg);
  }

  // 关闭上一次遗留的 server
  if (_server) {
    const addr = _server.address();
    if (addr && typeof addr === "object" && (addr as any).port === PORT) {
      onReady?.();
      if (!abortSignal.aborted) {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return;
    }
    log?.info(`[webchat] Closing previous server...`);
    await new Promise<void>(resolve => _server!.close(() => resolve()));
    _server = null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getWebchatPageHtml());
      return;
    }
    if (pathname === "/health") {
      jsonRes(res, 200, { ok: true, clients: clients.size });
      return;
    }
    if (pathname === "/config") {
      const webchatCfg = cfg?.channels?.webchat || {};
      jsonRes(res, 200, {
        ok: true,
        webchatUrl: `http://${req.headers.host || "localhost:3210"}`,
        css: webchatCfg.css || {},
        cssText: webchatCfg.cssText || "",
        title: webchatCfg.title || "",
        placeholder: webchatCfg.placeholder || "",
      });
      return;
    }

    if (pathname === "/api/history" && req.method === "GET") {
      const sk = url.searchParams.get("sessionKey");
      if (!sk) {
        jsonRes(res, 400, { ok: false, error: "sessionKey is required" });
        return;
      }
      try {
        const { messages, error } = await fetchChatHistory(sk);
        jsonRes(res, 200, { ok: true, sessionKey: sk, messages, error });
      } catch (err: any) {
        jsonRes(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    // ===== /api/send (POST) — 非流式：收集全文后 JSON 返回（向后兼容） =====
    if (pathname === "/api/send" && req.method === "POST") {
      let body: any;
      try {
        const raw = await readRawBody(req);
        body = JSON.parse(raw);
      } catch {
        jsonRes(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }
      const text = (body.text || "").trim();
      if (!text) {
        jsonRes(res, 400, { ok: false, error: "text is required" });
        return;
      }
      const explicitSessionKey = body.sessionKey;
      const sessionKey = explicitSessionKey || `agent:${DEFAULT_AGENT}:http:${Date.now().toString(36)}`;

      let replyText = "";
      let finished = false;
      const done = new Promise<void>((resolve) => {
        const finish = () => { if (!finished) { finished = true; resolve(); } };
        (res as any)._finishOnce = finish;
      });
      req.on("close", () => { (res as any)._finishOnce?.(); });

      const clientAbort = new AbortController();
      req.on("close", () => clientAbort.abort());

      await generate(sessionKey, text,
        (delta) => { replyText += delta; },
        {
          clientSignal: clientAbort.signal,
          onDone: () => { (res as any)._finishOnce?.(); },
          onError: (err) => {
            if (!res.headersSent) jsonRes(res, 500, { ok: false, error: err, sessionKey });
            (res as any)._finishOnce?.();
          },
        },
      );

      await done;
      if (res.headersSent) return;
      jsonRes(res, 200, { ok: true, reply: replyText, sessionKey });
      return;
    }

    // ===== /api/stream (GET) — 流式 SSE（向后兼容 query param） =====
    if (pathname === "/api/stream" && (req.method === "GET" || req.method === "POST")) {
      let text = "";
      let explicitSessionKey: string | undefined;

      if (req.method === "POST") {
        try {
          const raw = await readRawBody(req);
          const body = JSON.parse(raw);
          text = (body.text || "").trim();
          explicitSessionKey = body.sessionKey;
        } catch {
          jsonRes(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
      } else {
        text = (url.searchParams.get("text") || "").trim();
        explicitSessionKey = url.searchParams.get("sessionKey") || undefined;
      }

      if (!text) {
        jsonRes(res, 400, { ok: false, error: "text is required" });
        return;
      }
      const sessionKey = explicitSessionKey || `agent:${DEFAULT_AGENT}:sse:${Date.now().toString(36)}`;
      const label = url.searchParams.get("label") || "webchat-sse";

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      });
      sseRes(res, "connected", JSON.stringify({ sessionKey, label }));

      let finished = false;
      const done = new Promise<void>((resolve) => {
        const finish = () => { if (!finished) { finished = true; resolve(); } };
        (res as any)._finishOnce = finish;
      });
      req.on("close", () => { (res as any)._finishOnce?.(); });

      const clientAbort = new AbortController();
      req.on("close", () => clientAbort.abort());

      await generate(sessionKey, text,
        (delta) => {
          try { sseRes(res, "streaming", delta); } catch { clientAbort.abort(); }
        },
        {
          clientSignal: clientAbort.signal,
          onDone: () => {
            try { sseRes(res, "done", "[DONE]"); } catch {}
            (res as any)._finishOnce?.();
          },
          onError: (err) => {
            try { sseRes(res, "error", err); } catch {}
            (res as any)._finishOnce?.();
          },
        },
      );

      await done;
      res.end();
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });
  _server = server;

  server.on("upgrade", (req, socket, head) => {
    log?.info(`[webchat] UPGRADE request: ${req.method} ${req.url} host=${req.headers.host} origin=${req.headers.origin || "none"} ua=${(req.headers["user-agent"] || "").slice(0, 80)}`);
    const clientKey = req.headers["sec-websocket-key"];
    if (!clientKey) {
      log?.info(`[webchat] UPGRADE rejected: no sec-websocket-key`);
      socket.destroy();
      return;
    }

    const acceptKey = generateAcceptKey(clientKey);
    const clientId = `web:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

    const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);
    const querySessionKey = url.searchParams.get("sessionKey") || undefined;
    const queryLabel = url.searchParams.get("label") || undefined;

    const sessionKey = querySessionKey || `agent:${DEFAULT_AGENT}:${clientId}`;

    clients.set(clientId, { socket, sessionKey, label: queryLabel, lastPartialText: "" });
    let clientGone = false;
    socket.once("close", () => { clientGone = true; });

    log?.info(`[webchat] Client connected: ${clientId}, sessionKey=${sessionKey} (total: ${clients.size})`);

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    );

    const webchatCfg = cfg?.channels?.webchat || {};

    sendFrame(socket, JSON.stringify({
      type: "connected",
      clientId,
      sessionKey,
      runtimeReady: true,
      css: webchatCfg.css || {},
      cssText: webchatCfg.cssText || "",
    }));

    // clientSignal for generate(): TCP 断即停 Gateway run（S2）
    const clientAbort = new AbortController();
    socket.once("close", () => clientAbort.abort());

    onFrame(socket, async (rawText: string) => {
      let data: { text?: string; type?: string; sessionKey?: string } = {};
      try {
        data = JSON.parse(rawText);
      } catch (parseErr: any) {
        sendFrame(socket, JSON.stringify({ type: "error", text: "Invalid JSON: " + parseErr.message }));
        return;
      }

      const text = data.text?.trim();

      // 历史消息请求
      if (data.type === "history") {
        const client = clients.get(clientId);
        const sk = data.sessionKey || (client ? client.sessionKey : sessionKey);
        try {
          const { messages, error } = await fetchChatHistory(sk);
          sendFrame(socket, JSON.stringify({ type: "history", sessionKey: sk, messages, error }));
        } catch (err: any) {
          sendFrame(socket, JSON.stringify({ type: "history", sessionKey: sk, messages: [], error: err.message }));
        }
        return;
      }

      if (!text) {
        sendFrame(socket, JSON.stringify({ type: "debug", text: "[diag] empty text, raw=" + JSON.stringify(data).slice(0, 200) }));
        return;
      }

      const client = clients.get(clientId);
      if (!client) {
        sendFrame(socket, JSON.stringify({ type: "error", text: "Client not found in map" }));
        return;
      }

      const effectiveSessionKey = data.sessionKey || client.sessionKey;
      log?.info(`[webchat] ${clientId} → generate (sessionKey=${effectiveSessionKey.slice(0, 40)}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

      // M3：会话创建只在 generate() 内（经 chat.send / HTTP key），删独立 sessions.create
      await generate(effectiveSessionKey, text,
        (delta: string) => {
          if (clientGone) return;
          const c = clients.get(clientId);
          if (!c) return;
          sendFrame(c.socket, JSON.stringify({ type: "streaming", delta }));
        },
        {
          clientSignal: clientAbort.signal,
          onDone: () => {
            if (clientGone) return;
            const c = clients.get(clientId);
            if (!c) return;
            if (c.lastPartialText) c.lastPartialText = "";
            sendFrame(c.socket, JSON.stringify({ type: "done" }));
          },
          onError: (err: string) => {
            if (clientGone) return;
            const c = clients.get(clientId);
            if (!c) return;
            sendFrame(c.socket, JSON.stringify({ type: "error", text: err }));
          },
        },
      );
    });

    socket.on("close", () => {
      clients.delete(clientId);
      log?.info(`[webchat] Client disconnected: ${clientId} (total: ${clients.size})`);
    });

    socket.on("error", (err) => {
      log?.error(`[webchat] Socket error for ${clientId}: ${err.message}`);
      clients.delete(clientId);
    });
  });

  // 非 EADDRINUSE 的 server 错误
  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") return;
    log?.error(`[webchat] HTTP server error: ${err.message}`);
    onError(err);
  });

  let retryCount = 0;
  const MAX_RETRIES = 1;

  function tryListen(port: number): Promise<void> {
    return new Promise<void>((resolve) => {
      server.listen(port, () => {
        const addr = server.address();
        actualWebchatPort = typeof addr === "object" && addr ? addr.port : port;
        (globalThis as any).__coordClawWebchatPort = actualWebchatPort;
        log?.info(`[webchat] HTTP + WebSocket server listening on http://localhost:${actualWebchatPort}`);
        onReady();

        abortSignal.addEventListener("abort", () => {
          log?.info("[webchat] Shutting down...");
          for (const [id, client] of clients) {
            sendFrame(client.socket, JSON.stringify({ type: "shutdown", text: "Server shutting down" }));
            client.socket.end();
          }
          clients.clear();
          server.close();
        });
      });

      server.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && retryCount < MAX_RETRIES) {
          retryCount++;
          const nextPort = PORT + retryCount;
          log?.warn(`[webchat] Port ${PORT + retryCount - 1} occupied, trying ${nextPort}`);
          server.close();
          tryListen(nextPort).then(resolve);
        } else if (err.code === "EADDRINUSE") {
          log?.error(`[webchat] Port ${port} occupied, max retries reached`);
          onError(err);
        }
      });
    });
  }

  await tryListen(PORT);

  if (abortSignal.aborted) return;
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}
