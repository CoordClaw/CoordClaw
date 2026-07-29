/**
 * llm-input-dump HTTP 路由
 *
 * v19.25 - LLM 请求导出（完整 system 提示词）
 *
 * 仅暴露 1 个端点：clear（清空全部 dump 文件）
 */

import { ROUTES } from "../shared/routes";
import { sendJson, registerPluginRoute } from "../shared/http-helpers";
import { info, error, getEventId } from "../shared/logger";
import { clearAllDumps } from "./persistence";

const MODULE = "llm-input-dump";

export function registerLlmInputDumpRoute(api: any): void {
  const routeDef = {
    method: "POST",
    path: ROUTES.LLM_INPUT_DUMP_CLEAR,
    auth: "plugin",
    handler: async (_req: any, res: any) => {
      const eventId = getEventId();
      info(MODULE, `[HTTP] 收到 clear 请求`, eventId);

      try {
        const result = await clearAllDumps();
        sendJson(res, 200, {
          ok: true,
          message: result.cleared
            ? `已清空 llm-input-dump 全部内容（${result.count} 个文件）`
            : "目录不存在，无需清空",
          clearedPath: result.path,
          clearedCount: result.count,
          timestamp: new Date().toISOString(),
        });
        info(MODULE, `[HTTP] clear 成功 clearedCount=${result.count}`, eventId);
      } catch (err: any) {
        error(MODULE, `[HTTP] clear 失败: ${err.message}`, eventId);
        sendJson(res, 500, {
          ok: false,
          message: `clear 失败: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    },
  };

  registerPluginRoute(api, routeDef, MODULE);
}
