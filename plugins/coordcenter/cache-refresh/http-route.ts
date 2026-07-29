import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute } from "../shared/http-helpers";
import { info, error, getEventId } from "../shared/logger";
import { reloadFileCache } from "../shared/cache-coordinator";

const MODULE = "cache-refresh";

export function registerCacheRefreshRoute(api: any): void {
  const routeDef = {
    method: "POST",
    path: ROUTES.CACHE_REFRESH,
    auth: "plugin",
    handler: async (_req: any, res: any) => {
      const eventId = getEventId();
      info(MODULE, `[HTTP] 收到缓存刷新请求`, eventId);

      try {
        const result = await reloadFileCache();

        sendJson(res, 200, {
          ok: result.ok,
          message: result.message,
          projectRoot: result.projectRoot,
          errors: result.errors.length > 0 ? result.errors : undefined,
          timestamp: new Date().toISOString(),
        });

        info(MODULE, `[HTTP] ${result.ok ? "缓存刷新成功" : "缓存刷新部分完成"}: ${result.message}`, eventId);
      } catch (err: any) {
        error(MODULE, `[HTTP] 缓存刷新失败: ${err.message}`, eventId);
        sendJson(res, 500, {
          ok: false,
          message: `缓存刷新失败: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    },
  };

  registerPluginRoute(api, routeDef, MODULE);
}