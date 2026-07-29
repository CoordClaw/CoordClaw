export const ROUTE_PREFIX = "/coordclaw-plugin/coordclawcenter";

export const ROUTES = {
  SESSION_RESET:    `${ROUTE_PREFIX}/session-reset`,
  SESSION_DELETE:   `${ROUTE_PREFIX}/session-delete`,
  SESSION_ABORT:    `${ROUTE_PREFIX}/session-abort`,
  SESSION_ABORT_DEBUG: `${ROUTE_PREFIX}/session-abort-debug`,
  SESSION_STEER_DEBUG: `${ROUTE_PREFIX}/session-steer-debug`,
  FORCE_ROUTE:      `${ROUTE_PREFIX}/force-route`,
  TEAM_CREATE:          `${ROUTE_PREFIX}/team-create`,
  TEAM_REPAIR:          `${ROUTE_PREFIX}/team-repair`,
  PROJECT_CREATE:       `${ROUTE_PREFIX}/project-create`,
  PROJECT_DELETE:       `${ROUTE_PREFIX}/project-delete`,
  PROJECT_SWITCH:       `${ROUTE_PREFIX}/project-switch`,
  TEAM_DELETE:          `${ROUTE_PREFIX}/team-delete`,
  WIDGET_CONFIG:        `${ROUTE_PREFIX}/webchat/config`,
  WIDGET_JS:            `${ROUTE_PREFIX}/webchat/widget.js`,
  WIDGET_CSS:           `${ROUTE_PREFIX}/webchat/widget.css`,
  MSG_TO_PM:        `${ROUTE_PREFIX}/msgtopm`,
  WORKSPACE_RESET:  `${ROUTE_PREFIX}/workspace-reset`,
  CACHE_REFRESH:    `${ROUTE_PREFIX}/cache-refresh`,
  CACHE_SYNC:       `${ROUTE_PREFIX}/cache-sync`,
  SESSION_KEY_GENERATE: `${ROUTE_PREFIX}/session-key-generate`,
  SESSION_KEY_SHOW:     `${ROUTE_PREFIX}/session-key-show`,
  SESSION_SNAPSHOT:    `${ROUTE_PREFIX}/session-snapshot`,
  LLM_INPUT_DUMP_CLEAR: `${ROUTE_PREFIX}/llm-input-dump/clear`,
  MODEL_LIST:         `${ROUTE_PREFIX}/model-list`,
  MODEL_SET:          `${ROUTE_PREFIX}/model-set`,
  SKILL_LIST:         `${ROUTE_PREFIX}/skill-list`,
  SKILL_SET:          `${ROUTE_PREFIX}/skill-set`,
  CONFIG_PATCH:       `${ROUTE_PREFIX}/config-patch`,
  CONFIG_APPLY:       `${ROUTE_PREFIX}/config-apply`,
  CONFIG_GET:         `${ROUTE_PREFIX}/config-get`,
  API_DOCS:             `${ROUTE_PREFIX}/api-docs`,
} as const;

export interface RouteMeta {
  path: string;
  method: string;
  auth: string;
  desc: string;
  params?: Record<string, string>;
  /** 响应示例与字段说明 */
  response?: {
    /** 成功响应示例 */
    example: Record<string, any>;
    /** 各字段说明 */
    fields?: Record<string, string>;
    /** 可能的错误码及说明 */
    errors?: string[];
  };
}

