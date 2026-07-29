/**
 * 统一 UTC 时间工具（插件层）。
 *
 * 契约前提（控制面板统一改为 UTC 写入，插件只消费 / 比较 UTC）：
 *  - SQLite 外部表 team_messages.created_at / team_message_reads.read_at：UTC 文本
 *    （"YYYY-MM-DD HH:MM:SS" 或 ISO-8601 带 Z，二者都按 UTC 处理）
 *  - 运行态缓存 startedAt / endedAt / updatedAt / firstUnreadAt：本插件用
 *    new Date().toISOString() 生成，已是 UTC ISO-8601"Z"
 *
 * 本文件只做"解析为 UTC 绝对时刻"与"格式化"，绝不在任何比较路径上做本地时区换算。
 * 本地时区展示由展示层（formatUtcToLocalHHMM）负责。
 */

const UTC_TEXT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

/** 将任意 UTC 时间戳字符串规范为统一的带毫秒 ISO-Z（UTC），供比较/排序使用。
 *  - "2026-07-25 10:00:00"          → "2026-07-25T10:00:00.000Z"（补 Z）
 *  - "2026-07-25T10:00:00Z"         → "2026-07-25T10:00:00.000Z"（统一精度）
 *  - "2026-07-25T18:00:00+08:00"    → "2026-07-25T10:00:00.000Z"（转绝对时刻再 Z）
 *  - "2026-07-25T10:00:00.500Z"     → "2026-07-25T10:00:00.500Z"（保留毫秒）
 * 所有分支统一走 Date.parse→toISOString，保证精度一致、同时刻表示唯一，
 * 下游 localeCompare 字符串排序严格等价于时间序，与具体文本格式无关。 */
export function normalizeUtcStamp(s: string): string {
  let t = (s || "").trim();
  if (!t) return t;
  // 无 Z 无偏移的空格/ISO 文本需补 Z，否则 Date.parse 会按运行机本地时区解读（不是 UTC）
  if (!/[Zz]$/.test(t) && !/[+-]\d{2}:?\d{2}$/.test(t) && UTC_TEXT_RE.test(t)) {
    t = t.replace(" ", "T") + "Z";
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return t;
  // 统一输出带毫秒的 ISO-Z：精度一致、同时刻表示唯一、字典序==时间序
  return new Date(ms).toISOString();
}

/** 解析外部 UTC 时间戳为 epoch 毫秒；无法解析返回 NaN。 */
export function parseStoredUtc(s: string | null | undefined): number {
  if (s == null) return NaN;
  const ms = Date.parse(normalizeUtcStamp(s));
  return Number.isNaN(ms) ? NaN : ms;
}

/** 将 Date / epoch / ISO 格式化为 SQLite 兼容的 UTC "YYYY-MM-DD HH:MM:SS"。 */
export function formatUtcStamp(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 仅用于展示：将 UTC 时间戳格式化为本地时区 HH:MM（不用于任何比较）。 */
export function formatUtcToLocalHHMM(s: string | null | undefined): string {
  const ms = parseStoredUtc(s);
  if (Number.isNaN(ms)) return "--:--";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 将 epoch 毫秒转为 Unix 秒（供 SQL unixepoch() 比较使用）。 */
export function toUnixSeconds(input: string | number | Date): number {
  const ms =
    input instanceof Date
      ? input.getTime()
      : typeof input === "number"
        ? input
        : parseStoredUtc(input);
  return Math.floor(ms / 1000);
}
