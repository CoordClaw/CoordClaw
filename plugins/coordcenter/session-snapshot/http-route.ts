import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute } from "../shared/http-helpers";
import { info, error, getEventId } from "../shared/logger";
import { getSessionActivityCache, getSessionRecordBySessionKey } from "../message-routing";
import { serveSnapshotSSE, buildSnapshotRecord } from "./snapshot-events";

const MODULE = "session-snapshot";

export function registerSessionSnapshotRoute(api: any): void {
  // JSON 查询（原有）
  registerPluginRoute(api, {
    method: "GET",
    path: ROUTES.SESSION_SNAPSHOT,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      const eventId = getEventId();
      const url = new URL(req.url ?? "", `http://${req.headers?.host ?? "localhost"}`);
      const filterKey = url.searchParams.get("sessionKey") ?? "";
      const stream = url.searchParams.get("stream") === "true";

      if (stream) {
        info(MODULE, `[SSE] 客户端连接`, eventId);
        serveSnapshotSSE(res);
        return;
      }

      info(MODULE, `[HTTP] 收到快照请求 filterKey=${filterKey || '(all)'}`, eventId);

      try {
        const cache = getSessionActivityCache();
        const snapshots: Record<string, any>[] = [];

        if (filterKey) {
          const record = getSessionRecordBySessionKey(filterKey);
          if (!record) {
            sendJson(res, 404, {
              ok: false,
              message: `sessionKey 未找到: ${filterKey}`,
              timestamp: new Date().toISOString(),
            });
            return;
          }
          snapshots.push(buildSnapshotRecord(record, { includeRuns: true }));
        } else {
          for (const [, record] of cache) {
            snapshots.push(buildSnapshotRecord(record, { includeRuns: true }));
          }
        }

        sendJson(res, 200, {
          ok: true,
          count: snapshots.length,
          snapshots,
          timestamp: new Date().toISOString(),
        });

        info(MODULE, `[HTTP] 返回 ${snapshots.length} 个快照`, eventId);
      } catch (err: any) {
        error(MODULE, `[HTTP] 快照查询失败: ${err.message}`, eventId);
        sendJson(res, 500, {
          ok: false,
          message: `快照查询失败: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    },
  }, MODULE);
}