export const ROUTE_REGISTRY: RouteMeta[] = [
  {
    path: ROUTES.WORKSPACE_RESET,
    method: "POST",
    auth: "plugin",
    desc: "团队重置：清空所有成员的session+workspace，重建SOUL.md",
    params: { reason: "string (optional, 重置原因)" },
    response: {
      example: { success: true, message: "团队重置完成", resetCount: 7, totalMembers: 7 },
      fields: { success: "是否成功", message: "结果描述", resetCount: "成功重置的成员数", totalMembers: "团队总成员数" },
      errors: ["workspace 目录删除失败", "SOUL.md 写入失败"],
    },
  },
  {
    path: ROUTES.SESSION_RESET,
    method: "POST",
    auth: "plugin",
    desc: "会话重置：清空所有团队成员的AI对话历史",
    params: { sessionKey: "string (optional, 不传则重置所有团队成员)" },
    response: {
      example: { success: true, message: "成功重置指定会话", resetCount: 1, totalMembers: 1, details: [{ name: "single", agentId: "single", sessionKey: "...", reset: true }] },
      fields: { success: "是否成功", message: "结果描述", resetCount: "成功重置的会话数", details: "每个成员的重置详情" },
      errors: ["sessionKey 无效"],
    },
  },
  {
    path: ROUTES.SESSION_DELETE,
    method: "POST",
    auth: "plugin",
    desc: "删除会话：根据 sessionKey 销毁指定会话",
    params: { sessionKey: "string (必填, 会话标识)" },
    response: {
      example: { success: true, message: "会话 agent:xxx:xxx 删除成功", sessionKey: "agent:xxx:xxx", deleted: true },
      fields: { success: "是否成功", message: "结果描述", sessionKey: "会话标识", deleted: "是否成功删除" },
      errors: ["sessionKey 缺失", "RPC 调用失败"],
    },
  },
  {
    path: ROUTES.SESSION_ABORT,
    method: "POST",
    auth: "plugin",
    desc: "会话中止：立即停止指定agent的运行",
    params: { sessionKey: "string (optional, 不传则中止所有团队成员)" },
    response: {
      example: { success: true, message: "会话 ... 已停止", sessionKey: "..." },
      fields: { success: "是否成功", message: "结果描述", sessionKey: "中止的会话标识" },
      errors: ["sessionKey 未找到"],
    },
  },
  {
    path: ROUTES.SESSION_ABORT_DEBUG,
    method: "POST",
    auth: "plugin",
    desc: "会话中止调试：中止会话并返回详细诊断信息（runId、状态等）",
    params: { sessionKey: "string (必填)" },
    response: {
      example: { success: true, message: "会话已停止（调试模式）", sessionKey: "...", debug: { runId: "...", status: "aborted" } },
      fields: { success: "是否成功", message: "结果描述", debug: "诊断信息（runId、状态等）" },
      errors: ["sessionKey 必填", "sessionKey 未找到"],
    },
  },
  {
    path: ROUTES.FORCE_ROUTE,
    method: "POST",
    auth: "plugin",
    desc: "强制路由：跳过信号层直接触发状态计算和消息分发（适用于信号丢失或状态卡死时的恢复）",
    params: { sessionKey: "string (可选, 不传则对所有成员执行)" },
    response: {
      example: { success: true, message: "路由已触发 (source=force-route-http)", sessionKey: "...", routedCount: 1, totalMembers: 7, details: [{ name: "陈默", agentId: "chenmo-pm", sessionKey: "...", routed: true }] },
      fields: { success: "是否成功", routedCount: "成功触发的成员数", totalMembers: "总成员数", details: "每个成员的路由结果" },
      errors: ["sessionKey 无效"],
    },
  },
  {
    path: ROUTES.TEAM_CREATE,
    method: "POST",
    auth: "plugin",
    desc: "新建团队：校验团队目录结构 → 补充模板文件 → 解析 teamsoul.md → 扩展 openclaw.json + coordclaw.json → 批量创建 agent workspace + SOUL.md → 写入 team.json",
    params: { teamId: "string (必填, 团队ID, 如 'team-c', coordclaw-teams/{teamId}/.data/ 目录必须已由前端创建)" },
    response: {
      example: { success: true, message: "团队 team-c 创建成功...", phase1: { success: true, teamId: "team-c", teamDir: "C:\\...\\.qclaw\\coordclaw-teams\\team-c", dataDir: "C:\\...\\.qclaw\\coordclaw-teams\\team-c\\.data", templateCopied: true, copiedFiles: ["data","scripts"] }, phase2: { success: true, agentsCreated: 7, totalAgents: 7, agents: [{ agentId: "chenmo-pm", name: "陈默-产品经理", workspaceDir: "...", soulWritten: true }], openclawJsonUpdated: true, coordclawJsonUpdated: true, teamJsonWritten: true }, warnings: [] },
      fields: { success: "是否成功", phase1: "Phase1 结果（目录校验+模板复制）", phase2: "Phase2 结果（agent 创建+注册+team.json 写入）", warnings: "一致性警告列表（如 agent_id 不一致）" },
      errors: ["teamId 格式无效", "teamId 已存在", "teamsoul.md 缺失或解析失败", "openclaw.json/coordclaw.json 注册失败"],
    },
  },
  {
    path: ROUTES.TEAM_REPAIR,
    method: "POST",
    auth: "plugin",
    desc: "Agent 修复/初始化：根据 coordclaw.json 团队配置，补回 openclaw.json 中缺失的 agent 条目并重建 workspace",
    params: { teamIds: "string[] (可选, 不传则修复所有已注册团队)" },
    response: {
      example: { success: true, teamsProcessed: 1, agentsMissing: 3, agentsRepaired: 2, agentsFailed: 1, details: [{ teamId: "CoordClawAITeam_zh", agentId: "chenmo-pm", status: "repaired" }] },
      fields: { success: "是否成功", teamsProcessed: "处理的团队数", agentsMissing: "缺失的 agent 数", agentsRepaired: "修复成功数", agentsFailed: "修复失败数", details: "每个 agent 的修复详情" },
      errors: ["coordclaw.json 不存在", "openclaw.json 不存在", "teamsoul.md 缺失或解析失败"],
    },
  },
  {
    path: ROUTES.PROJECT_CREATE,
    method: "POST",
    auth: "plugin",
    desc: "新建项目：校验团队注册状态 → 生成项目ID → 注册到 coordclaw.json → 复制团队模板 → 从 team.json 读取成员 → 创建 sessionKey → 填入 project_name + sessionKey → 全量刷新缓存",
    params: {
      teamId: "string (必填, 已注册的团队ID)",
      projectName: "string (必填, 项目名称)",
      projectPath: "string (必填, 项目根目录绝对路径, 不存在则自动创建)",
    },
    response: {
      example: { success: true, message: "项目 新项目 (CoordClawTeam_0001) 创建成功: 路径=D:/projects/new-project, 成员=7, sessionKey=7", projectId: "CoordClawTeam_0001", projectName: "新项目", projectPath: "D:/projects/new-project/", teamId: "team-c", teamName: "CoordClawTeam", sessionKeysCreated: 7, totalMembers: 7 },
      fields: { success: "是否成功", projectId: "生成的项目ID（格式: teamName_0001）", sessionKeysCreated: "成功创建的 sessionKey 数量", totalMembers: "团队成员总数" },
      errors: ["团队未注册", "projectPath 创建失败", "模板复制失败", "team.json 不存在或 members 为空", "sessionKey 创建失败"],
    },
  },
  {
    path: ROUTES.PROJECT_DELETE,
    method: "POST",
    auth: "plugin",
    desc: "删除项目：校验团队及项目注册状态 → 删除所有成员 session → 从 coordclaw.json 移除项目条目 → 全量刷新缓存",
    params: {
      teamId: "string (必填, 已注册的团队ID)",
      projectId: "string (必填, 项目ID, 如 'DataAnalysisTeam_0001')",
    },
    response: {
      example: { success: true, message: "项目 CoordClawTeam_0001 删除成功: 5/5 个 session 已销毁", teamId: "team-c", projectId: "CoordClawTeam_0001", sessionsDeleted: 5, totalMembers: 5, details: [{ agentId: "chenmo-pm", agentName: "陈默", sessionKey: "...", deleted: true }] },
      fields: { success: "是否成功", sessionsDeleted: "成功销毁的 session 数量", details: "每个成员的删除结果" },
      errors: ["团队未注册", "项目未找到", "session 销毁失败"],
    },
  },
  {
    path: ROUTES.PROJECT_SWITCH,
    method: "POST",
    auth: "plugin",
    desc: "切换激活项目：将指定项目设为 active，其余全部置为 inactive，并更新 team.json 中的网关配置",
    params: {
      teamId: "string (必填, 已注册的团队ID)",
      projectId: "string (必填, 项目ID, 如 'CoordClawTeam_0001')",
    },
    response: {
      example: { success: true, message: "已切换至项目 新项目 (CoordClawTeam_0001): 停用 2 个项目", teamId: "team-c", projectId: "CoordClawTeam_0001", projectName: "新项目", deactivatedCount: 2, gatewayUrl: "http://127.0.0.1:28789", openclawUserDir: "C:\\Users\\...\\.qclaw" },
      fields: { success: "是否成功", teamId: "团队ID", projectId: "项目ID", projectName: "项目名称", deactivatedCount: "被停用的项目数", gatewayUrl: "写入的网关地址", openclawUserDir: "写入的用户目录" },
      errors: ["缺少必填参数", "团队未注册", "项目未找到"],
    },
  },
  {
    path: ROUTES.WIDGET_CONFIG,
    method: "GET",
    auth: "plugin",
    desc: "WebChat Widget 配置接口：返回 Gateway WS/HTTP 地址和可用 session 列表",
    params: {},
    response: {
      example: { success: true, wsUrl: "ws://127.0.0.1:28789", httpUrl: "http://127.0.0.1:28789", sessions: [{ sessionKey: "agent/default/main", displayName: "助手" }] },
      fields: { success: "是否成功", wsUrl: "WebSocket 地址", httpUrl: "HTTP 地址", sessions: "可用 session 列表" },
    },
  },
  {
    path: ROUTES.WIDGET_JS,
    method: "GET",
    auth: "plugin",
    desc: "WebChat Widget SDK JavaScript（前端引入后可创建 WebChatWidget 实例）",
    params: {},
    response: { example: {}, fields: {} },
  },
  {
    path: ROUTES.WIDGET_CSS,
    method: "GET",
    auth: "plugin",
    desc: "WebChat Widget 样式表（支持 light/dark 双主题）",
    params: {},
    response: { example: {}, fields: {} },
  },
  {
    path: ROUTES.TEAM_DELETE,
    method: "POST",
    auth: "plugin",
    desc: "删除团队：校验团队注册 → 从 .data/team.json 提取成员 agent_id → 从 openclaw.json 移除对应 agents → 从 coordclaw.json 移除团队注册",
    params: {
      teamId: "string (必填, 已注册的团队ID, 如 'DataAnalysisTeam')",
    },
    response: {
      example: { success: true, message: "团队 DataAnalysisTeam 删除成功: 7/7 个 agent 已从 openclaw.json 移除", teamId: "DataAnalysisTeam", teamName: "DataAnalysisTeam", agentsRemoved: 7, totalAgents: 7, details: [{ agentId: "chence-pm-abxcd", name: "陈策", removed: true }], openclawJsonUpdated: true, coordclawJsonUpdated: true },
      fields: { success: "是否成功", teamId: "团队ID", teamName: "团队名称", agentsRemoved: "成功移除的 agent 数量", totalAgents: "团队成员总数", details: "每个 agent 的删除详情" },
      errors: ["teamId 缺失或为空", "团队未在 coordclaw.json 中注册", "openclaw.json 写入失败", "coordclaw.json 写入失败"],
    },
  },
  {
    path: ROUTES.SESSION_STEER_DEBUG,
    method: "POST",
    auth: "plugin",
    desc: "会话引导：向正在运行的agent注入消息（用于干预推理循环）",
    params: { sessionKey: "string (必填)", message: "string (可选, 默认: '你刚刚陷入推理循环了')" },
    response: {
      example: { success: true, message: "引导消息已注入", sessionKey: "...", injectedMessage: "..." },
      fields: { success: "是否成功", injectedMessage: "实际注入的消息内容" },
      errors: ["sessionKey 必填", "Agent 未在运行中"],
    },
  },
  {
    path: ROUTES.MSG_TO_PM,
    method: "POST",
    auth: "plugin",
    desc: "RPC消息：发送消息到PM（项目经理）",
    params: { message: "string" },
    response: {
      example: { success: true, message: "消息已发送到 PM", result: { status: "sent" } },
      fields: { success: "是否成功", result: "RPC 调用结果" },
      errors: ["PM sessionKey 未找到", "RPC 调用失败"],
    },
  },
  {
    path: ROUTES.CACHE_REFRESH,
    method: "POST",
    auth: "plugin",
    desc: "缓存刷新：清除文件读取缓存并重新加载（仅 L1+L5，不碰运行时状态和运行中 agent）",
    response: {
      example: { ok: true, message: "文件缓存重载成功 — projectRoot=D:/projects/energy/", projectRoot: "D:/projects/energy/" },
      fields: { ok: "是否成功", message: "结果描述", projectRoot: "当前激活的项目路径" },
      errors: [],
    },
  },
  {
    path: ROUTES.CACHE_SYNC,
    method: "POST",
    auth: "plugin",
    desc: "数据同步：增量同步团队数据到运行时缓存（新增/更新成员，保留 processing 状态，不丢运行中 agent 上下文）",
    response: {
      example: { ok: true, message: "运行时数据同步成功 — projectRoot=..., members=8", projectRoot: "D:/projects/energy/", memberCount: 8, syncStats: { added: 0, updated: 1, retained: 7, removed: 0, skipped: 0 } },
      fields: { ok: "是否成功", memberCount: "当前成员数", syncStats: "同步统计（新增/更新/保留/移除/跳过）" },
      errors: [],
    },
  },
  {
    path: ROUTES.SESSION_KEY_GENERATE,
    method: "POST",
    auth: "plugin",
    desc: "批量创建SessionKey：为team.json中缺少sessionkey的agent创建新sessionkey",
    params: {
      teamJsonPath: "string (可选, 默认使用插件配置的jsonPath)",
      agentIds: "string[] (可选, 只为指定的agent创建)",
      force: "boolean (可选, 强制重新创建)",
    },
    response: {
      example: { success: true, message: "完成: 成功=4, 跳过=3, 失败=0, 总数=7", results: [{ agentId: "chenmo-pm", success: true, sessionKey: "..." }], updated: 4, failed: 0, total: 7 },
      fields: { success: "是否成功", updated: "成功更新的数量", failed: "失败的数量", total: "总成员数", results: "每个 agent 的创建结果" },
      errors: ["RPC 调用失败", "team.json 读取失败"],
    },
  },
  {
    path: ROUTES.SESSION_KEY_SHOW,
    method: "POST",
    auth: "plugin",
    desc: "显示SessionKey状态：查看team.json中所有agent的sessionkey状态",
    params: { teamJsonPath: "string (可选, 默认使用插件配置的jsonPath)" },
    response: {
      example: { ok: true, members: [{ agentId: "chenmo-pm", agentName: "陈默", sessionKey: "agent:chenmo-pm:dashboard:xxx", hasKey: true, createdAt: "2026-06-10T..." }] },
      fields: { ok: "是否成功", members: "各成员的 sessionKey 状态列表" },
      errors: ["team.json 读取失败"],
    },
  },
  {
    path: ROUTES.SESSION_SNAPSHOT,
    method: "GET",
    auth: "plugin",
    desc: "会话状态快照：获取所有/指定sessionKey的完整运行状态（运行窗口、run历史、token消耗、工具调用次数）",
    params: { sessionKey: "string (可选, 不传则返回全部sessionKey的快照)" },
    response: {
      example: { ok: true, count: 8, snapshots: [{ agentId: "chenmo-pm", agentName: "陈默", sessionKey: "...", roundIndex: 3, status: "idle", state: "ended", startedAt: "2026-06-10T...", endedAt: "2026-06-10T...", totalTokens: 15000, totalToolCalls: 12, runs: [{ runId: "...", startedAt: "...", endedAt: "...", toolCount: 5, tokens: { input: 5000, output: 3000, cacheRead: 2000, cacheWrite: 1000, total: 11000 } }] }] },
      fields: { ok: "是否成功", count: "快照数量", snapshots: "会话快照数组（含运行历史、token 统计等）" },
      errors: [],
    },
  },
  {
    path: ROUTES.LLM_INPUT_DUMP_CLEAR,
    method: "POST",
    auth: "plugin",
    desc: "LLM 请求导出清理：清空 %APPDATA%/CoordClaw/llm-input-dump/ 全部内容（仅在 llm_input_dump.enabled=true 时才有内容）",
    response: {
      example: { ok: true, message: "已清空 llm-input-dump 全部内容（N 个文件）", clearedPath: "C:\\Users\\...\\AppData\\Roaming\\CoordClaw\\llm-input-dump", clearedCount: 15, timestamp: "2026-06-11T04:49:37.139Z" },
      fields: { ok: "是否成功", clearedPath: "清理的目录路径", clearedCount: "清理的文件数量", timestamp: "清理时间戳" },
      errors: [],
    },
  },
  {
    path: ROUTES.MODEL_LIST,
    method: "GET",
    auth: "plugin",
    desc: "获取可用模型列表：调用 Gateway models.list RPC，返回 provider/model/contextWindow/reasoning 等字段",
    response: {
      example: { success: true, models: [{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai", contextWindow: 200000, reasoning: false }] },
      fields: { success: "是否成功", models: "模型数组", message: "错误信息" },
      errors: ["Gateway 不可达时返回 success=false"],
    },
  },
  {
    path: ROUTES.MODEL_SET,
    method: "POST",
    auth: "plugin",
    desc: "设置 session 模型：调用 sessions.patch RPC，支持切换或重置为默认",
    params: { sessionKey: "string (必填)", model: "string (可选, provider/model 或 null 重置)" },
    response: {
      example: { success: true, sessionKey: "agent:xxx:...", modelProvider: "openai", model: "gpt-5.4" },
      fields: { success: "是否成功", sessionKey: "会话标识", modelProvider: "解析后的 provider", model: "解析后的 model" },
      errors: ["sessionKey 为空", "Gateway 不可达"],
    },
  },
  {
    path: ROUTES.SKILL_LIST,
    method: "GET",
    auth: "plugin",
    desc: "获取 Skill 列表：调用 Gateway skills.status RPC，返回 name/description/disabled/eligible 等字段",
    response: {
      example: { success: true, skills: [{ name: "pdf", description: "PDF reading and creation", source: "openclaw-bundled", disabled: false, eligible: true }] },
      fields: { success: "是否成功", skills: "Skill 数组", message: "错误信息" },
      errors: ["Gateway 不可达时返回 success=false"],
    },
  },
  {
    path: ROUTES.SKILL_SET,
    method: "POST",
    auth: "plugin",
    desc: "开关 Skill：通过 config.patch 写入 openclaw.json skills.entries，触发热加载",
    params: { skillName: "string (必填)", enabled: "boolean (可选，默认 true)" },
    response: {
      example: { success: true, skillName: "pdf", enabled: false },
      fields: { success: "是否成功", skillName: "Skill 名", enabled: "启用/禁用", message: "错误信息" },
      errors: ["skillName 为空", "Gateway 不可达"],
    },
  },
  {
    path: ROUTES.CONFIG_PATCH,
    method: "POST",
    auth: "plugin",
    desc: "部分更新 openclaw.json：调用 Gateway config.patch RPC，深度 merge 到现有配置，触发热加载",
    params: { raw: "string (必填, JSON5 格式)" },
    response: {
      example: { success: true, noop: false },
      fields: { success: "是否成功", noop: "是否无变更", message: "错误信息" },
      errors: ["raw 为空", "Gateway 不可达"],
    },
  },
  {
    path: ROUTES.CONFIG_APPLY,
    method: "POST",
    auth: "plugin",
    desc: "完整替换 openclaw.json：调用 Gateway config.apply RPC，传入完整配置对象",
    params: { "body": "object (必填, 完整 openclaw.json 配置对象)" },
    response: {
      example: { success: true },
      fields: { success: "是否成功", message: "错误信息" },
      errors: ["body 为空或非对象", "Gateway 不可达"],
    },
  },
  {
    path: ROUTES.CONFIG_GET,
    method: "GET",
    auth: "plugin",
    desc: "获取当前 openclaw.json 配置快照：调用 Gateway config.get RPC，敏感字段已脱敏",
    response: {
      example: { success: true, config: {} },
      fields: { success: "是否成功", config: "脱敏后的 openclaw.json 配置对象", message: "错误信息" },
      errors: ["Gateway 不可达时返回 success=false"],
    },
  },
];