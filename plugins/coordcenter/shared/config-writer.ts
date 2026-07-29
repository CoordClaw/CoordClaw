import fs from "fs";
import path from "path";
import { info, error, getEventId } from "./logger";
import { getOpenClawRoot, getOpenClawUserDir, getCoordClawDataDir, getCoordClawRoot, getTeamJsonPath, resolveGatewayUrl, resolveGatewayToken, getOpenClawFrameworkVersion } from "./paths";
import { ROUTE_REGISTRY } from "./routes";
import { resolveProjectRoot } from "../prompt-injection";
import { getConfig } from "../message-routing/internal-state";
import { writeFileWithRetry } from "./json-atomic";

const CONFIG_FILE = "config.json";

function loadOpenClawJson(): any {
  const userDir = getOpenClawUserDir();
  if (!userDir) return null;
  const configPath = path.join(userDir, "openclaw.json");
  if (!fs.existsSync(configPath)) return null;
  try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { return null; }
}

function resolveWebchatUrl(): string {
  // 优先读取实际监听端口（auto-port fallback 可能与 openclaw.json 不同）
  const config = loadOpenClawJson();
  let webchatPort: number;
  try {
    // ESM: 用 globalThis 共享实际端口，避免动态 import 循环依赖
    webchatPort = (globalThis as any).__coordClawWebchatPort || 0;
  } catch {
    webchatPort = 0;
  }
  if (!webchatPort) {
    webchatPort = config?.channels?.webchat?.port || 3210;
  }

  let host = "127.0.0.1";
  const gw = config?.gateway || {};
  if (gw.bind === "lan" || gw.mode === "lan") {
    host = gw.hostname || "0.0.0.0";
  }

  return `http://${host}:${webchatPort}`;
}

async function updateTeamJsonWithAccurateValues(
  projectRoot: string,
  accurateGatewayUrl: string,
  accurateWebchatUrl: string,
  accurateUserDir: string
): Promise<void> {
  try {
    const cfg = getConfig();
    const teamJsonPath = getTeamJsonPath(projectRoot);

    if (!fs.existsSync(teamJsonPath)) {
      info("plugin", `[CONFIG] team.json 不存在，跳过更新`, getEventId());
      return;
    }

    const rawContent = fs.readFileSync(teamJsonPath, "utf-8");
    const teamData = JSON.parse(rawContent);

    let updated = false;

    if (teamData.gatewayUrl !== accurateGatewayUrl) {
      teamData.gatewayUrl = accurateGatewayUrl;
      updated = true;
      info("plugin", `[CONFIG] team.json 更新 gatewayUrl: ${accurateGatewayUrl}`, getEventId());
    }

    if (teamData.openclawUserDir !== accurateUserDir) {
      teamData.openclawUserDir = accurateUserDir;
      updated = true;
      info("plugin", `[CONFIG] team.json 更新 openclawUserDir: ${accurateUserDir}`, getEventId());
    }

    if (teamData.webchatUrl !== accurateWebchatUrl) {
      teamData.webchatUrl = accurateWebchatUrl;
      updated = true;
      info("plugin", `[CONFIG] team.json 更新 webchatUrl: ${accurateWebchatUrl}`, getEventId());
    }

    if (updated) {
      writeFileWithRetry(teamJsonPath, JSON.stringify(teamData, null, 2));
      info("plugin", `[CONFIG] team.json 已更新: ${teamJsonPath}`, getEventId());
    } else {
      info("plugin", `[CONFIG] team.json 无需更新(值已准确)`, getEventId());
    }
  } catch (err: any) {
    error("plugin", `[CONFIG] team.json 更新失败: ${err.message}`, getEventId());
  }
}

export async function writeConfigJson(api?: any): Promise<void> {
  const eventId = getEventId();

  try {
    const dataDir = getCoordClawDataDir();
    fs.mkdirSync(dataDir, { recursive: true });

    const accurateGatewayUrl = resolveGatewayUrl();
    const accurateGatewayToken = resolveGatewayToken();
    const accurateWebchatUrl = resolveWebchatUrl();
    const root = getOpenClawRoot();
    const accurateUserDir = getOpenClawUserDir().replace(/\\/g, "/");  // 归一化分隔符
    const coordClawRoot = getCoordClawRoot();
    const openclawVersion = getOpenClawFrameworkVersion() || api?.runtime?.version || "";

    info("plugin", `[CONFIG] 从OpenClaw获取准确配置: gatewayUrl=${accurateGatewayUrl}, webchatUrl=${accurateWebchatUrl}, openclawUserDir=${accurateUserDir}`, eventId);

    const coordclawJsonPath = path.join(accurateUserDir, "coordclaw.json");

    // 归一化路径分隔符为正斜杠（JSON 中双斜杠 \\ 难以阅读且跨平台不兼容）
    const toConfigPath = (p: string | null) => (p || "").replace(/\\/g, "/");

    // endpointslist: 调试用，非生产字段，只在明确开启时才输出
    const endpointsEnabled = (() => {
      try {
        if (fs.existsSync(coordclawJsonPath)) {
          const coordData = JSON.parse(fs.readFileSync(coordclawJsonPath, "utf-8"));
          return coordData?.endpointslist === true;
        }
      } catch {}
      return false;
    })();

    const config: Record<string, any> = {
      version: "1.0",
      gatewayUrl: accurateGatewayUrl,
      gatewayToken: accurateGatewayToken,
      gatewayPid: process.pid,
      webchatUrl: accurateWebchatUrl,
      openclawRoot: toConfigPath(root),
      coordClawRoot: toConfigPath(coordClawRoot),
      openclawVersion: openclawVersion,
      openclawUserDir: toConfigPath(accurateUserDir),
      coordclawJsonPath: toConfigPath(coordclawJsonPath),
      timestamp: new Date().toISOString(),
    };

    if (endpointsEnabled) {
      config.endpoints = ROUTE_REGISTRY.map((r) => ({
        path: r.path,
        method: r.method,
        auth: r.auth,
        desc: r.desc,
        ...(r.params ? { params: r.params } : {}),
        ...(r.response ? { response: r.response } : {}),
      }));
    }

    const configPath = path.join(dataDir, CONFIG_FILE);
    writeFileWithRetry(configPath, JSON.stringify(config, null, 2));

    if (coordClawRoot) {
      process.env.COORDCLAW_ROOT = coordClawRoot;
      if (process.platform === "win32") {
        try {
          const { execSync } = await import("child_process");
          execSync(`setx COORDCLAW_ROOT "${coordClawRoot}"`, { timeout: 5000, windowsHide: true });
          info("plugin", `[CONFIG] COORDCLAW_ROOT 已持久化到注册表: ${coordClawRoot}`, eventId);
        } catch (envErr: any) {
          info("plugin", `[CONFIG] COORDCLAW_ROOT 仅进程内生效(setx失败): ${envErr.message}`, eventId);
        }
      } else {
        info("plugin", `[CONFIG] COORDCLAW_ROOT 已设置(进程内): ${coordClawRoot}`, eventId);
      }
    }

    info("plugin", `[CONFIG] config.json 已生成: ${configPath}`, eventId);

    const cfg = getConfig();
    const projectRoot = await resolveProjectRoot(cfg.jsonPath, cfg.cacheTtl);
    await updateTeamJsonWithAccurateValues(projectRoot, accurateGatewayUrl, accurateWebchatUrl, accurateUserDir);

  } catch (err: any) {
    error("plugin", `[CONFIG] 配置生成失败: ${err.message}`, eventId);
  }
}
