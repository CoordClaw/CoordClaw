/**
 * token-stats 统计池
 *
 * 独立模块：不与任何业务状态机耦合。agent_end / health_poll 单向推送。
 *
 * 持久化到 {projectRoot}/.data/data/token-stats.jsonl（与 coordclaw.db 同目录）。
 * 格式：每行一个 sessionId 的 token 明细，支持 append-only + 去重取大。
 */
import fs from "fs";
import path from "path";
import { encode } from "gpt-tokenizer";
import { appendFileWithRetry } from "../shared/json-atomic";
import { getOpenClawUserDir, getCoordClawJsonPath } from "../shared/paths";
import { warn, getEventId } from "../shared/logger";
import { getSessionApi } from "../shared/session-api";

/** 单条统计记录 */
export interface TokenStatsEntry {
  ts: number;
  sessionKey: string;
  sessionId: string;

  /** 维度信息 */
  userRounds: number;
  toolRounds: number;
  inputs: number;
  outputs: number;

  /** 原始统计（会话文件直接求和，未加权） */
  rawUser: number;
  rawAssistant: number;
  rawToolResult: number;

  /** INPUT 维度（加权累积，每次 LLM 提交的上下文消耗） */
  estSysPrompt: number;
  estUser: number;
  estAsstHistory: number;
  estToolResult: number;
  estInputTotal: number;

  /** OUTPUT 维度（模型生成的 token，不乘权重） */
  estAsstOutput: number;
  estTotal: number;
}

// ── 文件路径 ──

/**
 * 解析当前激活项目根目录，复用 cache-refresh 单一真源（Layer 1）。
 *
 * 规则依据：系统对"当前激活项目根"只有唯一真源——prompt-injection/loader 的
 * rulePathCache（cache-coordinator 列为 Layer 1）。任何模块要激活项目根必须走 L1 读，
 * 禁止持有私有副本（否则违反 cache-refresh 规则，切换项目后路径陈旧）。
 *
 * 旧实现持有模块级 cachedProjectRoot 单例，首次解析后永久冻结，且 setProjectRoot 零调用点
 * （死代码），导致切换项目后 jsonl 仍写到旧项目路径，并破坏 plugin↔panel 读写契约。
 *
 * 改为：每条推送路径（agent_end / health_poll）在 computeAndPersist 开头直接 await 读 L1，
 * 自带 60s TTL + cache-refresh 失效（switchProject→fullReset→clearLoaderCache 已自动覆盖），
 * 与所有其它消费者同语义，零新增钩子、零私有副本。
 */
export async function resolveActiveProjectRoot(): Promise<string | null> {
  try {
    const jsonPath = getCoordClawJsonPath();
    const { resolveProjectRoot } = await import("../prompt-injection/loader");
    const root = await resolveProjectRoot(jsonPath);
    return root || null;
  } catch (err: any) {
    warn("token-stats", `[resolveActiveProjectRoot] 解析 projectRoot 失败(非致命): ${err?.message}`, getEventId());
    return null;
  }
}

function getPath(root: string): string {
  return path.join(root, ".data", "data", "token-stats.jsonl");
}

// ── 持久化 ──

export function persist(entry: TokenStatsEntry, root: string): void {
  const filePath = getPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileWithRetry(filePath, JSON.stringify(entry) + "\n");
}

export async function readAll(): Promise<TokenStatsEntry[]> {
  const root = await resolveActiveProjectRoot();
  if (!root) return [];
  const filePath = getPath(root);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf-8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l)) : [];
}

export function deduped(entries: TokenStatsEntry[]): TokenStatsEntry[] {
  const map = new Map<string, TokenStatsEntry>();
  for (const e of entries) {
    const existing = map.get(e.sessionId);
    if (!existing) { map.set(e.sessionId, { ...e }); continue; }
    existing.rawUser = Math.max(existing.rawUser, e.rawUser);
    existing.rawAssistant = Math.max(existing.rawAssistant, e.rawAssistant);
    existing.rawToolResult = Math.max(existing.rawToolResult, e.rawToolResult);
    existing.userRounds = Math.max(existing.userRounds, e.userRounds);
    existing.toolRounds = Math.max(existing.toolRounds, e.toolRounds);
    existing.inputs = Math.max(existing.inputs, e.inputs);
    existing.outputs = Math.max(existing.outputs, e.outputs);
    existing.estSysPrompt = Math.max(existing.estSysPrompt, e.estSysPrompt);
    existing.estUser = Math.max(existing.estUser, e.estUser);
    existing.estAsstHistory = Math.max(existing.estAsstHistory, e.estAsstHistory);
    existing.estToolResult = Math.max(existing.estToolResult, e.estToolResult);
    existing.estInputTotal = Math.max(existing.estInputTotal, e.estInputTotal);
    existing.estAsstOutput = Math.max(existing.estAsstOutput, e.estAsstOutput);
    existing.estTotal = Math.max(existing.estTotal, e.estTotal);
  }
  return [...map.values()];
}

