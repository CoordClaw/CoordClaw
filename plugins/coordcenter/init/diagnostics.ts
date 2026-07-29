/**
 * 运行时路径诊断 — 仅在初始化时输出一次
 */

import { debug, getEventId } from "../shared/logger";

export function dumpRuntimePathDiagnostics(api: any): void {
  const evtId = getEventId();
  const tag = "plugin";

  debug(tag, "========== RUNTIME PATH DIAGNOSTICS ==========", evtId);

  // ---- api 直接提供的路径 ----
  debug(tag, `[api.source]        = ${JSON.stringify(api.source)}`, evtId);
  debug(tag, `[api.rootDir]       = ${JSON.stringify(api.rootDir)}`, evtId);
  debug(tag, `[api.resolvePath]   = ${typeof api.resolvePath}`, evtId);
  debug(tag, `[api.id]            = ${JSON.stringify(api.id)}`, evtId);
  debug(tag, `[api.name]          = ${JSON.stringify(api.name)}`, evtId);

  // ---- api.config 中的 paths 相关字段 ----
  try {
    if (api.config) {
      const configPathsParts: string[] = [];
      if (api.config.plugins) {
        const pl = api.config.plugins;
        configPathsParts.push(`plugins.load.paths=${JSON.stringify(pl.load?.paths)}`);
        configPathsParts.push(`plugins.entries.keys=${JSON.stringify(Object.keys(pl.entries || {}))}`);
        configPathsParts.push(`plugins.allow=${JSON.stringify(pl.allow)}`);
        configPathsParts.push(`plugins.deny=${JSON.stringify(pl.deny)}`);
      }
      if (api.config.skills) {
        const sk = api.config.skills;
        configPathsParts.push(`skills.load.extraDirs=${JSON.stringify(sk.load?.extraDirs)}`);
      }
      debug(tag, `[api.config.plugins/skills] ${configPathsParts.join(" | ")}`, evtId);
    }
  } catch (err: any) {
    debug(tag, `[api.config] ERROR: ${err.message}`, evtId);
  }

  // ---- api.pluginConfig ----
  debug(tag, `[api.pluginConfig] = ${JSON.stringify(api.pluginConfig)}`, evtId);

  // ---- api.runtime ----
  try {
    const rt = api.runtime || {};
    debug(tag, `[api.runtime.version]    = ${rt.version}`, evtId);
    debug(tag, `[api.runtime.state]      = ${typeof rt.state}`, evtId);
    if (rt.state?.resolveStateDir) {
      try {
        debug(tag, `[api.runtime.state.resolveStateDir()] = ${rt.state.resolveStateDir()}`, evtId);
      } catch (e: any) { debug(tag, `[api.runtime.state.resolveStateDir()] ERROR: ${e.message}`, evtId); }
    }
  } catch (err: any) {
    debug(tag, `[api.runtime] ERROR: ${err.message}`, evtId);
  }

  // ---- process 相关 ----
  debug(tag, `[process.pid]      = ${process.pid}`, evtId);
  debug(tag, `[process.ppid]     = ${process.ppid}`, evtId);
  debug(tag, `[process.cwd()]    = ${process.cwd()}`, evtId);
  debug(tag, `[process.execPath] = ${process.execPath}`, evtId);
  debug(tag, `[process.argv0]    = ${process.argv0}`, evtId);
  if (process.argv.length > 0) {
    debug(tag, `[process.argv] (${process.argv.length}):`, evtId);
    process.argv.forEach((a, i) => {
      debug(tag, `  argv[${i}] = ${a}`, evtId);
    });
  }

  // ---- 环境变量 (OPENCLAW_ / QCLAW_ / PATH 相关) ----
  const envPathKeys: string[] = [];
  for (const key of Object.keys(process.env).sort()) {
    const upper = key.toUpperCase();
    if (upper.startsWith("OPENCLAW_") || upper.startsWith("QCLAW_") ||
        upper === "PATH" || upper === "APPDATA" || upper === "LOCALAPPDATA" ||
        upper === "PROGRAMFILES" || upper === "PROGRAMFILES(X86)" ||
        upper === "HOMEDRIVE" || upper === "HOMEPATH" || upper === "USERPROFILE" ||
        upper === "TEMP" || upper === "TMP" ||
        upper.includes("NODE") || upper.includes("ELECTRON")) {
      const val = process.env[key] || "";
      envPathKeys.push(`${key}=${val.length > 300 ? val.substring(0, 300) + "..." : val}`);
    }
  }
  debug(tag, `[process.env PATH-related] (${envPathKeys.length}):`, evtId);
  for (const entry of envPathKeys) {
    debug(tag, `  ${entry}`, evtId);
  }

  // ---- require.resolve 探针 ----
  try {
    const m = require("module");
    const cjsRequire = m.createRequire(api.source || import.meta.url);
    debug(tag, `[require.resolve("openclaw")] = ${cjsRequire.resolve("openclaw")}`, evtId);
    try {
      debug(tag, `[require.resolve("openclaw/package.json")] = ${cjsRequire.resolve("openclaw/package.json")}`, evtId);
    } catch (e: any) { debug(tag, `[require.resolve("openclaw/package.json")] ERROR: ${e.message}`, evtId); }
  } catch (err: any) {
    debug(tag, `[require.resolve] ERROR: ${err.message}`, evtId);
  }

  // ---- import.meta ----
  debug(tag, `[__filename]     = ${typeof __filename !== "undefined" ? __filename : "N/A"}`, evtId);
  debug(tag, `[__dirname]      = ${typeof __dirname !== "undefined" ? __dirname : "N/A"}`, evtId);

  debug(tag, "========== END RUNTIME PATH DIAGNOSTICS ==========", evtId);
}
