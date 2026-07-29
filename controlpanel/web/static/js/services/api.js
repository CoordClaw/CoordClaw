/**
 * API 服务层 — 统一所有后端请求入口
 * 所有模块通过 AppApi.xxx() 调用，不再内联 fetch
 */
const AppApi = (function() {
    'use strict';

    const BASE = '';

    // ─── 通用请求工具 ──────────────────────────────

    function _get(url, params) {
        const qs = params ? '?' + new URLSearchParams(
            Object.entries(params).filter(([,v]) => v != null && v !== '')
        ).toString() : '';
        return fetch(BASE + url + qs);
    }

    function _post(url, body) {
        return fetch(BASE + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
    }

    function _put(url, body) {
        return fetch(BASE + url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    // ─── 配置 ──────────────────────────────────────

    function getConfig()           { return _get('/api/config'); }
    function postConfig(body)      { return _post('/api/config', body); }
    function getUpdateInfo()       { return _get('/api/update-info', { _: Date.now() }); }

    // ─── 消息 ──────────────────────────────────────

    function getMessages(params) {
        return _get('/api/messages', { limit: params?.limit || 50, ...params });
    }
    function getMessageCount()     { return _get('/api/messages/count'); }
    function getMembers()          { return _get('/api/members'); }
    function postMarkRead(msgIds, reader) {
        return _post('/api/mark-read', { msg_ids: msgIds, reader });
    }
    function postMarkAllRead(filters) {
        return _post('/api/mark-all-read', filters || {});
    }
    // Shared download: fetch already done by caller; turns the response into a
    // browser download. `forceOctet` wraps bytes as application/octet-stream to
    // stop Chrome navigating inline for text/html blobs (it ignores a.download
    // for navigable MIME types). CSV keeps its natural text/csv type.
    async function triggerDownload(resp, filename, forceOctet) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = forceOctet
            ? new Blob([await resp.arrayBuffer()], { type: 'application/octet-stream' })
            : await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    async function postExportCSV(filters) {
        const resp = await fetch('/api/export-csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filters || {}),
        });
        await triggerDownload(resp, 'coordclaw_team_messages_export.csv', false);
    }
    async function postExportHTML(filters, locale) {
        const body = Object.assign({}, filters || {}, { locale: locale || 'zh' });
        const resp = await fetch('/api/export-html', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        await triggerDownload(resp, 'coordclaw_team_messages_export.html', true);
    }
    function postSendMessage(data) { return _post('/api/send-message', data); }
    function postToggleRead(data)  { return _post('/api/toggle-read', data); }

    // ─── 项目 ──────────────────────────────────────

    function getProjects()         { return _get('/api/projects'); }
    function postCreateProject(d)  { return _post('/api/create-project', d); }
    function postDeleteProject(d)  { return _post('/api/delete-project', d); }
    function postSwitchProject(d)  { return _post('/api/project-switch', d); }
    function postWorkspaceReset(d) {
        return _post('/api/workspace-reset', d);
    }

    // ─── 团队 ──────────────────────────────────────

    function postDeleteTeam(d)     { return _post('/api/delete-team', d); }
    function postRenameTeam(d)     { return _post('/api/rename-team', d); }
    function postRenameProject(d)  { return _post('/api/rename-project', d); }
    function postRegisterTeam(d)   { return _post('/api/register-team', d); }
    function postStartTeamMonitor(){ return _post('/api/start-team-monitor'); }
    function postStopTeamMonitor() { return _post('/api/stop-team-monitor'); }

    // ─── 文件操作 ──────────────────────────────────

    function postOpenDir(projId)   { return _post('/api/open-dir', { projId }); }
    function postOpenFile(body)    { return _post('/api/open-file', body); }
    function postOpenFolder(path)  { return _post('/api/open-folder', { path }); }
    function postOpenTeamsoul(teamId) { return _post('/api/open-teamsoul', { teamId }); }
    function postOpenTeamDir(teamId)  { return _post('/api/open-team-dir', { teamId }); }
    function postOpenTeamRule(teamId) { return _post('/api/open-team-rule', { teamId }); }
    function getBrowseFolder(title) {
        return _get('/api/browse-folder', { title });
    }
    function getBrowseFile(title) {
        return _get('/api/browse-file', { title });
    }
    function postImportTeamTpkg(path) {
        return _post('/api/import-team-tpkg', { path });
    }
    async function postExportTeamTpkg(teamId) {
        const resp = await fetch('/api/export-team-tpkg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId }),
        });
        if (!resp.ok) {
            let msg = 'HTTP ' + resp.status;
            try { const d = await resp.json(); if (d && d.error) msg = d.error; } catch {}
            throw new Error(msg);
        }
        await triggerDownload(resp, teamId + '.tpkg', true);
    }

    // ─── 技能 ──────────────────────────────────────

    function getSkills(refresh)     { return _get('/api/skills', refresh ? { refresh: 1 } : {}); }
    function postSkillToggle(name)  { return _post('/api/skills/toggle', { name }); }
    function postInstallSkill(sourcePath) {
        return _post('/api/install-skill', { sourcePath });
    }
    function getOpenSkillDir(name)  { return _get('/api/open-skill-dir', { name }); }
    function getMemberSkills(agentId) {
        return _get('/api/member-skills', { agentId });
    }
    function putMemberSkills(agentId, skills) {
        return _put('/api/member-skills', { agentId, skills });
    }

    // ─── 大模型 ──────────────────────────────────────

    function getModels() { return _get('/api/models'); }
    function postModelConfig(model, sessionKey, agentId) {
        const body = { model };
        if (sessionKey) body.sessionKey = sessionKey;
        if (agentId) body.agentId = agentId;
        return _post('/api/model-config', body);
    }
    function getDatabaseStatus()     { return _get('/api/database-status'); }
    function postRestoreDatabase()   { return _post('/api/restore-database'); }

    // ─── 开关 ──────────────────────────────────────

    function postToggleHuman(humanId) { return _post('/api/toggle-human', { human_id: humanId }); }
    function postToggleMsgRobot()     { return _post('/api/toggle-msg-robot'); }
    function postToggleAutoCoord()    { return _post('/api/toggle-auto-coordination'); }

    // ─── 状态/杂项 ─────────────────────────────────

    function getMemberStatus()     { return _get('/api/member-status'); }
    /** 调用 Gateway force-route */
    function postForceRoute(gatewayUrl) {
        if (!gatewayUrl) return Promise.resolve();
        return fetch(gatewayUrl + '/coordclaw-plugin/coordclawcenter/force-route', { method: 'POST' });
    }

    return {
        getConfig, postConfig, getUpdateInfo,
        getMessages, getMessageCount, getMembers, postMarkRead, postMarkAllRead, postExportCSV, postExportHTML, postSendMessage, postToggleRead,
        getProjects, postCreateProject, postDeleteProject, postSwitchProject,
        postWorkspaceReset,
        postDeleteTeam, postRegisterTeam, postStartTeamMonitor, postStopTeamMonitor, postRenameTeam, postRenameProject,
        postOpenDir, postOpenFile, postOpenFolder, postOpenTeamsoul,
        postOpenTeamDir, postOpenTeamRule, getBrowseFolder, getBrowseFile,
        getSkills, postSkillToggle, postInstallSkill, getOpenSkillDir, postImportTeamTpkg, postExportTeamTpkg,
        getMemberSkills, putMemberSkills,
        getModels, postModelConfig,
        getDatabaseStatus, postRestoreDatabase,
        postToggleHuman, postToggleMsgRobot, postToggleAutoCoord,
        getMemberStatus, postForceRoute,
    };
})();
