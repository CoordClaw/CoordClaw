/**
 * 统一 Gateway RPC 调用封装
 *
 * 所有插件内的 callGateway 均通过此函数发起，
 * 确保 scope、mode、clientName 一致，便于集中维护。
 *
 * - scopes: operator.admin  — 覆盖所有 RPC 方法
 * - mode: backend           — 配合 ensureDevicePairing 抢先配对
 * - clientName: gateway-client — 与 mode 配合走本地信任路径
 */
import { getCallGatewayModule } from "./paths";

export interface GatewayRpcOptions {
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  expectFinal?: boolean;
}

const RPC_DEFAULTS = {
  scopes: ["operator.admin"],
  mode: "backend",
  clientName: "gateway-client",
} as const;

export async function callGatewayRpc(opts: GatewayRpcOptions) {
  const callModulePath = getCallGatewayModule();
  const { callGateway } = await import(callModulePath);
  return await callGateway({ ...opts, ...RPC_DEFAULTS });
}
