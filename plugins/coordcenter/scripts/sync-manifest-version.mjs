#!/usr/bin/env node
/**
 * 构建期版本同步 —— 以 package.json 为唯一权威源。
 *
 * 职责（且仅此）：把 package.json.version 回写到 openclaw.plugin.json：
 *   1. manifest 的 "version" 字段值直接替换为新版本；
 *   2. manifest 顶层 "description" 开头若存在版本 token（19.50.0 / 19.50 / v19.50），
 *      仅替换该 token，保留其后全部内容（不整段覆盖，避免破坏 manifest 的丰富描述文案）。
 *
 * 关键设计（避免弄脏 git）：
 *  - 采用【原始文本定点替换】，而非 parse + JSON.stringify 重序列化；
 *    因而原文件的缩进、内联对象（如 "additionalProperties": { "type": "string" }）、
 *    末尾换行等格式全部原样保留，只有在版本号真正变化时才改动文件。
 *  - 幂等：若两处都已是最新，则跳过写（字节级不变），每次 build 不产生 churn。
 *  - 原子写：temp + rename，复用项目 shared/json-atomic 的 temp+rename 约定，
 *    防止构建中途崩溃写出半截 JSON 导致 openclaw 加载插件失败。
 *  - 纯 node ESM，无第三方依赖；与运行时 getPluginVersion() 共享同一真相源（package.json）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkgPath = path.join(root, "package.json");
const manifestPath = path.join(root, "openclaw.plugin.json");

function fail(msg) {
  console.error(`[sync-manifest-version] ${msg}`);
  process.exit(1);
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    fail(`无法读取 ${p}: ${e.message}`);
  }
}

const pkgText = readText(pkgPath);
let pkg;
try {
  pkg = JSON.parse(pkgText);
} catch (e) {
  fail(`package.json 解析失败: ${e.message}`);
}
const rawVersion = pkg && pkg.version;
if (typeof rawVersion !== "string" || rawVersion.trim().length === 0) {
  fail("package.json 缺少有效 version");
}
const nextVersion = rawVersion.trim();

const raw = readText(manifestPath);

// 1) 替换 "version" 字段值（manifest 中仅顶层有一个 version 键）
const versionFieldRe = /("version"\s*:\s*")([^"]*)(")/;
// 2) 替换顶层 description 开头的版本 token（configSchema 内的 description 不以版本号开头，不会被误伤）
const descriptionRe = /("description"\s*:\s*")([vV]?\d+(?:\.\d+){0,2})/;

const replaced = raw
  .replace(versionFieldRe, `$1${nextVersion}$3`)
  .replace(descriptionRe, `$1${nextVersion}`);

// 幂等：字节级未变则跳过写
if (replaced === raw) {
  console.log(`[sync-manifest-version] 已是最新 (${nextVersion})，跳过写`);
  process.exit(0);
}

// 原子写：temp + rename（复用项目 json-atomic 约定），保留原末尾换行等格式
const tmp = `${manifestPath}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, replaced, "utf8");
  fs.renameSync(tmp, manifestPath);
} catch (e) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* 忽略清理失败 */
  }
  fail(`写入 ${manifestPath} 失败: ${e.message}`);
}

console.log(`[sync-manifest-version] 已同步 version=${nextVersion} 到 openclaw.plugin.json`);
