/**
 * 项目模块 — 切换/创建/删除/操作
 * 依赖：AppApi, I18N, UIRenderer, window.App, window.showModal, window.closeModal
 * 桥接：window._reloadAll(), window._refreshDashboard()
 */
const ProjectsModule = (function() {
    'use strict';

    const $A = window.App;

    // ─── 项目切换 ─────────────────────────────────

    async function handleSwitchProjectClick() {
        try {
            const resp = await AppApi.getProjects();
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            showProjectSwitchModal(data.teams || []);
        } catch (e) {
            window.showModal(I18N.t('proj_switch_fail'), '<p>' + e.message + '</p>');
        }
    }

    function showProjectSwitchModal(teams) {
        const existing = document.querySelector('.project-switch-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'project-switch-overlay';

        let selectedId = null;
        let selectedTeamId = null;

        let bodyHtml = '';
        if (!teams || teams.length === 0) {
            bodyHtml = '<div class="project-switch-loading">' + I18N.t('switch_no_projects') + '</div>';
        } else {
            teams.forEach(team => {
                bodyHtml += '<div class="project-team-group">' + UIRenderer.escapeHtml(team.name) + '</div>';
                (team.projects || []).forEach(proj => {
                    const isActive = proj.status === 'active';
                    bodyHtml += '\n                        <div class="card-list-item project-item list-item-card' + (isActive ? ' selected is-active' : '') + '" data-project-id="' + UIRenderer.escapeHtml(proj.id) + '" data-team-id="' + UIRenderer.escapeHtml(team.id) + '">\n                            <span class="card-list-dot' + (isActive ? ' active' : ' inactive') + '"></span>\n                            <span class="card-list-name">' + UIRenderer.escapeHtml(proj.name) + '</span>\n                            ' + (isActive ? '<span class="card-list-badge">' + I18N.t('proj_switch_current') + '</span>' : '') + '\n                        </div>';
                });
            });
        }

        overlay.innerHTML = '\n            <div class="project-switch-modal">\n                <div class="project-switch-modal-header">' + I18N.t('proj_switch_select') + '</div>\n                <div class="project-switch-modal-body">' + bodyHtml + '</div>\n                <div class="project-switch-modal-footer">\n                    <button class="project-switch-cancel-btn">' + I18N.t('proj_switch_cancel') + '</button>\n                    <button class="project-switch-confirm-btn" disabled>' + I18N.t('proj_switch_confirm') + '</button>\n                </div>\n            </div>';

        document.body.appendChild(overlay);

        const confirmBtn = overlay.querySelector('.project-switch-confirm-btn');
        const cancelBtn = overlay.querySelector('.project-switch-cancel-btn');

        overlay.querySelectorAll('.project-item').forEach(item => {
            item.addEventListener('click', () => {
                overlay.querySelectorAll('.project-item').forEach(i => {
                    i.classList.remove('selected', 'is-active');
                    const dot = i.querySelector('.card-list-dot');
                    if (dot) { dot.classList.remove('active'); dot.classList.add('inactive'); }
                });
                item.classList.add('selected', 'is-active');
                const dot = item.querySelector('.card-list-dot');
                if (dot) { dot.classList.remove('inactive'); dot.classList.add('active'); }
                selectedId = item.dataset.projectId;
                selectedTeamId = item.dataset.teamId;
                confirmBtn.disabled = false;
            });
        });

        const activeItem = overlay.querySelector('.project-item.selected');
        if (activeItem) {
            selectedId = activeItem.dataset.projectId;
            selectedTeamId = activeItem.dataset.teamId;
            confirmBtn.disabled = false;
        }

        cancelBtn.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        confirmBtn.addEventListener('click', async () => {
            if (!selectedId) return;
            confirmBtn.disabled = true;
            confirmBtn.textContent = I18N.t('proj_switching');
            await confirmSwitchProject(selectedId, selectedTeamId);
            overlay.remove();
        });
    }

    async function confirmSwitchProject(projectId, teamId) {
        try {
            const resp = await AppApi.postSwitchProject({ projectId, teamId });
            const data = await resp.json();
            if (data.success) {
                console.log('[App] 项目切换成功:', data.projectRoot);
                if (window._reloadAll) await window._reloadAll();
            } else {
                window.showModal(I18N.t('proj_switch_fail'),
                    '<p>' + (data.error || I18N.t('modal_unknown_error')) + '</p>');
            }
        } catch (e) {
            window.showModal(I18N.t('proj_switch_fail'), '<p>' + e.message + '</p>');
        }
    }

    // ─── 新建项目 ─────────────────────────────────

    async function handleNewProjectClick() {
        let teams = [];
        try {
            const resp = await AppApi.getProjects();
            if (resp.ok) {
                const data = await resp.json();
                teams = data.teams || [];
            }
        } catch (e) { /* ignore */ }

        const teamOptions = teams.map(t =>
            '<option value="' + UIRenderer.escapeHtml(t.id) + '">' + UIRenderer.escapeHtml(t.name) + '</option>'
        ).join('');

        const html = '\n            <div class="create-project-form">\n                <label class="create-field">\n                    <span>' + I18N.t('create_select_team') + '</span>\n                    <select id="create-team">' + teamOptions + '</select>\n                </label>\n                <label class="create-field">\n                    <span>' + I18N.t('create_project_name') + '</span>\n                    <input id="create-name" type="text" placeholder="' + I18N.t('title_create_name_placeholder') + '">\n                </label>\n                <label class="create-field">\n                    <span>' + I18N.t('create_project_path') + '</span>\n                    <div class="create-path-row">\n                        <input id="create-path" type="text" placeholder="D:/projects/MyProject">\n                        <button id="create-browse" class="create-browse-btn" title="' + I18N.t('title_browse_folder') + '">📂</button>\n                    </div>\n                </label>\n                <button id="create-submit" class="create-submit-btn">' + I18N.t('btn_create_project') + '</button>\n            </div>';

        window.showModal(I18N.t('create_title'), html);

        const modalClose = document.querySelector('.modal-footer .btn-primary');
        if (modalClose) modalClose.style.display = 'none';

        const restoreModalClose = () => { if (modalClose) modalClose.style.display = ''; };

        setTimeout(() => {
            const browseBtn = document.getElementById('create-browse');
            if (browseBtn) {
                browseBtn.onclick = async () => {
                    browseBtn.disabled = true;
                    try {
                        const resp = await AppApi.getBrowseFolder(I18N.t('browse_project_title'));
                        const data = await resp.json();
                        if (data.path) document.getElementById('create-path').value = data.path;
                    } catch (e) { console.error('浏览文件夹失败:', e); }
                    browseBtn.disabled = false;
                };
            }

            const btn = document.getElementById('create-submit');
            if (!btn) return;
            btn.onclick = async function () {
                const teamId = document.getElementById('create-team')?.value;
                const projectName = document.getElementById('create-name')?.value?.trim();
                const projectPath = document.getElementById('create-path')?.value?.trim();

                if (!teamId) { alert(I18N.t('alert_select_team')); return; }
                if (!projectName) { alert(I18N.t('alert_enter_name')); return; }
                if (!projectPath) { alert(I18N.t('alert_enter_path')); return; }

                btn.disabled = true;
                btn.textContent = I18N.t('status_creating');

                try {
                    const resp = await AppApi.postCreateProject({ teamId, projectName, projectPath });
                    const result = await resp.json();
                    if (resp.ok && result.success !== false) {
                        restoreModalClose();
                        window.closeModal();
                        if (window._reloadAll) await window._reloadAll();
                    } else {
                        alert(I18N.t('alert_create_fail') + '：' + I18N.err(result, I18N.t('modal_unknown_error')));
                        btn.disabled = false;
                        btn.textContent = I18N.t('btn_create_project');
                    }
                } catch (err) {
                    alert(I18N.t('alert_create_fail') + '：' + err.message);
                    btn.disabled = false;
                    btn.textContent = I18N.t('btn_create_project');
                }
            };
        }, 100);
    }

    // ─── 项目操作 + 删除 ──────────────────────────

    async function handleInlineProjectAction(action, projId, projName, projRoot, teamId) {
        switch (action) {
            case 'open-dir':
                AppApi.postOpenDir(projId).catch(e => alert(I18N.t('alert_open_dir_fail') + ': ' + e.message));
                break;
            case 'edit-rules':
                AppApi.postOpenFile({ projId, subPath: '.data/teamsoul.md' })
                    .then(async r => { if (!r.ok) { const d = await r.json(); alert(d.error || I18N.t('alert_open_fail')); } })
                    .catch(e => alert(I18N.t('alert_open_fail') + ': ' + e.message));
                break;
            case 'edit-project-rules':
                AppApi.postOpenFile({ projId, subPath: '.data/team RULE.md' })
                    .then(async r => { if (!r.ok) { const d = await r.json(); alert(d.error || I18N.t('alert_open_fail')); } })
                    .catch(e => alert(I18N.t('alert_open_fail') + ': ' + e.message));
                break;
            case 'project-rename':
                if (window.__alpineApp) window.__alpineApp.startProjectRename(teamId, projId, projName);
                break;
            case 'delete-project':
                handleDeleteProject(projId, projName, teamId);
                break;
        }
    }

    async function handleDeleteProject(projId, projName, teamId) {
        try {
            const projectsResp = await AppApi.getProjects();
            const projectsData = await projectsResp.json();
            for (const team of (projectsData.teams || [])) {
                for (const proj of (team.projects || [])) {
                    if (proj.id === projId && proj.status === 'active') {
                        alert(I18N.t('alert_cannot_del_active'));
                        return;
                    }
                }
            }
        } catch (e) { /* ignore */ }

        const confirmed = confirm('确定要删除项目「' + projName + '」吗？\n此操作不可撤销。');
        if (!confirmed) return;

        try {
            const resp = await AppApi.postDeleteProject({ teamId, projectId: projId });
            const result = await resp.json();
            if (resp.ok && result.success !== false) {
                alert(I18N.t('alert_proj_deleted'));
                if (window._refreshDashboard) await window._refreshDashboard();
            } else {
                alert(I18N.t('alert_delete_fail') + '：' + I18N.err(result, I18N.t('modal_unknown_error')));
            }
        } catch (e) {
            alert(I18N.t('alert_delete_fail') + '：' + e.message);
        }
    }

    // ─── 辅助 ─────────────────────────────────────

    function openProjectDir() {
        const projId = findActiveProjectId();
        if (!projId) return;
        AppApi.postOpenDir(projId).catch(e => alert(I18N.t('alert_open_fail') + ': ' + e.message));
    }

    function findActiveProjectId() {
        const teams = $A.teams || [];
        for (const t of teams) {
            const active = t.projects?.find(p => p.status === 'active');
            if (active) return active.id;
        }
        return null;
    }

    return {
        handleSwitchProjectClick,
        confirmSwitchProject,
        handleNewProjectClick,
        handleInlineProjectAction,
        handleDeleteProject,
        openProjectDir,
    };
})();
