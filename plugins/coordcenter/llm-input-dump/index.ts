/**
 * 功能模块：LLM 请求导出（llm-input-dump）
 *
 * v19.25 - LLM 请求导出（完整 system 提示词）
 *
 * 对外暴露：
 * - registerLlmInputDumpRoute(): 注册 HTTP 路由（清空 dump）
 * - registerLlmInputDumpHook(): 注册 llm_input hook（自动写盘）
 * - isLlmInputDumpEnabled(): 读取开关（globalThis）
 *
 * 写入策略：
 * - 通过 openclaw plugin-sdk 的 registerInternalHook('llm_input') 注册
 * - 每次 LLM 调用前 fire-and-forget 异步写盘
 * - 文件布局：%APPDATA%/CoordClaw/llm-input-dump/{runId}/turn_NNN.json
 * - 开关：team.json llm_input_dump.enabled（默认 false，globalThis 热切换）
 */

export { registerLlmInputDumpRoute } from "./http-route";
export { registerLlmInputDumpHook, isLlmInputDumpEnabled } from "./hook";