// ── systemPrompt 缓存 ──

const systemPromptCache = new Map<string, string>();

/** 缓存 agent 的 system prompt 文本（before_prompt_build 中调用） */
export function cacheSystemPrompt(agentId: string, text: string): void {
  if (!systemPromptCache.has(agentId) && text) systemPromptCache.set(agentId, text);
}

// ── 计算 & 推送 ──

/**
 * 会话源目录：openclaw 把各 agent 会话存在 stateDir/agents/<id>/sessions。
 * stateDir 在 INIT 时由 setUserDirFromRuntime 锁定（= api.runtime.state.resolveStateDir() 的进程内值），
 * getUserDir() 现仅返回该锁定值，不再独立探测 env 或回退 ~/.qclaw（与网关保持单一真相源）。
 * 直接复用此函数，不重复拼 env（避免与 paths.ts 逻辑分叉）。
 */
function resolveSessionDir(agentId: string): string {
  return path.join(getOpenClawUserDir(), "agents", agentId, "sessions");
}

/** 框架会话 API 单例已提升至 ../shared/session-api（set/getSessionApi），此处不再持有私有副本 */

/**
 * 找 session 文件（三层递进，复用框架单一真相源）：
 *   L1 框架 API getSessionEntry({ sessionKey }) 直接取 sessionFile 绝对路径（最权威/缓存免费/无双目录歧义）
 *   L2 猜文件兜底（廉价 readdir，仅极老部署转录曾以 <sessionId>.jsonl 命名时命中）
 *   L3 读 sessions.json[sessionKey].sessionFile 兜底（JSON.parse 性能差，置末位）
 * agentId 归一化：index.ts health_poll 下可能传 sessionKey 当 agentId，需还原真实 agentId 定位目录。
 */
function findSessionFile(sessionKey: string, sessionId: string, agentId: string): string | null {
  // aid 归一化：index.ts:202 的 aid = c.agentId || sk 在 health_poll 下 c.agentId 空会把整条 sessionKey 当 agentId
  const aid = agentId && agentId.includes(":") ? agentId.split(":")[1] : agentId;

  // L1 直接读 sessionFile：框架 API（agentId 由框架从 sessionKey 推导，彻底绕开 index.ts 脆弱兜底）
  try {
    const e = getSessionApi()?.getSessionEntry?.({ sessionKey });
    if (e?.sessionFile) {
      const p = path.isAbsolute(e.sessionFile) ? e.sessionFile : path.join(resolveSessionDir(aid), e.sessionFile);
      if (fs.existsSync(p)) return p; // 防 phantom：转录被 prune 但 entry 残留
    }
  } catch {}

  // L2 猜文件兜底：廉价 readdir，无 JSON.parse；仅极老部署可能命中，不产生假阳性
  try {
    const d = resolveSessionDir(aid);
    const f = fs.readdirSync(d);
    const a = f.find((x) => x === `${sessionId}.jsonl`);
    if (a) return path.join(d, a);
    const r = f.filter((x) => x.startsWith(`${sessionId}.jsonl.reset.`)).sort().reverse();
    if (r.length > 0) return path.join(d, r[0]);
  } catch {}

  // L3 sessions.json 兜底：完整 JSON.parse（性能差，置末位）；读 map[sessionKey].sessionFile
  try {
    const d = resolveSessionDir(aid);
    const m = JSON.parse(fs.readFileSync(path.join(d, "sessions.json"), "utf-8"));
    const sf = m?.[sessionKey]?.sessionFile;
    if (sf) {
      const p = path.isAbsolute(sf) ? sf : path.join(d, sf);
      if (fs.existsSync(p)) return p;
    }
  } catch {}

  return null;
}

/** 精确 token 计数（gpt-tokenizer cl100k_base） */
function countTokens(text: string): number {
  if (!text) return 0;
  try { return encode(text).length; } catch { return 0; }
}

interface ComputeResult {
  entry: TokenStatsEntry | null;
  sessionFileFound: boolean;
}

interface MsgItem { role: string; tokens: number }

/**
 * 从会话文件计算 INPUT/OUTPUT 分离的 token 统计。
 *
 * 上下文累积模型：
 *   input#0 = A + [user]                                          → output#0 = assistant_0
 *   input#1 = A + [user, asst_0, tool_0]                          → output#1 = assistant_1
 *   input#k = A + [user, asst_0, tool_0, ..., asst_k, tool_k]    → output#k = assistant_k
 *
 * INPUT 加权：每段 assistant/toolResult 出现在后续所有 INPUT 提交中
 * OUTPUT：每段 assistant 只被模型生成一次，不乘权重
 */
