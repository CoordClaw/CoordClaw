/**
 * 运行时静态根目录 — 全站唯一真相
 *
 * 修复前：server.ts / response.ts / tracker.ts 三处对"静态根"的解析基点不统一：
 *   - server.ts(位于 dist/ 根) 用 join(__dirname, '..', 'static') → 错算到源码根 web/static
 *   - response.ts(位于 dist/lib/) 用 join(__dirname, '..', 'static') → dist/static ✅
 *   - tracker.ts(位于 dist/ 根) 用 join(__dirname, 'static', 'auto') → dist/static ✅
 * 同一 /auto/ 路由内守卫查 source、读取查 dist，永远错位，导致 plugins.json 守卫永远返 failed。
 *
 * 修复后：静态根由本模块集中求解，其余三处一律引用 joinStatic，不再各自硬编码相对路径。
 * 与 response.ts 原算式逐字相同（join(__dirname, '..', 'static')），零新数学、零循环依赖。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url)); // 运行时 = dist/lib

/** 静态根目录：dist/static（prod 构建）或 src/static（dev 模式） */
export const STATIC_ROOT = join(__dirname, '..', 'static');

/** 拼接静态根下的相对路径（参数同 path.join） */
export function joinStatic(...parts: string[]): string {
  return join(STATIC_ROOT, ...parts);
}
