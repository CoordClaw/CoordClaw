/**
 * 广播初始化 — Phase 5
 *
 * Gateway 广播 v2 客户端：连接 → 重试 → team loader for run-lifecycle tracking。
 */

import type { BootContext } from "./environment";
import * as broadcastV2 from "../webchat/broadcast-v2";
import { debug, info, warn, error, getEventId } from "../shared/logger";

export function initBroadcast(api: any, ctx: BootContext): void {
  try {
    const broadcastEnabled = (api.pluginConfig?.broadcastEnabled as boolean) !== false;

    if (!broadcastEnabled) {
      info('plugin', `[INIT] Broadcast feature disabled (set broadcastEnabled=true to enable)`, getEventId());
      return;
    }

    debug('plugin', `[INIT] Broadcast feature enabled, initializing safe client...`, getEventId());

    try {
      broadcastV2.setEnabled(true);
      broadcastV2.setRuntime(api.runtime);
    } catch (err: any) {
      debug('plugin', `[INIT] Broadcast setEnabled/setRuntime error: ${err.message}`, getEventId());
    }

    const initBroadcastWithRetry = async (maxRetries = 3, delayMs = 2000) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await broadcastV2.startBroadcastClientV2();
          info('plugin', `[INIT] Broadcast init complete (attempt ${attempt}/${maxRetries}): connected=${broadcastV2.getBroadcastStatus()}`, getEventId());

          if (broadcastV2.getBroadcastStatus()) {
            import("../shared/team-loader").then(async (teamLoader) => {
              try {
                const teamContext = await teamLoader.loadTeamContext(ctx.jsonPath, ctx.cacheTtl, "run-tracker");
                const sessionKeys = teamContext.members
                  .map((m: any) => m.sessionKey)
                  .filter((k: string) => k && k.length > 0);
                if (sessionKeys.length > 0) {
                  broadcastV2.setTrackedSessionKeys(sessionKeys);
                  debug('plugin', `[INIT] Run lifecycle tracker enabled for ${sessionKeys.length} team members`, getEventId());
                }
              } catch (teamErr: any) {
                debug('plugin', `[INIT] Team load for run tracker failed (non-fatal): ${teamErr.message}`, getEventId());
              }
            });
          }
          return;
        } catch (err: any) {
          if (attempt < maxRetries) {
            warn('plugin', `[INIT] Broadcast init attempt ${attempt}/${maxRetries} failed: ${err.message}, retrying in ${delayMs}ms...`, getEventId());
            await new Promise(r => setTimeout(r, delayMs));
          } else {
            error('plugin', `[INIT] Broadcast init all ${maxRetries} attempts failed: ${err.message}`, getEventId());
          }
        }
      }
    };
    setTimeout(() => initBroadcastWithRetry(), 5000);
  } catch (e) {
    debug('plugin', `[INIT] Broadcast outer catch: ${e instanceof Error ? e.message : String(e)}`, getEventId());
  }
}
