/**
 * 大模型选择模块 — 集中缓存 + 注册制
 *   fetchModels() 拉取一次存 _models，通知所有注册下拉原地刷新，保留选中值
 */
const ModelModule = (function() {
    'use strict';

    let _models = [];                       // [ { name, provider, id, scope } ]
    const _entries = new Map();             // Map<HTMLElement, { opts, lastValue }>
    let _fetching = null;                   // 防并发

    // ═══════════════ 内部 ═══════════════

    /** 拉取模型列表（防并发），更新缓存后通知所有下拉 */
    const MAX_RETRIES = 6; // 最多重试 6 次（共 30s）

    async function fetchModels() {
        if (_fetching) return _fetching;
        return (_fetching = _doFetch(1));
    }

    async function _doFetch(attempt) {
        let models = null;
        try {
            const resp = await AppApi.getModels();
            const data = await resp.json();
            models = data.models;
        } catch (e) {
            console.warn('[Models] 请求失败:', e.message || e);
        }

        if (models && models.length > 0) {
            _models = models;
            _fetching = null;
            notifyAll();
            return;
        }

        // ★ 数据为空或请求失败 → 保留旧数据，5s 后重试
        console.warn('[Models] 返回数据为空或请求失败');
        if (attempt < MAX_RETRIES) {
            console.log(`[Models] 5s 后重试 (第 ${attempt} 次)`);
            await new Promise(r => setTimeout(r, 5000));
            return _doFetch(attempt + 1);
        }

        // 达到最大重试次数
        console.warn('[Models] 已达最大重试次数，停止重试');
        _fetching = null;
        if (_models.length > 0) notifyAll(); // 保留旧数据
    }

    /** 为单个下拉渲染选项，保留当前选中值 */
    function render(el, entry) {
        const prev = entry.lastValue ?? el.value;
        const showFollow = entry.opts?.showFollow;
        el.innerHTML = '';

        if (showFollow) {
            const ph = document.createElement('option');
            ph.value = ''; ph.disabled = true;
            ph.textContent = entry.opts.placeholder || I18N.t('model_placeholder');
            el.appendChild(ph);

            const follow = document.createElement('option');
            follow.value = '__follow__';
            follow.textContent = I18N.t('model_follow');
            el.appendChild(follow);
        }

        for (const m of _models) {
            const label = m.name || `${m.provider}/${m.id || m.model}`;
            // ★ 修复：option 的 value 必须是系统标识符 provider/id，不能误用显示名(label=name)
            //   —— 当 name 与 id 不同（如 lobsterai-server 源）时，用 name 当 value 会导致后端写盘丢失 provider
            const value = (m.provider && m.id) ? `${m.provider}/${m.id}` : (m.id || m.name || label);
            // ★ 展示优化: 显示 name(provider) 便于区分同名模型; 缺 provider 时回退到 name/value, 避免 "xxx(undefined)"
            const display = m.name ? (m.provider ? `${m.name} (${m.provider})` : m.name) : value;
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = display;
            if (m.scope === 'global') opt.dataset.global = '1';
            el.appendChild(opt);
        }

        // ★ 恢复选中：per-session 用上次值，全局用 scope===global
        if (!showFollow) {
            const globalOpt = el.querySelector('option[data-global="1"]');
            if (globalOpt) globalOpt.selected = true;
        } else if (Array.from(el.options).some(o => o.value === prev)) {
            el.value = prev;
        }
        entry.lastValue = el.value;

        // change 绑定（仅首次）
        if (!el._modelHandler) {
            el._modelHandler = async function() {
                const val = el.value;
                if (!val) return;
                entry.lastValue = val;
                try {
                    el.disabled = true;
                    const sk = entry.opts?.sessionKey;
                    const agentId = entry.opts?.agentId;
                    if (val === '__follow__')        await AppApi.postModelConfig(null, sk);
                    else if (sk)                     await AppApi.postModelConfig(val, sk, agentId);
                    else {
                        await AppApi.postModelConfig(val);   // ① 保留全局（不传 sessionKey）
                        await applyToAllAgents(val);         // ② 广播所有 agent 成员，各单独设置一次
                    }
                } catch {} finally { el.disabled = false; }
            };
            el.addEventListener('change', el._modelHandler);
        }
    }

    /** 通知所有已注册下拉刷新 */
    function notifyAll() {
        for (const [el, entry] of _entries) {
            if (el.isConnected) render(el, entry);
        }
    }

    /**
     * ★ 公共原语：把同一模型广播到所有 agent 成员（global broadcast to all agents）
     *   遍历 App.config.members（仅 agent，含 sessionKey，不含 human），各 postModelConfig 一次。
     *   复用现有 postModelConfig 与 members 数据源，零新网络抽象。
     *   单成员失败 .catch 隔离，不阻断其余；跳过空 sessionKey 避免误设全局。
     */
    async function applyToAllAgents(model) {
        const members = (window.App && window.App.config && window.App.config.members) || [];
        const tasks = members
            .filter(m => m.sessionKey)
            .map(m => AppApi.postModelConfig(model, m.sessionKey).catch(e => e));
        await Promise.all(tasks);
    }

    // ═══════════════ 公开 ═══════════════

    /** 注册一个下拉元素 */
    function register(el, opts) {
        if (!el) return;
        const entry = { opts: opts || {}, lastValue: '' };
        _entries.set(el, entry);
        if (_fetching) { _fetching.then(() => render(el, entry)); }
        else if (_models.length) { render(el, entry); }
        else { fetchModels().then(() => render(el, entry)); }
    }

    /** 注销（覆盖层关闭时调用，避免内存泄漏） */
    function unregister(el) {
        if (!el) return;
        el._modelHandler = null;
        _entries.delete(el);
    }

    /** 初始化：注册主消息框下拉 */
    function init() {
        register(document.getElementById('input-model'));
        fetchModels();
    }

    /** ★ 外部触发刷新（SSE models_changed / 项目切换） */
    function refreshAll() {
        fetchModels();
    }

    // ★ 保留旧接口兼容
    const loadModelDropdown = register;

    return { init, register, unregister, refreshAll, loadModelDropdown };
})();