export async function computeAndPersist(
  sessionKey: string,
  sessionId: string,
  agentId: string,
): Promise<ComputeResult> {
  // 复用 cache-refresh Layer 1 单一真源解析激活项目根（切换项目自动随 fullReset 失效重读）
  const projectRoot = await resolveActiveProjectRoot();
  if (!projectRoot) {
    warn("token-stats", `[computeAndPersist] projectRoot 未解析，跳过 ${sessionKey}`, getEventId());
    return { entry: null, sessionFileFound: false };
  }

  const sessionFile = findSessionFile(sessionKey, sessionId, agentId);
  if (!sessionFile) {
    warn("token-stats", `[computeAndPersist] 未找到会话文件 sessionKey=${sessionKey} agentId=${agentId}`, getEventId());
    return { entry: null, sessionFileFound: false };
  }

  // 1. 读取消息并分词
  const messages: MsgItem[] = [];
  try {
    const text = fs.readFileSync(sessionFile, "utf-8").trim();
    for (const line of text.split("\n")) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== "message") continue;
        const role = msg.message?.role;
        if (!role) continue;
        const content = JSON.stringify(msg.message?.content ?? "");
        messages.push({ role, tokens: countTokens(content) });
      } catch { /* skip malformed */ }
    }
  } catch (err: any) {
    warn("token-stats", `[computeAndPersist] 读取会话文件失败 sessionFile=${sessionFile}: ${err?.message}`, getEventId());
    return { entry: null, sessionFileFound: false };
  }

  // 2. 构建 INPUT/OUTPUT 索引
  //    user 触发 input#0，每个 toolResult 触发下一个 input#
  //    每个 input# 对应一个 output#（assistant）
  let inputIdx = 0;
  let outputIdx = 0;
  const totalInputs = 1 + messages.filter(m => m.role === "toolResult").length;
  const calls: { input: number; output?: number }[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      calls.push({ input: inputIdx });
      inputIdx++;
    } else if (m.role === "assistant") {
      calls.push({ input: inputIdx - 1, output: outputIdx });
      outputIdx++;
    } else if (m.role === "toolResult") {
      calls.push({ input: inputIdx - 1 });
      inputIdx++;
    }
  }
  const totalOutputs = outputIdx;

  // 3. 原始统计（未加权）
  let rawUser = 0, rawAssistant = 0, rawToolResult = 0;
  for (const m of messages) {
    if (m.role === "user") rawUser += m.tokens;
    else if (m.role === "assistant") rawAssistant += m.tokens;
    else if (m.role === "toolResult") rawToolResult += m.tokens;
  }

  // 4. systemPrompt 从缓存取
  const promptText = systemPromptCache.get(agentId);
  const sysPrompt = promptText ? countTokens(promptText) : 0;

  // 5. INPUT/OUTPUT 加权
  // systemPrompt + 全部 28 工具 JSON schema（tiktoken cl100k_base 实测 ≈2500 tokens）
  const TOOL_SCHEMA_TOKENS = 2500;
  let estSysPrompt = (sysPrompt + TOOL_SCHEMA_TOKENS) * totalInputs;
  let estUser = 0;
  let estAsstHistory = 0;
  let estToolResult = 0;
  let estAsstOutput = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const call = calls[i];

    if (m.role === "user") {
      const w = totalInputs - call.input;
      estUser += m.tokens * w;
    } else if (m.role === "assistant") {
      estAsstOutput += m.tokens;                          // 输出一次
      const w = totalInputs - call.input - 1;             // 后续提交中作为历史
      if (w > 0) estAsstHistory += m.tokens * w;
    } else if (m.role === "toolResult") {
      const w = totalInputs - call.input - 1;
      if (w > 0) estToolResult += m.tokens * w;
    }
  }

  const estInputTotal = estSysPrompt + estUser + estAsstHistory + estToolResult;
  const estTotal = estInputTotal + estAsstOutput;
  const userRounds = messages.filter(m => m.role === "user").length;
  const toolRounds = messages.filter(m => m.role === "toolResult").length;

  const entry: TokenStatsEntry = {
    ts: Date.now(),
    sessionKey,
    sessionId,
    userRounds,
    toolRounds,
    inputs: totalInputs,
    outputs: totalOutputs,
    rawUser,
    rawAssistant,
    rawToolResult,
    estSysPrompt,
    estUser,
    estAsstHistory,
    estToolResult,
    estInputTotal,
    estAsstOutput,
    estTotal,
  };

  persist(entry, projectRoot);
  return { entry, sessionFileFound: true };
}

