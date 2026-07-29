/**
 * config-manage handler — openclaw.json 配置热更新
 *
 * 复用 callGatewayRpc：
 *   - config.patch → 部分更新（深度 merge）
 *   - config.apply → 完整替换
 */

import { debug, info, warn, getEventId } from "../shared/logger";

const MODULE = "config-manage";

export interface ConfigPatchResult {
  success: boolean;
  noop?: boolean;
  message?: string;
}

export interface ConfigApplyResult {
  success: boolean;
  message?: string;
}

/** config.patch — 部分更新 openclaw.json，触发热加载 */
export async function patchConfig(raw: string): Promise<ConfigPatchResult> {
  const eventId = getEventId();
  if (!raw) {
    return { success: false, message: "raw is required" };
  }
  try {
    const { callGatewayRpc } = await import("../shared/gateway-rpc");
    // 先取当前 config hash（config.patch 需要 hash 做并发保护）
    let hash = "";
    try {
      const snapshot = await callGatewayRpc({ method: "config.get", params: {}, timeoutMs: 5_000 });
      hash = snapshot?.hash || "";
    } catch (err: any) {
      return { success: false, message: `failed to get config hash: ${err.message}` };
    }
    if (!hash) {
      return { success: false, message: "config hash is empty, cannot patch" };
    }

    const params: any = { raw };
    if (hash) params.baseHash = hash;

    const result = await callGatewayRpc({
      method: "config.patch",
      params,
      timeoutMs: 10_000,
    });
    if (result?.ok || result?.noop) {
      info(MODULE, `[PATCH] applied (noop=${!!result?.noop})`, eventId);
      return { success: true, noop: !!result?.noop };
    }
    warn(MODULE, `[PATCH] rejected: ${JSON.stringify(result)}`, eventId);
    return { success: false, message: "Gateway rejected config.patch" };
  } catch (err: any) {
    warn(MODULE, `[PATCH] failed: ${err.message}`, eventId);
    return { success: false, message: err.message };
  }
}

/** config.apply — 完整替换 openclaw.json */

export async function applyConfig(config: any): Promise<ConfigApplyResult> {
  const eventId = getEventId();
  if (!config || typeof config !== "object") {
    return { success: false, message: "config must be a valid JSON object" };
  }
  try {
    const { callGatewayRpc } = await import("../shared/gateway-rpc");
    const result = await callGatewayRpc({
      method: "config.apply",
      params: config,
      timeoutMs: 10_000,
    });
    if (result?.ok) {
      info(MODULE, `[APPLY] applied successfully`, eventId);
      return { success: true };
    }
    warn(MODULE, `[APPLY] rejected`, eventId);
    return { success: false, message: "Gateway rejected config.apply" };
  } catch (err: any) {
    warn(MODULE, `[APPLY] failed: ${err.message}`, eventId);
    return { success: false, message: err.message };
  }
}

/** config.get — 获取当前 openclaw.json 快照（已脱敏） */
export async function getConfig(): Promise<{ success: boolean; config?: any; message?: string }> {
  const eventId = getEventId();
  try {
    const { callGatewayRpc } = await import("../shared/gateway-rpc");
    const result = await callGatewayRpc({
      method: "config.get",
      params: {},
      timeoutMs: 10_000,
    });
    if (result) {
      return { success: true, config: result };
    }
    return { success: false, message: "empty response from Gateway" };
  } catch (err: any) {
    warn(MODULE, `[GET] failed: ${err.message}`, eventId);
    return { success: false, message: err.message };
  }
}
