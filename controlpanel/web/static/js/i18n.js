/**
 * i18n - 轻量多语言支持模块
 * 支持 zh（中文）和 en（英文）
 *
 * 用法：
 *   I18N.t('key')              → 纯文本翻译
 *   I18N.tp('key', arg0, arg1) → 模板翻译，{0} {1} 占位
 *   I18N.setLocale('en')       → 切换语言
 *   I18N.getLocale()           → 获取当前语言 'zh' | 'en'
 *   I18N.applyDOM()            → 刷新所有 data-i18n 元素
 *
 * HTML 标记：
 *   data-i18n="key"             → textContent
 *   data-i18n-title="key"       → title 属性
 *   data-i18n-placeholder="key" → placeholder 属性
 *   data-i18n-aria="key"        → aria-label 属性
 *
 * ★ 词典单一真相源：由 scripts/copy-static.cjs 构建生成的
 *   static/js/i18n-dict.js（window.I18N_DICT = { zh, en }）提供，
 *   该文件由 src/lib/i18n-strings.ts 编译导出，浏览器与服务端共用。
 */

const I18N = (() => {
    'use strict';

    // ==================== 词典（单一真相源，由 i18n-dict.js 提供） ====================
    // 兜底 {} 避免生成文件缺失时整页崩溃；正常情况下 window.I18N_DICT 必然存在。
    const DICT = window.I18N_DICT || { zh: {}, en: {} };
    const zh = DICT.zh || {};
    const en = DICT.en || {};

    // ==================== 核心逻辑 ====================

    let current = zh;

    /** 纯文本翻译 */
    function t(key) {
        return current[key] !== undefined ? current[key] : key;
    }

    /** 模板翻译，{0} {1} 占位 */
    function tp(key, ...args) {
        const template = current[key] !== undefined ? current[key] : key;
        return template.replace(/\{(\d+)\}/g, (_, i) => {
            const idx = parseInt(i, 10);
            return args[idx] !== undefined ? args[idx] : `{${i}}`;
        });
    }

    /**
     * 统一错误展示出口
     * result 为后端 JSON 错误体 { error, params?, message? }：
     *   - error 命中已注册 key → 按 params 模板翻译（与 I18N.tp 同构）
     *   - error 未注册（如后端原始中文/英文）→ 原样返回，避免把内部 key 甩给用户
     *   - error/message 皆空 → 回退 fallback
     */
    function err(result, fallback) {
        if (!result) return fallback || '';
        const raw = result.error || result.message || '';
        if (!raw) return fallback || '';
        const params = Array.isArray(result.params) ? result.params : [];
        if (current[raw] !== undefined) return tp(raw, ...params);
        return raw;
    }

    /** 切换语言并刷新 DOM */
    function setLocale(lang) {
        current = lang === 'en' ? en : zh;
        document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
        applyDOM();
    }

    /** 获取当前语言代码 */
    function getLocale() {
        return current === en ? 'en' : 'zh';
    }

    // ★ 语言注册表 — 新增语言只需加一条
    const LANG_REGISTRY = Object.freeze([
        { id: 'zh', name: '简体中文', label: '简体中文' },
        { id: 'en', name: 'English',  label: 'English' },
    ]);
    function getLangList() { return LANG_REGISTRY; }

    /**
     * 扫描所有 data-i18n 属性并应用当前语言翻译
     * 支持四种标记：
     *   data-i18n="key"             → textContent
     *   data-i18n-title="key"       → title
     *   data-i18n-placeholder="key" → placeholder
     *   data-i18n-aria="key"        → aria-label
     */
    function applyDOM() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) el.textContent = t(key);
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (key) el.setAttribute('title', t(key));
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (key) el.setAttribute('placeholder', t(key));
        });
        document.querySelectorAll('[data-i18n-aria]').forEach(el => {
            const key = el.getAttribute('data-i18n-aria');
            if (key) el.setAttribute('aria-label', t(key));
        });
    }

    // ==================== 初始化 ====================

    // 首屏默认语言：仅用于"服务端 language 未到达前"的猜测（无 coordclaw.json 首装场景）。
    // 唯一真相源是 coordclaw.json.language，最终由 app-main.js 用服务端值覆盖；localStorage 伪权威已移除。
    const def = (window.LangDetect && window.LangDetect.detectDefaultLang()) || 'zh';
    if (def === 'en') {
        current = en;
        document.documentElement.lang = 'en';
    } else {
        current = zh;
        document.documentElement.lang = 'zh-CN';
    }

    // DOM ready 后自动应用翻译
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyDOM);
    } else {
        // 脚本在 body 底部加载时 DOM 已就绪
        applyDOM();
    }

    return { t, tp, err, setLocale, getLocale, applyDOM, getLangList };
})();
