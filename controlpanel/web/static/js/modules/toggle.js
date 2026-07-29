/**
 * Toggle 开关模块 — 人类启用 / 消息路由 / 自动协同
 * 依赖：AppApi, I18N, window.App, window.showModal, window.__alpineApp
 * 注意：populateSenderRecipientDropdowns 通过 window._populateDropdowns 桥接，
 *       后续消息模块抽取后可直接调用 MessagesModule.populateDropdowns()
 */
const ToggleModule = (function() {
    'use strict';

    const $A = window.App;

    /** 刷新 Alpine 项目信息 + 同步配置（等价于 renderProjectInfo + syncToAlpine） */
    function _syncProjectInfo(config) {
        const app = window.__alpineApp;
        if (!app || !config) return;
        const members = config.members || [];
        const mr = config.msgRobot;
        app.teamName = config.teamName || '';
        app.projectName = config.projectName || '';
        app.memberCount = members.length;
        app.projectRoot = config.projectRoot || '';
        app.humanMembers = Array.isArray(config.humanMember)
            ? config.humanMember
            : (config.humanMember ? [config.humanMember] : []);
        app.autoCoordination = !!config.autoCoordination;
        app.msgRobot = typeof mr === 'object' && mr ? !!mr.enabled : !!mr;
        app.config = $A.config;
        app.teams = $A.teams;
    }

    async function handleToggleHuman(humanId) {
        const app = window.__alpineApp;
        const oldMembers = app ? [...app.humanMembers] : [];
        try {
            const resp = await AppApi.postToggleHuman(humanId);
            const data = await resp.json();
            if (data.success) {
                const configResp = await AppApi.getConfig();
                const config = await configResp.json();
                if ($A.config) $A.config.humanMember = config.humanMember;
                _syncProjectInfo(config);
                if (typeof window._populateDropdowns === 'function') {
                    window._populateDropdowns();
                }
            } else {
                window.showModal(I18N.t('modal_op_fail'),
                    `<p style="color:var(--accent-red);">${data.error || I18N.t('modal_unknown_error')}</p>`);
            }
        } catch (e) {
            if (app && oldMembers.length) app.humanMembers = oldMembers;
            window.showModal(I18N.t('modal_op_fail'),
                `<p style="color:var(--accent-red);">${e.message}</p>`);
        }
    }

    async function handleToggleMsgRobot() {
        const app = window.__alpineApp;
        const oldVal = app ? !!app.msgRobot : false;
        if (app) app.msgRobot = !oldVal;
        try {
            const resp = await AppApi.postToggleMsgRobot();
            const data = await resp.json();
            if (data.success) {
                const configResp = await AppApi.getConfig();
                const config = await configResp.json();
                if ($A.config) $A.config.msgRobot = !!data.msg_robot;
                _syncProjectInfo(config);
            } else {
                if (app) app.msgRobot = oldVal;
                window.showModal(I18N.t('modal_op_fail'),
                    `<p style="color:var(--accent-red);">${data.error || I18N.t('modal_unknown_error')}</p>`);
            }
        } catch (e) {
            if (app) app.msgRobot = oldVal;
            window.showModal(I18N.t('modal_op_fail'),
                `<p style="color:var(--accent-red);">${e.message}</p>`);
        }
    }

    async function handleToggleAutoCoord() {
        const app = window.__alpineApp;
        const oldVal = app ? !!app.autoCoordination : false;
        if (app) app.autoCoordination = !oldVal;
        try {
            const resp = await AppApi.postToggleAutoCoord();
            const data = await resp.json();
            if (data.success) {
                const configResp = await AppApi.getConfig();
                const config = await configResp.json();
                if ($A.config) $A.config.autoCoordination = !!data.enabled;
                _syncProjectInfo(config);
            } else {
                if (app) app.autoCoordination = oldVal;
                window.showModal(I18N.t('modal_op_fail'),
                    `<p>${data.error || I18N.t('modal_unknown_error')}</p>`);
            }
        } catch (e) {
            if (app) app.autoCoordination = oldVal;
            window.showModal(I18N.t('modal_op_fail'),
                `<p>${e.message}</p>`);
        }
    }

    // 注册到 window（Alpine @click 需要）
    window.handleToggleHuman = handleToggleHuman;
    window.handleToggleMsgRobot = handleToggleMsgRobot;
    window.handleToggleAutoCoord = handleToggleAutoCoord;

    return { handleToggleHuman, handleToggleMsgRobot, handleToggleAutoCoord };
})();
