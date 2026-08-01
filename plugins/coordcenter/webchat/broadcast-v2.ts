/**
 * Broadcast Client v2 - 安全版本
 *
 * Token获取：参考 gateway.ts:124-134 的标准实现
 */

import crypto from "node:crypto";
import netMod from "node:net";

import { getRunLifecycleTracker } from "./run-lifecycle-tracker";
import { resolveGatewayUrl, resolveGatewayToken } from "../shared/paths";
import { debug, warn, error } from "../shared/logger";

const d = (m: string) => debug('broadcast-v2', m);
const w = (m: string) => warn('broadcast-v2', m);
const e = (m: string) => error('broadcast-v2', m);

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Gateway 地址改为动态解析（环境变量 OPENCLAW_GATEWAY_PORT → openclaw.json gateway.port → 默认 28789），
// 不再硬编码 28789，避免与实际运行的 Gateway 端口不一致导致永远 ECONNREFUSED。
let _reconnectTimer: any = null;
let _reconnectDelay = 1000;
const RECONNECT_MAX_DELAY = 30000;

function resolveGatewayEndpoint(): { host: string; port: number } {
  try {
    const url = new URL(resolveGatewayUrl());
    const port = Number(url.port);
    return { host: url.hostname || "127.0.0.1", port: port > 0 ? port : 28789 };
  } catch (e) {
    return { host: "127.0.0.1", port: 28789 };
  }
}

type RuntimeType = { config?: { loadConfig?: () => Record<string, any> } };

let gwSocket: any = null;
let gwConnected = false;
let _gatewayToken: string | undefined;
let _runtime: RuntimeType | undefined;
let _enabled = false;

function generateAcceptKey(clientKey: string): string {
  return crypto.createHash("sha1").update(clientKey + WEBSOCKET_GUID).digest("base64");
}

// Gateway WS 协议版本（必须与运行中的 Gateway 匹配；实测当前 Gateway 要求 expectedProtocol=4）。
// 若 Gateway 升级后改版本，会返回 PROTOCOL_MISMATCH，需同步调整此处。
const WS_PROTOCOL = 4;

// 客户端→Gateway 的帧必须加掩码（RFC6455 要求浏览器/客户端发出的帧 masked）。
function sendWsFrame(str: string): boolean {
  if (!gwSocket || gwSocket.destroyed) {
    d("sendWsFrame: ABORT - no socket");
    return false;
  }
  try {
    const payload = Buffer.from(str, "utf8");
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x81, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    gwSocket.write(Buffer.concat([header, mask, masked]));
    return true;
  } catch (e: any) {
    w(`sendWsFrame error: ${e.message}`);
    return false;
  }
}

// 响应对端 connect.challenge：回一个带 token 认证的 connect 帧，否则 Gateway 会在数秒/十几秒后关闭连接。
function sendConnectFrame(): void {
  const frame = JSON.stringify({
    type: "req",
    id: "coordclaw-broadcast-connect",
    method: "connect",
    params: {
      minProtocol: WS_PROTOCOL,
      maxProtocol: WS_PROTOCOL,
      role: "operator",
      client: { id: "webchat-ui", mode: "webchat", version: "1.0.0", platform: "browser" },
      auth: _gatewayToken ? { token: _gatewayToken } : undefined,
    },
  });
  const ok = sendWsFrame(frame);
  d(`sendConnectFrame: ${ok ? "sent" : "FAILED"}`);
}

export function setRuntime(runtime: RuntimeType | undefined) {
  _runtime = runtime;
}

export function setGatewayToken(token: string | undefined) {
  _gatewayToken = token;
}

export function setEnabled(enabled: boolean) {
  _enabled = enabled;
  d(`setEnabled(${enabled})`);
}

export function setTrackedSessionKeys(sessionKeys: string[]) {
  getRunLifecycleTracker().updateTrackedSessionKeys(sessionKeys);
  d(`setTrackedSessionKeys: ${sessionKeys.length} keys`);
}

export function getBroadcastStatus() {
  return gwConnected;
}

async function loadTokenFromRuntime(): Promise<string | undefined> {
  // 复用 shared/paths.resolveGatewayToken（环境变量 OPENCLAW_GATEWAY_TOKEN → openclaw.json gateway.auth.token），
  // 不再重复实现文件读取逻辑。
  const token = resolveGatewayToken();
  if (token) {
    d(`Token loaded via resolveGatewayToken (${token.length} chars)`);
    return token;
  }

  // 兜底：运行时内存配置（运行时持有的 token 可能与文件不同源，例如尚未落盘）
  try {
    if (_runtime?.config?.loadConfig) {
      const cfg = _runtime.config.loadConfig();
      const rtToken = cfg?.gateway?.auth?.token;
      if (rtToken) {
        d(`Token loaded from runtime.config (${rtToken.length} chars)`);
        return rtToken;
      }
    }
  } catch (e) {
    w(`Token runtime load error: ${e instanceof Error ? e.message : String(e)}`);
  }

  w("Token NOT FOUND from any source");
  return undefined;
}

