#!/usr/bin/env node
/**
 * Broadcast连接诊断脚本
 * 用于独立测试Gateway WebSocket连接和Token认证
 */

import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const GATEWAY_PORT = 28789;
const GATEWAY_HOST = "127.0.0.1";

function generateAcceptKey(clientKey: string): string {
  return crypto.createHash("sha1").update(clientKey + WEBSOCKET_GUID).digest("base64");
}

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function loadTokenFromConfig(): Promise<string | undefined> {
  // 尝试从 openclaw.json 加载 token
  const possiblePaths = [
    path.join(process.env.USERPROFILE || "", ".openclaw", "openclaw.json"),
    path.join(process.env.HOME || "", ".openclaw", "openclaw.json"),
  ];

  for (const filePath of possiblePaths) {
    try {
      if (fs.existsSync(filePath)) {
        const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const token = content?.gateway?.auth?.token;
        if (token) {
          log(`✅ 从配置文件加载Token成功: ${filePath}`);
          return token;
        }
      }
    } catch (err: any) {
      log(`⚠️ 读取 ${filePath} 失败: ${err.message}`);
    }
  }

  return undefined;
}

async function testConnection(token?: string): Promise<void> {
  return new Promise((resolve) => {
    log(`🎯 开始测试Gateway连接...`);
    log(`目标: ws://${GATEWAY_HOST}:${GATEWAY_PORT}/__openclaw__/ws`);
    log(`Token状态: ${token ? `已设置(长度=${token.length})` : '未设置'}`);

    const socket = net.connect(GATEWAY_PORT, GATEWAY_HOST, () => {
      log('✅ TCP连接已建立');

      const key = crypto.randomBytes(16).toString("base64");
      let headers =
        "GET /__openclaw__/ws HTTP/1.1\r\n" +
        "Host: " + GATEWAY_HOST + ":" + GATEWAY_PORT + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n";

      if (token) {
        headers += "Authorization: Bearer " + token + "\r\n";
      }

      headers += "\r\n";

      log('发送WebSocket握手请求...');
      socket.write(headers);
    });

    let httpBuf = "";
    let handshakeDone = false;

    const checkDone = () => {
      if (handshakeDone) return;
      if (httpBuf.includes("\r\n\r\n")) {
        handshakeDone = true;
        log(`收到服务器响应:\n${httpBuf.slice(0, 500)}`);

        if (httpBuf.includes("101") && httpBuf.includes(generateAcceptKey(key))) {
          log('✅ WebSocket握手成功！');
          log('🎉 Gateway广播连接正常工作！');
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 1000);
        } else {
          const statusMatch = httpBuf.match(/HTTP\/1\.1 (\d+)/);
          const statusCode = statusMatch ? statusMatch[1] : "unknown";
          log(`❌ 握手失败: HTTP ${statusCode}`);

          if (statusCode === "401") {
            log('💡 错误原因: Token无效或未提供');
          } else if (statusCode === "403") {
            log('💡 错误原因: 认证被拒绝');
          } else if (statusCode === "503") {
            log('💡 错误原因: Gateway服务不可用');
          }

          socket.destroy();
          resolve();
        }
      }
    };

    socket.on("data", (chunk: Buffer) => {
      httpBuf += chunk.toString("utf8");
      checkDone();
    });

    socket.on("error", (err: Error) => {
      log(`❌ 连接错误: ${err.message}`);
      resolve();
    });

    socket.on("close", () => {
      if (!handshakeDone) {
        log('⚠️ 连接在握手完成前关闭');
        resolve();
      }
    });

    setTimeout(() => {
      if (!handshakeDone) {
        log('⏰ 连接超时(5秒)');
        socket.destroy();
        resolve();
      }
    }, 5000);
  });
}

async function main() {
  log('========================================');
  log('  Gateway Broadcast 连接诊断工具');
  log('========================================\n');

  // 测试Gateway是否可达
  log('步骤1: 检查Gateway端口是否可访问...');
  try {
    await new Promise((resolve, reject) => {
      const testSocket = net.connect(GATEWAY_PORT, GATEWAY_HOST, () => {
        log('✅ Gateway端口可访问\n');
        testSocket.destroy();
        resolve(undefined);
      });
      testSocket.on("error", (err: Error) => {
        log(`❌ Gateway端口不可访问: ${err.message}`);
        log('💡 请确保OpenClaw/QClaw服务已启动\n');
        reject(err);
      });
      setTimeout(() => {
        reject(new Error('连接超时'));
      }, 3000);
    });
  } catch (err) {
    process.exit(1);
  }

  // 加载Token
  log('步骤2: 尝试加载Gateway Token...');
  const token = await loadTokenFromConfig();

  // 测试带Token的连接
  log('\n步骤3: 测试WebSocket连接(带Token)...');
  await testConnection(token);

  // 如果Token失败，尝试无Token连接
  if (!token) {
    log('\n步骤4: 测试WebSocket连接(无Token)...');
    await testConnection(undefined);
  }

  log('\n========================================');
  log('  诊断完成');
  log('========================================');
}

main().catch((err) => {
  console.error('诊断脚本执行失败:', err);
  process.exit(1);
});
