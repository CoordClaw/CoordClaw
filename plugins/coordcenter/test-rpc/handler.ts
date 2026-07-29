/**
 * 功能模块：RPC 测试消息发送（test-rpc handler）
 *
 * 通过 Gateway RPC sessions.send 发送测试消息给 PM，
 * 不再依赖 HTTP POST /v1/chat/completions 方式。
 */

import { info, error, warn, getEventId } from "../shared/logger";
import { loadTeamContext } from "../shared/team-loader";
import { callGatewayRpc } from "../shared/gateway-rpc";

export interface TestRpcConfig {
  jsonPath: string;
  cacheTtl: number;
}

export interface TestRpcResult {
  success: boolean;
  message: string;
  pmName?: string;
  pmAgentId?: string;
  pmSessionKey?: string;
  testMessage?: string;
  rpcResult?: unknown;
  error?: string;
}

export async function sendTestMessageToPm(
  config: TestRpcConfig
): Promise<TestRpcResult> {
  info("test-rpc", `[TEST-RPC] === START === jsonPath=${config.jsonPath}`, getEventId());

  try {
    const { members } = await loadTeamContext(config.jsonPath, config.cacheTtl, "test-rpc");

    const pm = members.find((m: any) => m.authority_level === "L4") || members[0];

    if (!pm) {
      return {
        success: false,
        message: "team.json 中无有效成员",
        error: "no valid members",
      };
    }

    if (!pm.sessionKey) {
      return {
        success: false,
        message: `PM ${pm.name}(${pm.agent_id}) 未配置 sessionKey`,
        pmName: pm.name,
        pmAgentId: pm.agent_id,
        error: "missing sessionKey",
      };
    }

    const testMessage = "请复述团队通用规则";
    info("test-rpc", `[TEST-RPC] target PM: ${pm.name}(${pm.agent_id}) sessionKey=${pm.sessionKey.slice(0, 50)}`, getEventId());
    info("test-rpc", `[TEST-RPC] test message: "${testMessage}"`, getEventId());

    const rpcResult = await callGatewayRpc({
      method: "sessions.send",
      params: {
        key: pm.sessionKey,
        message: testMessage,
      },
      expectFinal: true,
      timeoutMs: 120_000,
    });

    info("test-rpc", `[TEST-RPC] RPC result: ${JSON.stringify(rpcResult).slice(0, 300)}`, getEventId());

    return {
      success: true,
      message: `已通过 Gateway RPC sessions.send 发送测试消息给 ${pm.name}(${pm.agent_id})`,
      pmName: pm.name,
      pmAgentId: pm.agent_id,
      pmSessionKey: pm.sessionKey,
      testMessage,
      rpcResult,
    };
  } catch (err: any) {
    error("test-rpc", `[TEST-RPC] 失败: ${err.message}\n${err.stack}`, getEventId());
    return {
      success: false,
      message: `RPC 发送失败: ${err.message}`,
      error: err.message,
    };
  }
}