/**
 * 团队模块 — 团队操作/删除
 * 依赖：AppApi, I18N, window.App
 * 桥接：window._refreshDashboard(), window._reloadAll(), window.refreshDynamicUI
 */
const TeamsModule = (function() {
    'use strict';

    const $A = window.App;

    async function handleDeleteTeam(teamId, teamName) {
        let activeProjects = [];
        try {
            const resp = await AppApi.getProjects();
            const data = await resp.json();
            for (const team of (data.teams || [])) {
                if (team.id === teamId) {
                    for (const proj of (team.projects || [])) {
                        if (proj.status === 'active') activeProjects.push(proj.name);
                    }
                    break;
                }
            }
        } catch (e) { /* ignore */ }

        const confirmed = confirm(activeProjects.length > 0
            ? I18N.tp('confirm_delete_team', teamName, activeProjects.length, activeProjects.join('、'))
            : I18N.tp('confirm_delete_team_simple', teamName));
        if (!confirmed) return;

        try {
            const resp = await AppApi.postDeleteTeam({ teamId });
            const result = await resp.json();
            if (resp.ok && result.success !== false) {
                if (window._refreshDashboard) await window._refreshDashboard();
                if (window._reloadAll) await window._reloadAll();
            } else {
                alert(I18N.t('alert_delete_fail') + '：' + I18N.err(result, I18N.t('modal_unknown_error')));
            }
        } catch (e) {
            alert(I18N.t('alert_delete_fail') + '：' + e.message);
        }
    }

    function handleInlineTeamAction(action, teamId, teamName, templatePath) {
        switch (action) {
            case 'team-open-dir':
                AppApi.postOpenTeamDir(teamId).catch(e => alert(I18N.t('alert_open_dir_fail') + ': ' + e.message));
                break;
            case 'team-edit-members':
                AppApi.postOpenTeamsoul(teamId)
                    .then(async r => { if (!r.ok) { const d = await r.json(); alert(d.error || I18N.t('alert_open_fail')); } })
                    .catch(e => alert(I18N.t('alert_open_fail') + ': ' + e.message));
                break;
            case 'team-edit-rules':
                AppApi.postOpenTeamRule(teamId)
                    .then(async r => { if (!r.ok) { const d = await r.json(); alert(d.error || I18N.t('alert_open_fail')); } })
                    .catch(e => alert(I18N.t('alert_open_fail') + ': ' + e.message));
                break;
            case 'team-delete':
                handleDeleteTeam(teamId, teamName);
                break;
            case 'export-team':
                AppApi.postExportTeamTpkg(teamId)
                    .catch(e => alert(I18N.t('alert_export_team_fail') + ': ' + e.message));
                break;
            case 'team-rename':
                // 进入内联编辑态（状态在 Alpine appState 中）
                if (window.__alpineApp) window.__alpineApp.startTeamRename(teamId, teamName);
                break;
        }
    }

    return { handleDeleteTeam, handleInlineTeamAction };
})();
