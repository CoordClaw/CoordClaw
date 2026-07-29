/**
 * lang.ts — 语言决策逻辑唯一真相源（Single Source of Truth）
 * ====================================================
 * 同时被 Node 端（server.ts / index.ts，经 tsc 编译 import）与浏览器端
 * （install.js / i18n.js，经 scripts/copy-static.cjs 把 resolveDefaultLanguage
 * 源码注入 window.LangDetect）共用，确保两端判定规则字面一致、零漂移。
 *
 * 设计为叶子模块：无 import、无 process 引用、所有正则内联于函数体
 * （否则 .toString() 注入浏览器时会因缺依赖而 ReferenceError）。
 */

export type Lang = 'zh' | 'en';

/** 语言归一：白名单 zh|en，其它（含非法值/缺失）一律 zh。须与 i18n.js 的 LANG_REGISTRY 保持一致。 */
export function normalizeLanguage(raw?: string): Lang {
  return raw === 'en' ? 'en' : 'zh';
}

/**
 * 按本机时区 + 语言线索推断默认界面语言。
 * 注意：本函数仅用于"无 coordclaw.json 首装"时的本地 best-effort 猜测，
 * 权威语言仍是 coordclaw.json（由浏览器安装页写入）。Node 端仅在本地桌面
 * 部署时等于用户时区；远端/Docker 部署时 Node 时区 ≠ 用户时区，此时以
 * 浏览器安装页判定为准。
 */
export function resolveDefaultLanguage(input?: { timeZone?: string; localeHint?: string }): Lang {
  const timeZone = (input && input.timeZone) || '';
  const localeHint = (input && input.localeHint) || '';
  try {
    // 语言：中文系（含简/繁）一律 zh
    if (/^(zh|cmn|cn|zh-Hans|zh-Hant)/i.test(localeHint)) return 'zh';
    // 时区：中国时区（大陆 + 香港 + 澳门，均为中国）
    if (/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Hong_Kong|Macau|Macao)/i.test(timeZone)) return 'zh';
    return 'en';
  } catch {
    return 'zh'; // 探测失败兜底 zh
  }
}
