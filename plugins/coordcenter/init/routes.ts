/**
 * 路由注册 — Phase 3+4
 *
 * 数据驱动 20 个 HTTP 路由注册。
 * 从原来的 170+ 行重复样板压缩为表驱动循环。
 */

import type { BootContext } from "./environment";
import { setConfig } from "../message-routing";
import { registerSessionResetRoute } from "../session-reset";
import { registerSessionDeleteRoute } from "../session-delete";
import { registerTestRpcRoute } from "../test-rpc";
import { registerSessionAbortRoute } from "../session-abort";
import { registerSessionSteerRoute } from "../session-steer";
import { registerWorkspaceResetRoute } from "../workspace-reset";
import { registerCacheRefreshRoute } from "../cache-refresh/http-route";
import { registerCacheSyncRoute } from "../cache-sync";
import { registerSessionKeyGeneratorRoutes } from "../session-key-generator";
import { registerSessionSnapshotRoute } from "../session-snapshot";
import { registerWebchat } from "../webchat";
import { registerLlmInputDumpRoute } from "../llm-input-dump";
import { registerForceRouteRoute } from "../force-route";
import { registerTeamCreateRoute, registerTeamRepairRoute } from "../team-create";
import { registerProjectCreateRoute } from "../project-create";
import { registerProjectDeleteRoute } from "../project-delete";
import { registerProjectSwitchRoute } from "../project-switch";
import { registerWebchatWidgetRoutes } from "../webchat-widget";
import { registerTeamDeleteRoute } from "../team-delete";
import { registerModelListRoute, registerModelSetRoute } from "../model-manage";
import { registerSkillListRoute, registerSkillSetRoute } from "../skill-manage";
import { registerConfigPatchRoute, registerConfigApplyRoute, registerConfigGetRoute } from "../config-manage";
import { registerApiDocsRoute } from "../api-docs";
import { debug, info, warn, error, getEventId } from "../shared/logger";

interface RouteEntry {
  name: string;
  register: (api: any, config?: any) => void;
  needsConfig: boolean;
}

const ROUTE_TABLE: RouteEntry[] = [
  { name: 'session-reset',         register: registerSessionResetRoute,         needsConfig: true  },
  { name: 'session-delete',        register: registerSessionDeleteRoute,        needsConfig: false },
  { name: 'test-rpc',              register: registerTestRpcRoute,              needsConfig: true  },
  { name: 'session-abort',         register: registerSessionAbortRoute,         needsConfig: true  },
  { name: 'session-steer',         register: registerSessionSteerRoute,         needsConfig: true  },
  { name: 'workspace-reset',       register: registerWorkspaceResetRoute,       needsConfig: true  },
  { name: 'cache-refresh',         register: registerCacheRefreshRoute,         needsConfig: false },
  { name: 'cache-sync',            register: registerCacheSyncRoute,            needsConfig: false },
  { name: 'session-key-generator', register: registerSessionKeyGeneratorRoutes, needsConfig: true  },
  { name: 'session-snapshot',      register: registerSessionSnapshotRoute,      needsConfig: false },
  { name: 'webchat',               register: registerWebchat,                   needsConfig: false },
  { name: 'llm-input-dump',        register: registerLlmInputDumpRoute,         needsConfig: false },
  { name: 'force-route',           register: registerForceRouteRoute,           needsConfig: true  },
  { name: 'team-create',           register: registerTeamCreateRoute,           needsConfig: false },
  { name: 'team-repair',           register: registerTeamRepairRoute,           needsConfig: false },
  { name: 'project-create',        register: registerProjectCreateRoute,        needsConfig: false },
  { name: 'project-delete',        register: registerProjectDeleteRoute,        needsConfig: false },
  { name: 'project-switch',        register: registerProjectSwitchRoute,        needsConfig: false },
  { name: 'webchat-widget',        register: registerWebchatWidgetRoutes,       needsConfig: false },
  { name: 'team-delete',           register: registerTeamDeleteRoute,           needsConfig: false },
  { name: 'model-list',            register: registerModelListRoute,            needsConfig: false },
  { name: 'model-set',             register: registerModelSetRoute,             needsConfig: false },
  { name: 'skill-list',            register: registerSkillListRoute,            needsConfig: false },
  { name: 'skill-set',             register: registerSkillSetRoute,             needsConfig: false },
  { name: 'config-patch',          register: registerConfigPatchRoute,          needsConfig: false },
  { name: 'config-apply',          register: registerConfigApplyRoute,          needsConfig: false },
  { name: 'config-get',            register: registerConfigGetRoute,            needsConfig: false },
  { name: 'api-docs',              register: registerApiDocsRoute,              needsConfig: false },
];

export function initRoutes(api: any, ctx: BootContext): void {
  setConfig(ctx.jsonPath, ctx.cacheTtl, ctx.stateDir);

  const configArg = { jsonPath: ctx.jsonPath, cacheTtl: ctx.cacheTtl };

  for (const route of ROUTE_TABLE) {
    try {
      const args: [any, any?] = route.needsConfig ? [api, configArg] : [api];
      route.register(...args);
      debug('plugin', `[INIT] ${route.name} 路由注册成功`, getEventId());
    } catch (err: any) {
      error('plugin', `[INIT] ${route.name} 注册失败(非致命): ${err.message}`, getEventId());
    }
  }

  // Agent 修复已迁移到 Phase 7（index.ts），在抢先配对之后且支持 config.apply 热加载
  // 此处不再重复调用
}
