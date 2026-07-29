import { getEventId, info } from "../shared/logger";
import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute } from "../shared/http-helpers";
import { executeMessageRouting } from "../message-routing";
import { getSessionQueueTracker } from "../message-routing/session-queue-tracker";

const MODULE = "force-route";

export function registerForceRouteRoute(api: any, _config: unknown): void {
  registerPluginRoute(
    api,
    {
      method: "POST",
      path: ROUTES.FORCE_ROUTE,
      auth: "plugin",
      handler: async (_req: any, res: any) => {
        const eventId = getEventId();
        info(MODULE, `[HTTP] force-route 触发`, eventId);

        const keys = getSessionQueueTracker().getTrackedKeys();
        const sk = keys.length > 0 ? keys[0] : "";
        if (!sk) {
          sendJson(res, 400, { success: false, message: "无可用 sessionKey" });
          return;
        }

        try {
          await executeMessageRouting(sk, "force-route-http");
          sendJson(res, 200, { success: true, message: "路由完成", sessionKey: sk });
        } catch (err: any) {
          sendJson(res, 500, { success: false, message: err.message, sessionKey: sk });
        }
      },
    },
    MODULE
  );
}