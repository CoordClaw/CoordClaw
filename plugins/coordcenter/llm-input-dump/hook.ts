/**
 * llm-input-dump Hook 集成
 *
 * v19.25 - LLM 请求导出（完整 system 提示词）
 *
 * 原理：
 * - openclaw 框架在每次 LLM 调用前会触发 llm_input typed hook（fire-and-forget 并行模式）
 * - 本模块通过 api.on("llm_input") 注册 handler，将完整 system prompt + historyMessages 写盘
 * - 通过 globalThis.__coordClawLlmInputDump.enabled 控制开关（team.json 热切换）
 */

import { debug, warn, info, getEventId } from "../shared/logger";
import { writeDumpFile } from "./persistence";
import { LlmInputDumpEvent } from "./types";

const MODULE = "llm-input-dump";

/**
 * 读取开关（globalThis 由 index.ts 初始化时写入，热切换生效）
 */
export function isLlmInputDumpEnabled(): boolean {
  return (globalThis as any).__coordClawLlmInputDump?.enabled === true;
}

/**
 * 注册 llm_input hook 处理器
 *
 * 使用 api.on("llm_input", ...) 注册到框架的 registry.typedHooks（与 before_tool_call/agent_end 同机制），
 * 而非 registerInternalHook（后者写入独立的 globalThis Map，框架 runLlmInput 读不到）
 */
export function registerLlmInputDumpHook(api: any): void {
  try {
    // ============================================================
    // ★★★ 诊断：记录注册时的 api 对象特征，确认 api.on 存在且可调用 ★★★
    // ============================================================
    const apiType = typeof api;
    const hasOn = typeof api?.on === "function";
    debug(MODULE, `[DIAG] registerLlmInputDumpHook called: api.type=${apiType} api.hasOn=${hasOn}`, getEventId());

    api.on("llm_input", async (event: LlmInputDumpEvent, _ctx: any) => {
      // ============================================================
      // ★★★ 诊断：handler 回调入口 —— 第一行就打日志，判断是否被触发 ★★★
      // ============================================================
      const eid = getEventId();
      info(MODULE, `[DIAG] >>> llm_input handler FIRED <<<`, eid);

      // ★★★ 诊断：打印 event 结构概览（不打印完整内容，只打 key 和类型/长度）★★★
      try {
        const eventKeys = event ? Object.keys(event) : ["(event is null/undefined)"];
        const runId = event?.runId ?? "(missing)";
        const provider = event?.provider ?? "(missing)";
        const model = event?.model ?? "(missing)";
        const sysPromptLen = typeof event?.systemPrompt === "string" ? event.systemPrompt.length : `(type=${typeof event?.systemPrompt})`;
        const promptLen = typeof event?.prompt === "string" ? event.prompt.length : `(type=${typeof event?.prompt})`;
        const msgCount = Array.isArray(event?.historyMessages) ? event.historyMessages.length : `(type=${typeof event?.historyMessages})`;
        info(
          MODULE,
          `[DIAG] event keys=[${eventKeys.join(",")}] ` +
          `runId=${runId} provider=${provider} model=${model} ` +
          `sysPromptLen=${sysPromptLen} promptLen=${promptLen} msgCount=${msgCount}`,
          eid,
        );
      } catch (snapErr: any) {
        warn(MODULE, `[DIAG] failed to snapshot event: ${snapErr.message}`, eid);
      }

      // ★★★ 诊断：检查 globalThis 开关状态 ★★★
      const rawGlobal = (globalThis as any).__coordClawLlmInputDump;
      const enabled = isLlmInputDumpEnabled();
      info(
        MODULE,
        `[DIAG] globalThis.__coordClawLlmInputDump = ${JSON.stringify(rawGlobal)} → enabled=${enabled}`,
        eid,
      );

      // 快速短路：开关关闭时不写盘
      if (!isLlmInputDumpEnabled()) {
        info(MODULE, `[DIAG] handler SKIPPED: switch is OFF`, eid);
        return;
      }

      info(MODULE, `[DIAG] calling writeDumpFile...`, eid);
      try {
        await writeDumpFile(event);
        info(MODULE, `[DIAG] writeDumpFile completed OK`, eid);
      } catch (err: any) {
        // 写盘失败仅 warn，不影响 LLM 主流程
        warn(MODULE, `dump handler failed: ${err.message}`, eid);
      }
    });
    debug(MODULE, `llm_input hook registered via api.on()`, getEventId());
  } catch (err: any) {
    warn(MODULE, `register hook failed: ${err.message}`, getEventId());
  }
}
