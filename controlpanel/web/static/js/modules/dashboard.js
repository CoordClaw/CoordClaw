/**
 * 仪表盘模块 — 数据加载 / 配置刷新 / UI 更新
 * 依赖：AppApi, I18N, UIRenderer, window.App, window.__alpineApp
 */
const DashboardModule = (function() {
    'use strict';

    const $A = window.App;

    function syncToAlpine() {
        const app = window.__alpineApp;
        if (!app) return;
        app.config = $A.config;
        app.teams = $A.teams;
    }

    async function loadData() {
        try {
            const [configResp, projectsResp] = await Promise.all([
                AppApi.getConfig(),
                AppApi.getProjects()
            ]);
            if (configResp.ok) $A.config = await configResp.json();
            if (projectsResp.ok) {
                const projectsData = await projectsResp.json();
                $A.teams = projectsData.teams || [];
            }
            syncToAlpine();
        } catch (e) {
            console.error('[Dashboard] 加载数据失败:', e.message);
            if (e.message && e.message.includes('Unexpected token')) {
                window.location.replace('/install.html');
            }
        }
        return $A;
    }

    function renderProjectInfo(config) {
        const app = window.__alpineApp;
        if (!app || !config) return;
        const members = config.members || [];
        const mr = config.msgRobot;
        app.teamName = config.teamName || '';
        app.projectName = config.projectName || '';
        app.version = config.version || '';
        app.memberCount = members.length;
        app.tokenUsage = config.estTotalTokens || 0;
        app.projectRoot = config.projectRoot || '';
        app.humanMembers = Array.isArray(config.humanMember) ? config.humanMember : (config.humanMember ? [config.humanMember] : []);
        app.autoCoordination = !!config.autoCoordination;
        app.msgRobot = typeof mr === 'object' && mr ? !!mr.enabled : !!mr;
    }

    function renderTeamList(teams) {
        const app = window.__alpineApp;
        if (!app) return;
        app.teamList = (teams || []).map(t => ({
            id: t.id, name: t.name,
            template: t.templatePath || '',
            projCount: (t.projects || []).length,
        }));
    }

    function renderProjectCardList(teams) {
        const app = window.__alpineApp;
        if (!app) return;
        app.projectCardList = (teams || []).map(t => ({
            id: t.id, name: t.name,
            projects: (t.projects || []).map(p => ({
                id: p.id, name: p.name, root: p.root,
                isActive: p.status === 'active',
            })),
        }));
    }

    function renderCards() {
        const state = $A;
        renderProjectInfo(state.config);
        renderTeamList(state.teams);
        renderProjectCardList(state.teams);
        setTimeout(function() { I18N.applyDOM(); }, 100);
    }

    async function loadConfig() {
        try {
            const resp = await AppApi.getConfig();
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const config = await resp.json();
            $A.config = config;
            if (config.currentUser) $A.config.currentUser = config.currentUser;
            syncToAlpine();
            return config;
        } catch (e) {
            console.error('[App] 加载配置失败:', e.message);
            window.location.replace('/install.html');
            return null;
        }
    }

    function updateLocaleIcon(locale) {
        const btn = document.getElementById('toggle-locale');
        if (!btn) return;
        const cnFlag = '<svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:middle"><circle cx="12" cy="12" r="12" fill="#DE2910"/><polygon points="8,7 8.9,9.8 12,9.8 9.6,11.6 10.5,14.3 8,12.5 5.5,14.3 6.4,11.6 4,9.8 7.1,9.8" fill="#FFDE00"/><polygon points="13.3,5.5 13.7,6.6 14.9,6.6 14,7.3 14.4,8.5 13.3,7.8 12.3,8.5 12.5,7.3 11.8,6.6 12.9,6.6" fill="#FFDE00"/><polygon points="15.2,7.3 15.5,8.1 16.4,8.1 15.7,8.6 16,9.5 15.2,9 14.5,9.5 14.7,8.6 14,8.1 14.9,8.1" fill="#FFDE00"/><polygon points="15,10 15.3,10.8 16.2,10.8 15.5,11.3 15.8,12 15,11.7 14.3,12 14.5,11.3 13.8,10.8 14.7,10.8" fill="#FFDE00"/><polygon points="13.3,12 13.7,12.8 14.9,12.8 14,13.5 14.4,14.5 13.3,14 12.3,14.5 12.5,13.5 11.8,12.8 12.9,12.8" fill="#FFDE00"/></svg>';
        btn.innerHTML = locale === 'zh' ? cnFlag : '🌐';
    }

    function renderUpdateLink() {
        const link = document.getElementById('update-link');
        if (!link) return;
        const ui = $A.updateInfo;
        if (!ui || !ui.latest_version || !ui.download_url) {
            link.classList.add('hidden');
            return;
        }
        const cv = ($A.config?.version || '').split('.').map(Number);
        const lv = ui.latest_version.split('.').map(Number);
        let newer = false;
        for (let i = 0, len = Math.max(cv.length, lv.length); i < len; i++) {
            if ((lv[i] || 0) > (cv[i] || 0)) { newer = true; break; }
            if ((lv[i] || 0) < (cv[i] || 0)) break;
        }
        if (!newer) { link.classList.add('hidden'); return; }
        link.textContent = I18N.tp('msg_update_available', ui.latest_version);
        link.href = ui.download_url;
        link.classList.remove('hidden');
    }

    /** refreshDynamicUI — 需要 _currentSSEMode 参数 */
    function refreshUI(currentSSEMode) {
        renderCards();
        UIRenderer.updateMsgCount();
        UIRenderer.updateFirstMessage($A.firstMessageAt);
        renderUpdateLink();
        UIRenderer.updateConnectionStatus(currentSSEMode);
        const filterState = UIRenderer.getMemberFilterState();
        if (filterState.member) {
            const statusEl = document.getElementById('load-status');
            if (statusEl) {
                if (filterState.member && filterState.showUnreadOnly) {
                    statusEl.textContent = I18N.tp('filter_unread_only', filterState.member);
                    statusEl.style.color = 'var(--accent-blue)';
                } else if (filterState.member) {
                    statusEl.textContent = I18N.tp('filter_all_of', filterState.member);
                    statusEl.style.color = 'var(--text-secondary)';
                } else {
                    statusEl.textContent = '';
                }
            }
        }
        document.querySelectorAll('[data-action="toggle-skill"]').forEach(btn => {
            btn.textContent = btn.classList.contains('active') ? I18N.t('skill_on') : I18N.t('skill_off');
        });
    }

    async function fetchUpdate() {
        for (let i = 0; i < 10; i++) {
            try {
                const resp = await AppApi.getUpdateInfo();
                const info = await resp.json();
                if (info.latest_version && info.download_url) {
                    $A.updateInfo = info;
                    return;
                }
            } catch { /* ignore */ }
            if (i < 9) await new Promise(r => setTimeout(r, 2000));
        }
    }

    async function loadTeams() {
        try {
            const resp = await AppApi.getProjects();
            if (!resp.ok) return;
            const data = await resp.json();
            $A.teams = data.teams || [];
            syncToAlpine();
            renderCards();
        } catch (e) {
            console.error('[App] 加载团队列表失败:', e.message);
        }
    }

    // ★ 桥接：供外部模块调用
    async function refreshDashboard() {
        await loadData();
        renderCards();
    }

    return {
        loadData, loadConfig, loadTeams, refreshUI, fetchUpdate,
        renderCards, syncToAlpine, renderProjectInfo, updateLocaleIcon,
        refreshDashboard,
        // 供 window._reloadAll 等桥接
        get _syncAlpine() { return syncToAlpine; },
    };
})();

// ★ 全局桥接（供 app-main 和外部模块使用）
window.refreshDynamicUI = function(mode) { DashboardModule.refreshUI(mode || 'sse'); };
window._refreshDashboard = function() { return DashboardModule.refreshDashboard(); };
