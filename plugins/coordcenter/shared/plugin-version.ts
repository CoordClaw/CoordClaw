/**
 * 插件版本 — 单一权威源。
 *
 * 版本号唯一来源于 package.json（package.json 为权威），
 * 代码运行时从 package.json 读取，避免 index.ts / environment.ts /
 * openclaw.plugin.json 等多处硬编码导致版本描述与 package 不一致。
 *
 * 路径解析同时兼容：
 *  - 源码运行：本文件位于 src/shared/，package.json 在插件根（../package.json）
 *  - 打包运行：本文件被 esbuild 内联进 dist/index.js，import.meta.url 指向
 *    dist/index.js，../package.json 仍指向插件根 package.json
 * 读取失败时回退 "0.0.0"，不影响启动。
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let cachedPluginVersion: string | null = null;

export function getPluginVersion(): string {
  if (cachedPluginVersion !== null) return cachedPluginVersion;
  cachedPluginVersion = "0.0.0"; // 失败兜底，避免每次调用重复读文件
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "..", "package.json"), // src/shared → 根；dist → 根
      path.join(here, "package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
        if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
          cachedPluginVersion = pkg.version.trim();
          break;
        }
      }
    }
  } catch {
    // 保留兜底值，但显式告警，避免 package.json 被移动/损坏导致静默 0.0.0 掩盖真实故障
    console.warn(
      `[plugin-version] 从 package.json 读取版本失败，回退 "0.0.0"；请检查 package.json 是否存在且含有效 version 字段。`
    );
  }
  return cachedPluginVersion;
}
