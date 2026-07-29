/**
 * 技能模块 — 技能清单渲染 / 成员技能弹窗 / 安装
 * 依赖：AppApi, I18N, UIRenderer, window.showModal, window.closeModal
 */
const SkillsModule = (function() {
    'use strict';

    /** ★ 渲染技能清单卡片（工具 Tab） */
    async function renderCard() {
        try {
            const resp = await AppApi.getSkills(true);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            renderCardWithData(data.skills);
        } catch (e) {
            const container = document.getElementById('tools-list');
            if (container) container.innerHTML = '<div class="card-list-item" style="color:var(--accent-red)">' + I18N.t('skill_load_fail') + '</div>';
        }
    }

    function renderCardWithData(skills) {
        const container = document.getElementById('tools-list');
        const countEl = document.getElementById('skill-count');
        if (countEl) {
            countEl.textContent = ' (' + (skills ? skills.length : 0) + ')';
        }
        if (!container) return;
        if (!skills || skills.length === 0) {
            container.innerHTML = '<div class="card-list-item" style="color:var(--text-secondary)">' + I18N.t('list_no_items') + '</div>';
            return;
        }
        let html = '';
        skills.forEach(s => {
            const name = s.name;
            const enabled = !!s.enabled;
            const desc = s.desc ? UIRenderer.escapeHtml(s.desc) : '';
            html += '<div class="card-list-item skill-item list-item-card" data-skill="' + UIRenderer.escapeHtml(name) + '">'
                + '<button class="toggle-switch' + (enabled ? ' active' : '') + '" data-action="toggle-skill" data-skill-name="' + UIRenderer.escapeHtml(name) + '">'
                + (enabled ? I18N.t('skill_on') : I18N.t('skill_off'))
                + '</button>'
                + '<span class="skill-name"' + (desc ? ' title="' + desc + '"' : '') + ' style="cursor:pointer">' + UIRenderer.escapeHtml(name) + '</span>'
                + '</div>';
        });
        container.innerHTML = html;
    }

    /** 保存成员技能并关弹窗 */
    async function _saveMemberSkills(agentId, skills) {
        try {
            const r = await AppApi.putMemberSkills(agentId, skills);
            if (!r.ok) { const d = await r.json(); alert(d.error || I18N.t('alert_save_fail')); return; }
            window.closeModal();
        } catch (e) {
            alert(I18N.t('alert_save_fail') + ': ' + e.message);
        }
    }

    /** 技能配置弹窗 */
    function showSkillModal(memberName, agentId, data) {
        const assigned = data.assigned || [];
        const available = data.available || [];
        const allEnabled = data.all === true;
        const allSkills = [
            ...assigned.map(s => ({ ...s, assigned: true })),
            ...available.map(s => ({ ...s, assigned: false }))
        ];

        const skillList = allSkills.map(s =>
            '<label class="list-item-card" style="display:flex;align-items:center;gap:8px;cursor:pointer">'
                + '<input type="checkbox" value="' + UIRenderer.escapeHtml(s.name) + '" ' + (s.assigned || (allEnabled && s.enabled) ? 'checked' : '') + ' ' + (s.enabled ? '' : 'disabled') + ' style="accent-color:var(--accent-blue);flex-shrink:0">'
                + '<span style="font-size:13px;color:' + (s.enabled ? 'var(--text-primary)' : 'var(--text-secondary)') + ';min-width:180px;flex-shrink:0">' + UIRenderer.escapeHtml(s.name) + '</span>'
                + '<span style="font-size:11px;color:var(--text-secondary);line-height:1.5">' + (s.enabled ? UIRenderer.escapeHtml(s.desc) : I18N.t('skill_locked') + ' ' + UIRenderer.escapeHtml(s.name)) + '</span>'
            + '</label>'
        ).join('');

        const body = '<div style="font-size:13px;max-height:380px;overflow-y:auto">' + skillList + '</div>';

        const footerHtml =
            '<button onclick="window._skillSelectAll()" style="background:var(--bg-primary);color:var(--accent-blue);border:1px solid var(--accent-blue);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;margin-right:4px">' + I18N.t('skill_select_all') + '</button>'
            + '<button onclick="window._skillInvert()" style="background:var(--bg-primary);color:var(--text-secondary);border:1px solid var(--border-color);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;margin-right:auto">' + I18N.t('skill_deselect_all') + '</button>'
            + '<button onclick="window.closeModal()" style="background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;margin-right:8px">' + I18N.t('modal_cancel') + '</button>'
            + '<button onclick="window._skillSave()" style="background:var(--accent-blue);color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px">' + I18N.t('modal_confirm') + '</button>';

        window._skillSave = async () => {
            const allCbs = document.querySelectorAll('#modal-body input[type=checkbox]:not([disabled])');
            const checked = [...allCbs].filter(cb => cb.checked).map(cb => cb.value);
            const skills = checked.length === allCbs.length ? null : checked;
            await _saveMemberSkills(agentId, skills);
        };
        window._skillSelectAll = () => {
            document.querySelectorAll('#modal-body input[type=checkbox]:not([disabled])').forEach(cb => cb.checked = true);
        };
        window._skillInvert = () => {
            document.querySelectorAll('#modal-body input[type=checkbox]:not([disabled])').forEach(cb => cb.checked = !cb.checked);
        };

        window.showModal(I18N.tp('skill_title', memberName), body, footerHtml);
    }

    async function openMemberSkill(memberName, agentId) {
        if (!agentId) {
            alert(I18N.t('member_no_id'));
            return;
        }
        try {
            const r = await AppApi.getMemberSkills(agentId);
            if (!r.ok) { const d = await r.json(); alert(d.error || I18N.t('alert_open_fail')); return; }
            const data = await r.json();
            showSkillModal(memberName, agentId, data);
        } catch (e) {
            alert(I18N.t('alert_open_fail') + ': ' + e.message);
        }
    }

    return { renderCard, renderCardWithData, openMemberSkill };
})();
