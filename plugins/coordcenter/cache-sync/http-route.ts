import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute } from "../shared/http-helpers";
import { info, error, getEventId } from "../shared/logger";
import { syncTeamData } from "../shared/cache-coordinator";

const MODULE = "cache-sync";

export function registerCacheSyncRoute(api: any): void {
  const routeDef = {
    method: "POST",
    path: ROUTES.CACHE_SYNC,
    auth: "plugin",
    handler: async (_req: any, res: any) => {
      const eventId = getEventId();
      info(MODULE, `[HTTP] 收到数据同步请求`, eventId);

      try {
        const result = await syncTeamData();

        sendJson(res, 200, {
          ok: result.ok,
          message: result.message,
          projectRoot: result.projectRoot,
          memberCount: result.memberCount,
          syncStats: result.syncStats,
          errors: result.errors.length > 0 ? result.errors : undefined,
          timestamp: new Date().toISOString(),
        });

        info(MODULE, `[HTTP] ${result.ok ? "数据同步成功" : "数据同步部分完成"}: ${result.message}`, eventId);
      } catch (err: any) {
        error(MODULE, `[HTTP] 数据同步失败: ${err.message}`, eventId);
        sendJson(res, 500, {
          ok: false,
          message: `数据同步失败: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    },
  };

  registerPluginRoute(api, routeDef, MODULE);
}