async function safeConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!_enabled) {
      d("safeConnect: ABORT - disabled");
      resolve(false);
      return;
    }

    if (gwConnected) {
      d("safeConnect: already connected");
      resolve(true);
      return;
    }

    d("safeConnect: starting...");

    let socket: any = null;
    let handshakeDone = false;
    const endpoint = resolveGatewayEndpoint();
    d(`safeConnect: target ${endpoint.host}:${endpoint.port}`);

    const timeoutId = setTimeout(() => {
      if (!handshakeDone) {
        handshakeDone = true;
        w("safeConnect: TIMEOUT after 5s");
        try { if (socket && !socket.destroyed) socket.destroy(); } catch (e) {}
        resolve(false);
      }
    }, 5000);

    const key = crypto.randomBytes(16).toString("base64");
    try {
      socket = netMod.connect(endpoint.port, endpoint.host, () => {
        try {

          let headers =
            "GET /__openclaw__/ws HTTP/1.1\r\n" +
            `Host: ${endpoint.host}:${endpoint.port}\r\n` +
            `Origin: http://${endpoint.host}:${endpoint.port}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n";

          if (_gatewayToken) {
            headers += `Authorization: Bearer ${_gatewayToken}\r\n`;
          }

          headers += "\r\n";
          socket.write(headers);
          d("safeConnect: handshake request sent");
        } catch (writeErr: any) {
          if (!handshakeDone) {
            handshakeDone = true;
            w(`safeConnect: write error: ${writeErr.message}`);
            clearTimeout(timeoutId);
            try { if (socket && !socket.destroyed) socket.destroy(); } catch (e) {}
            resolve(false);
          }
        }
      });

      socket.on("error", (err: Error) => {
        if (!handshakeDone) {
          handshakeDone = true;
          w(`safeConnect: socket error: ${err.message}`);
          clearTimeout(timeoutId);
          resolve(false);
        }
      });

      let httpBuf = "";
      socket.on("data", (chunk: Buffer) => {
        if (handshakeDone) return;

        try {
          httpBuf += chunk.toString("utf8");

          if (httpBuf.includes("\r\n\r\n")) {
            handshakeDone = true;
            clearTimeout(timeoutId);

            if (httpBuf.includes("101") && httpBuf.includes(generateAcceptKey(key))) {
              gwSocket = socket;
              gwConnected = true;
              d("safeConnect: ✅ HANDSHAKE SUCCESS (HTTP 101)");

              socket.removeAllListeners("data");
              socket.on("close", () => {
                d("safeConnect: connection closed by remote");
                gwConnected = false;
                gwSocket = null;
                scheduleReconnect();
              });

              resolve(true);
            } else {
              const m = httpBuf.match(/HTTP\/1\.1 (\d+)/);
              w(`safeConnect: ❌ HANDSHAKE FAILED HTTP ${m ? m[1] : "?"}`);
              try { socket.destroy(); } catch (e) {}
              resolve(false);
            }
          }
        } catch (dataErr: any) {
          if (!handshakeDone) {
            handshakeDone = true;
            w(`safeConnect: data parse error: ${dataErr.message}`);
            clearTimeout(timeoutId);
            try { if (socket && !socket.destroyed) socket.destroy(); } catch (e) {}
            resolve(false);
          }
        }
      });

      socket.on("close", () => {
        if (!handshakeDone) {
          handshakeDone = true;
          w("safeConnect: closed before handshake");
          clearTimeout(timeoutId);
          resolve(false);
        }
      });

    } catch (connectErr: any) {
      if (!handshakeDone) {
        handshakeDone = true;
        w(`safeConnect: connect exception: ${connectErr.message}`);
        clearTimeout(timeoutId);
        try { if (socket && !socket.destroyed) socket.destroy(); } catch (e) {}
        resolve(false);
      }
    }
  });
}

export async function startBroadcastClientV2(): Promise<void> {
  try {
    d("========================================");
    d("=== startBroadcastClientV2() ENTRY ===");
    d(`_enabled=${_enabled}`);
    d(`_runtime=${!!_runtime}`);

    if (!_enabled) {
      d("ABORT: feature disabled");
      return;
    }

    if (!_gatewayToken) {
      _gatewayToken = await loadTokenFromRuntime();
    }

    d("calling safeConnect()...");
    const success = await safeConnect();

    if (success) {
      d("✅ CONNECTED! starting frame listener...");
      startFrameListener();
    } else {
      w("❌ connection failed");
      scheduleReconnect();
    }

  } catch (err: any) {
    e(`UNEXPECTED ERROR: ${err.message}\n${err.stack || ""}`);
  }
}

function scheduleReconnect(): void {
  if (!_enabled) {
    d("scheduleReconnect: ABORT - disabled");
    return;
  }
  if (_reconnectTimer) return;
  d(`scheduleReconnect: next attempt in ${_reconnectDelay}ms`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    safeConnect().then((ok) => {
      if (ok) {
        _reconnectDelay = 1000;
        d("scheduleReconnect: ✅ reconnected, restarting frame listener");
        startFrameListener();
      } else {
        _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_DELAY);
        scheduleReconnect();
      }
    });
  }, _reconnectDelay);
}

export function stopBroadcastClientV2() {
  try {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    _reconnectDelay = 1000;
    if (gwSocket && !gwSocket.destroyed) {
      gwSocket.destroy();
    }
    gwConnected = false;
    gwSocket = null;
    d("stopBroadcastClientV2: stopped");
  } catch (err: any) {
    w(`stopBroadcastClientV2 error: ${err.message}`);
  }
}

function startFrameListener(): void {
  if (!gwSocket) {
    d("startFrameListener: ABORT - no socket");
    return;
  }

  d("startFrameListener: started, waiting for data...");

  let buffer = Buffer.alloc(0);
  let frameCount = 0;

  gwSocket.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const byte0 = buffer[0];
        const byte1 = buffer[1];

        const fin = (byte0 & 0x80) !== 0;
        const opcode = byte0 & 0x0F;
        const masked = (byte1 & 0x80) !== 0;
        let payloadLength = byte1 & 0x7F;

        let headerLength = 2;
        if (payloadLength === 126) {
          if (buffer.length < 4) break;
          payloadLength = buffer.readUInt16BE(2);
          headerLength = 4;
        } else if (payloadLength === 127) {
          if (buffer.length < 10) break;
          const high = buffer.readUInt32BE(2);
          const low = buffer.readUInt32BE(6);
          if (high > 0) {
            w(`frame: too large, skipping`);
            buffer = Buffer.alloc(0);
            break;
          }
          payloadLength = low;
          headerLength = 10;
        }

        const maskKey = masked ? 4 : 0;
        const totalLength = headerLength + maskKey + payloadLength;

        if (buffer.length < totalLength) break;

        const payload = buffer.slice(headerLength + maskKey, totalLength);

        if (masked && maskKey === 4) {
          const mask = buffer.slice(headerLength, headerLength + 4);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }

        buffer = buffer.slice(totalLength);

        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            frameCount++;
            // 先解析，拦截 connect.challenge 并回认证帧；其余事件交给 handleFrame
            let data: any = null;
            try { data = JSON.parse(payload.toString("utf8")); } catch { /* ignore */ }
            if (data && data.type === "event" && data.event === "connect.challenge") {
              d("frame: connect.challenge received → replying with connect auth");
              sendConnectFrame();
            } else {
              handleFrame(payload);
            }
            if (frameCount % 10 === 0) {
              d(`frame: received ${frameCount} frames total`);
            }
          }
        } else if (opcode === 0x8) {
          d("frame: received close frame");
          return;
        } else if (opcode === 0x9) {
          if (gwSocket && !gwSocket.destroyed) {
            const pongBuffer = Buffer.from([0x8A, 0x00]);
            gwSocket.write(pongBuffer);
          }
        }
      }
    } catch (frameErr: any) {
      w(`frame processing error: ${frameErr.message}`);
      buffer = Buffer.alloc(0);
    }
  });
}

function handleFrame(payload: Buffer): void {
  try {
    const text = payload.toString("utf8");
    if (!text || text.length === 0) return;

    let data: any;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      return;
    }

    if (data?.stream === "lifecycle" || data?.event === "agent.lifecycle") {
      getRunLifecycleTracker().trackEvent(data.data || data);
    }

    if (
      data?.method === "event" ||
      data?.type === "event" ||
      (data?.runId && data?.stream)
    ) {
      getRunLifecycleTracker().trackEvent(data);
    }
  } catch (handleErr: any) {
    w(`handleFrame error: ${handleErr.message}`);
  }
}
