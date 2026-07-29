/**
 * llm-input-dump 类型定义
 *
 * v19.25 - LLM 请求导出（完整 system 提示词）
 */

/**
 * team.json 中 llm_input_dump 配置段
 */
export interface LlmInputDumpConfig {
  /** 总开关（热切换，无需重启） */
  enabled?: boolean;
}

/**
 * llm_input Hook 事件载荷（来自 openclaw 框架的 runLlmInput 调用）
 */
export interface LlmInputDumpEvent {
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** 完整 system 提示词（★ jsonl 文件不含） */
  systemPrompt?: string;
  /** 本轮 user prompt */
  prompt?: string;
  /** 完整对话历史（含所有 tool_call / tool_result） */
  historyMessages?: any[];
  /** 图片数量 */
  imagesCount?: number;
}

/**
 * 写入磁盘的 dump 记录
 */
export interface LlmInputDumpRecord {
  timestamp: string;
  runId: string;
  sessionKey: string | null;
  agentId: string | null;
  turnSeq: number;
  provider: string | null;
  model: string | null;
  systemPrompt: string | null;
  systemPromptLength: number;
  userPrompt: string | null;
  messages: any[] | null;
  messageCount: number;
  imagesCount: number;
}
