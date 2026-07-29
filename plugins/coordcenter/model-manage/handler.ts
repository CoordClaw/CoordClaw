/**
 * model-manage handler — 模型管理业务逻辑
 *
 *   - 直读 openclaw.json → 获取已配置的模型范围（打 scope 标签）
 *   - models.list RPC   → 获取可用模型主数据 + 元数据补全
 *   - sessions.patch RPC → per-session 设置
 *   - 直写 openclaw.json → per-agent / 全局设置
 */

import * as fs from "fs";
import { debug, info, warn, getEventId } from "../shared/logger";
import { getOpenClawJsonPath } from "../shared/paths";

const MODULE = "model-manage";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  scope: string;           // "global" | "agent:<id>" | "allowlist" | "available"
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
}

export interface ModelListResult {
  success: boolean;
  models: ModelInfo[];
  message?: string;
}

export interface ModelSetParams {
  sessionKey?: string;    // per-session: sessions.patch RPC
  agentId?: string;       // per-agent: 写 agents.list[id].model
  model?: string | null;  // "provider/model" | null (重置/恢复默认)
}

export interface ModelSetResult {
  success: boolean;
  sessionKey?: string;
  agentId?: string;
  scope?: string;
  modelProvider?: string;
  model?: string;
  message?: string;
  details?: Record<string, string>;
}

/** 获取模型列表：models.list RPC 主数据 + openclaw.json 打 scope 标签 */
export async function getModelList(): Promise<ModelListResult> {
  const eventId = getEventId();
  try {
    // 1. 读 openclaw.json → scope 映射
    const scopeMap = new Map<string, string>();  // "provider/model" → scope
    const jsonPath = getOpenClawJsonPath();
    if (fs.existsSync(jsonPath)) {
      const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const defaultsModel = cfg.agents?.defaults?.model;
      const globalRef = defaultsModel?.primary as string | undefined;
      if (globalRef) scopeMap.set(globalRef, "global");
      if (Array.isArray(defaultsModel?.fallbacks)) {
        defaultsModel.fallbacks.forEach((f: string) => { if (!scopeMap.has(f)) scopeMap.set(f, "global"); });
      }
      const modelsMap = cfg.agents?.defaults?.models;
      if (modelsMap && typeof modelsMap === "object") {
        Object.keys(modelsMap).forEach((k) => { if (!scopeMap.has(k)) scopeMap.set(k, "allowlist"); });
      }
      for (const a of cfg.agents?.list || []) {
        const am = a.model;
        if (typeof am?.primary === "string" && am.primary !== globalRef && !scopeMap.has(am.primary)) {
          scopeMap.set(am.primary, `agent:${a.id}`);
        }
        if (Array.isArray(am?.fallbacks)) {
          am.fallbacks.forEach((f: string) => { if (!scopeMap.has(f)) scopeMap.set(f, `agent:${a.id}`); });
        }
      }
    }

    // 2. models.list RPC → 可用模型主数据
    const { callGatewayRpc } = await import("../shared/gateway-rpc");
    const result = await callGatewayRpc({ method: "models.list", params: {}, timeoutMs: 10_000 });

    // 3. 合并：RPC 数据打标签
    const models: ModelInfo[] = (result?.models || []).map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider,
      scope: scopeMap.get(`${m.provider}/${m.id}`) || scopeMap.get(m.id) || "available",
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      input: m.input,
    }));

    // 4. 补全：RPC 中未返回但 openclaw.json 中已配置的模型
    const seenKeys = new Set(models.map((m) => `${m.provider}/${m.id}`));
    for (const [ref, scope] of scopeMap) {
      if (!seenKeys.has(ref)) {
        const parts = ref.includes("/") ? ref.split("/") : ["", ref];
        models.push({
          id: parts[parts.length - 1],
          name: ref,
          provider: parts.length === 2 ? parts[0] : "",
          scope,
        });
      }
    }

    info(MODULE, `[LIST] ${models.length} models`, eventId);
    return { success: true, models };
  } catch (err: any) {
    warn(MODULE, `[LIST] failed: ${err.message}`, eventId);
    return { success: false, models: [], message: err.message };
  }
}

/** 设置模型：sessionKey→per-session 覆盖；agentId→per-agent 默认；都不传→全局默认。
 *  无优先级——请求里带了哪个字段就执行哪个动作，互不排斥（可同时设会话覆盖与 agent 默认）。 */
export async function setSessionModel(params: ModelSetParams): Promise<ModelSetResult> {
  const eventId = getEventId();
  const { sessionKey, agentId, model } = params;
  const modelVal = model ?? null;
  if (!modelVal) {
    return { success: false, scope: "none", message: "model is required" };
  }

  const details: Record<string, string> = {};
  let scope = "global";
  if (sessionKey) scope = agentId ? "session+agent" : "session";
  else if (agentId) scope = "agent";

  // 1) per-session override —— sessionKey 存在即设置，与 agentId 互不排斥
  if (sessionKey) {
    try {
      const { callGatewayRpc } = await import("../shared/gateway-rpc");
      const result = await callGatewayRpc({ method: "sessions.patch", params: { key: sessionKey, model: modelVal }, timeoutMs: 10_000 });
      if (result?.ok) {
        const resolved = result.resolved || {};
        details.session = "ok";
        details.modelProvider = (resolved.modelProvider as string) || "";
        details.model = (resolved.model as string) || "";
      } else {
        details.session = `failed: ${result?.message || "Gateway rejected"}`;
      }
    } catch (err: any) {
      details.session = `error: ${err.message}`;
    }
  }

  // 2) per-agent 默认模型 —— agentId 存在即设置，与 sessionKey 互不排斥
  if (agentId) {
    try {
      const jsonPath = getOpenClawJsonPath();
      if (!fs.existsSync(jsonPath)) {
        details.agent = "error: openclaw.json not found";
      } else {
        const raw = fs.readFileSync(jsonPath, "utf-8");
        const data = JSON.parse(raw);
        data.agents = data.agents || { defaults: {}, list: [] };
        const agent = (data.agents.list || []).find((a: any) => a.id === agentId);
        if (!agent) {
          details.agent = `error: agent not found: ${agentId}`;
        } else {
          agent.model = agent.model || {};
          agent.model.primary = modelVal;
          fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
          details.agent = "ok";
        }
      }
    } catch (err: any) {
      details.agent = `error: ${err.message}`;
    }
  }

  // 3) 全局默认 —— 仅当 sessionKey 与 agentId 都不传
  if (!sessionKey && !agentId) {
    try {
      const jsonPath = getOpenClawJsonPath();
      if (!fs.existsSync(jsonPath)) {
        details.global = "error: openclaw.json not found";
      } else {
        const raw = fs.readFileSync(jsonPath, "utf-8");
        const data = JSON.parse(raw);
        data.agents = data.agents || { defaults: {}, list: [] };
        data.agents.defaults.model = data.agents.defaults.model || {};
        data.agents.defaults.model.primary = modelVal;
        // 真正的全局默认：清掉所有 per-agent 模型覆盖，使其统一继承 defaults
        for (const a of data.agents.list || []) delete a.model;
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
        details.global = "ok";
      }
    } catch (err: any) {
      details.global = `error: ${err.message}`;
    }
  }

  const attempted = [details.session, details.agent, details.global].filter(Boolean);
  const allOk = attempted.length > 0 && attempted.every((s) => s === "ok");
  info(MODULE, `[SET] ${scope} → ${modelVal} (${JSON.stringify(details)})`, eventId);
  return { success: allOk, scope, sessionKey, agentId, model: modelVal, details };
}
