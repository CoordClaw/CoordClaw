/**
 * 消息模块 — 消息加载/筛选/发送/已读/分页/成员
 * 依赖：AppApi, I18N, UIRenderer, window.App, window.showModal, DashboardModule
 */
const MessagesModule = (function() {
    'use strict';

    const $A = window.App;
    let _lastRequestId = 0;
    let _refreshTimer = null;
    let _memberFingerprint = null;
    let _filterFingerprint = null;

    // ─── 工具 ─────────────────────────────────────

    function patchViewCount(msgId, vc) {
        const card = document.querySelector('.msg-card[data-msg-id="' + CSS.escape(msgId) + '"]');
        if (card) patchViewCountEl(card, vc);
    }

    function patchViewCountEl(card, vc) {
        const vcEl = card.querySelector('.view-count');
        if (vc > 0) {
            if (vcEl) {
                vcEl.textContent = I18N.tp('msg_view_count', vc);
            } else {
                const div = document.createElement('div');
                div.className = 'view-count';
                div.textContent = I18N.tp('msg_view_count', vc);
                card.querySelector('.flex-1')?.appendChild(div);
            }
        } else if (vcEl) {
            vcEl.remove();
        }
    }

    // ─── 成员/下拉框 ──────────────────────────────

    function populateDropdowns() {
        const members = $A.config?.members || [];
        if (members.length === 0) return;
        const config = $A.config || {};
        const humanMembers = Array.isArray(config.humanMember) ? config.humanMember : (config.humanMember ? [config.humanMember] : []);
        const enabledHumans = humanMembers.filter(h => h.enabled && h.name);
        const nameSet = new Set();
        const items = [];
        enabledHumans.forEach(h => {
            if (!nameSet.has(h.name)) {
                nameSet.add(h.name);
                items.push({ value: h.name, label: h.name + (h.role ? ' (' + h.role + ')' : '') });
            }
        });
        members.forEach(m => {
            if (!nameSet.has(m.name)) {
                nameSet.add(m.name);
                items.push({ value: m.name, label: m.name });
            }
        });
        const names = [...new Set([...enabledHumans.map(h => h.name), ...members.map(m => m.name)].filter(Boolean))];
        const fp = [...names].sort().join(',');
        if (fp === _memberFingerprint) return; // 成员未变，跳过重置
        _memberFingerprint = fp;

        $A.inputMemberNames = names;
        $A.inputDropdownItems = items;
        const app = window.__alpineApp;
        if (app) { app.inputMemberNames = names; app.inputDropdownItems = items; }

        const senderEl = document.getElementById('input-sender');
        const recipientEl = document.getElementById('input-recipient');
        if (senderEl) senderEl.value = enabledHumans[0]?.name || (members[0]?.name || '');
        if (recipientEl) {
            recipientEl.value = members[0]?.name || '';
            if (recipientEl.value === senderEl?.value) recipientEl.value = '';
        }
        if (senderEl && !senderEl._bound) {
            senderEl._bound = true;
            senderEl.addEventListener('change', () => {
                const sel = senderEl.value;
                Array.from(recipientEl.options).forEach(opt => opt.disabled = opt.value === sel && opt.value !== '');
                if (recipientEl.value === sel) recipientEl.value = '';
            });
            recipientEl.addEventListener('change', () => {
                const sel = recipientEl.value;
                Array.from(senderEl.options).forEach(opt => opt.disabled = opt.value === sel && opt.value !== '');
                if (senderEl.value === sel) senderEl.value = '';
            });
        }
    }
    window._populateDropdowns = populateDropdowns;

    function resolveReaderId(name) {
        const config = $A.config || {};
        const member = (config.members || []).find(m => m.name === name);
        if (member?.agent_id) return member.agent_id;
        const humans = Array.isArray(config.humanMember) ? config.humanMember : (config.humanMember ? [config.humanMember] : []);
        const human = humans.find(h => h.name === name);
        if (human?.human_id) return human.human_id;
        return name;
    }

    // ─── 已读切换 ─────────────────────────────────

    async function handleToggleReadClick(card, tagEl) {
        const msgId = card?.dataset?.msgId;
        const recipientName = card?.dataset?.recipient;
        const recipientId = card?.dataset?.recipientId || resolveReaderId(recipientName);
        if (!msgId || !recipientName) return;

        const isCurrentlyUnread = card.classList.contains('unread');
        const newIsUnread = !isCurrentlyUnread;
        const action = isCurrentlyUnread ? 'mark_read' : 'mark_unread';

        card.classList.toggle('unread', newIsUnread);
        card.classList.toggle('read', !newIsUnread);
        tagEl.textContent = newIsUnread ? '○' : '✓';
        tagEl.classList.toggle('unread-btn', newIsUnread);
        const cached = $A.messageCache.find(m => (m.msg_id || m.id) === msgId);
        if (cached) cached.is_unread = newIsUnread;

        AppApi.postToggleRead({ msg_id: msgId, reader_name: recipientName, reader_id: recipientId, action }).catch(() => {});
        loadMembers();
    }

    // ─── 发送 ─────────────────────────────────────

    async function handleSendMessage() {
        const senderEl = document.getElementById('input-sender');
        const recipientEl = document.getElementById('input-recipient');
        const inputEl = document.getElementById('message-input');
        const btnEl = document.getElementById('btn-send-message');

        const sender = senderEl?.value || '';
        const recipient = recipientEl?.value || '';
        const content = (inputEl?.value || '').trim();

        if (!sender || !recipient || !content) {
            window.showModal(I18N.t('modal_op_tip'), '<p style="color: var(--accent-red);">' +
                I18N.t(!sender ? 'input_error_no_sender' : (!recipient ? 'input_error_no_recipient' : 'input_error_no_content')) + '</p>');
            return;
        }

        btnEl.disabled = true;
        try {
            const resp = await AppApi.postSendMessage({ sender, recipient, content });
            const data = await resp.json();
            if (data.success) {
                inputEl.value = '';
                if (data.message) {
                    $A.messageCache = [...$A.messageCache, data.message];
                    const dbTotal = UIRenderer.getPaginationState().totalMessages || 0;
                    UIRenderer.renderMessages($A.messageCache, false, dbTotal + 1);
                    UIRenderer.notifyNewMessages();
                }
                if (data.msg_robot_changed) {
                    const app = window.__alpineApp;
                    if (app) app.msgRobot = true;
                    if ($A.config) $A.config.msgRobot = true;
                }
                loadMembers();
                forceRoute();
            } else {
                window.showModal(I18N.t('input_send_fail'),
                    '<p style="color: var(--accent-red);">' + (data.error || I18N.t('modal_unknown_error')) + '</p>');
            }
        } catch (e) {
            window.showModal(I18N.t('input_send_fail'),
                '<p style="color: var(--accent-red);">' + e.message + '</p>');
        } finally {
            btnEl.disabled = false;
        }
    }

    async function forceRoute() {
        const gw = $A.config?.gatewayUrl;
        if (!gw) return;
        try {
            const r = await AppApi.postForceRoute(gw);
            if (!r.ok) throw new Error('HTTP ' + r.status);
        } catch (e) {
            alert(I18N.t('force_route_fail') + ': ' + e.message);
        }
    }

    // ─── 消息加载 ─────────────────────────────────

    async function loadMessages(params = {}) {
        const requestId = ++_lastRequestId;
        try {
            const limit = params.limit || 50;
            const queryParams = { limit, ...Object.fromEntries(
                Object.entries(params).filter(([k, v]) => k !== 'limit' && v != null && v !== '')
            )};
            const resp = await AppApi.getMessages(queryParams);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            if (requestId !== _lastRequestId) return;

            // ★ 首条消息时间：以 fetch 返回的 firstMessageAt 为准，无条件覆盖（含 null=无消息）
            if (data && 'firstMessageAt' in data) {
                $A.firstMessageAt = data.firstMessageAt ?? null;
                UIRenderer.updateFirstMessage($A.firstMessageAt);
            }

            const messages = data.messages || (Array.isArray(data) ? data : []);
            const totalFromDB = data.total;
            if (params.append) {
                const existingIds = new Set($A.messageCache.map(m => m.msg_id || String(m.id)));
                const newMsgs = messages.filter(m => {
                    const id = m.msg_id || (m.id != null ? String(m.id) : null);
                    return id ? !existingIds.has(id) : true;
                });
                $A.messageCache = [...$A.messageCache, ...newMsgs];
            } else {
                $A.messageCache = messages;
            }
            refreshView(totalFromDB);
        } catch (e) {
            if (requestId === _lastRequestId) {
                console.error('[App] 加载消息失败:', e.message);
                window.showModal(I18N.t('modal_op_tip'),
                    '<p style="color: var(--accent-red);">' + I18N.tp('modal_msg_load_fail', e.message) + '</p>');
            }
        }
    }

    async function loadMoreMessages(oldestId, pageSize) {
        try {
            const fp = getFilterParams();
            const queryParams = {
                limit: pageSize || 50,
                ...(oldestId ? { before_id: oldestId } : {}),
                ...fp,
            };
            const resp = await AppApi.getMessages(queryParams);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            const newMessages = data.messages || [];
            const rawCount = newMessages.length;
            if (rawCount > 0) {
                const existingIds = new Set($A.messageCache.map(m => m.msg_id || String(m.id)));
                const deduped = newMessages.filter(m => {
                    const id = m.msg_id || (m.id != null ? String(m.id) : null);
                    return id ? !existingIds.has(id) : true;
                });
                if (deduped.length > 0) {
                    deduped.reverse();
                    $A.messageCache = [...deduped, ...$A.messageCache];
                }
                return { messages: deduped, hasMore: rawCount >= pageSize };
            }
            return { messages: [], hasMore: false };
        } catch (e) {
            console.error('[App] 加载更多消息失败:', e.message);
            return [];
        }
    }

    // ─── 成员 ─────────────────────────────────────

    function applyMemberStatus() {
        const app = window.__alpineApp;
        if (!app?.memberList) return;
        const latest = $A.latestStatus || [];
        app.memberList.forEach((m) => {
            const s = latest.find(x => x.agentId === m.agentId);
            if (!s || s.status === 'ended')          m.status = 'idle';
            else if (s.fixable === true)               m.status = 'running';
            else                                        m.status = 'ready';
        });
    }

    async function fetchMemberStatus() {
        try {
            const r = await AppApi.getMemberStatus();
            if (!r.ok) return;
            const d = await r.json();
            $A.latestStatus = d.snapshots || [];
            applyMemberStatus();
        } catch {}
    }

    // ★ 查询消息总数（独立于消息列表，解耦分页状态）
    async function fetchTotalCount() {
        const gen = UIRenderer.getPaginationGen();
        try {
            const resp = await AppApi.getMessageCount();
            if (gen !== UIRenderer.getPaginationGen()) return; // 陈旧请求丢弃(快速切换)
            const data = await resp.json();
            if (data.total != null) UIRenderer.setTotalCount(data.total);
        } catch {}
    }

    // ★ 消息列表全量刷新（仅限 DB 重连 / 项目切换触发）
    async function fullReload() {
        UIRenderer.resetPagination();
        UIRenderer.clearMessageList();
        $A.messageCache = [];
        await loadMessages();
        await fetchTotalCount();
    }

    async function reloadAll(currentSSEMode) {
        UIRenderer.resetPagination();
        await DashboardModule.loadConfig();
        UIRenderer.clearMessageList();
        $A.messageCache = [];
        DashboardModule.refreshUI(currentSSEMode);
        await loadMembers();
        populateDropdowns();
        await loadMessages();
        await fetchTotalCount();
        DashboardModule.loadTeams();
    }

    async function loadMembers() {
        try {
            const resp = await AppApi.getMembers();
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            let members = data.members || (Array.isArray(data) ? data : []);
            const config = $A.config || {};
            const humans = Array.isArray(config.humanMember) ? config.humanMember : (config.humanMember ? [config.humanMember] : []);
            const existingNames = new Set(members.map(m => m.name));
            humans.filter(h => h.enabled && h.name && !existingNames.has(h.name)).forEach(h => {
                members.push({ name: h.name, agent_id: h.human_id, role: h.role || 'Human', role_type: h.role_type || 'human' });
            });
            if (members.length > 0) {
                UIRenderer.renderMembers(members);
                applyMemberStatus();
                populateFilterDropdowns(members);
            }
        } catch (e) {
            console.error('[App] 加载成员失败:', e.message);
        }
    }

    async function markRead(msgIds) {
        try {
            const resp = await AppApi.postMarkRead(msgIds, $A.config?.currentUser || I18N.t('default_user'));
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return await resp.json();
        } catch (e) {
            console.error('[App] 标记已读失败:', e.message);
            return { success: false, error: e.message };
        }
    }


    let _markingAll = false;

    async function handleMarkAll() {
        if (_markingAll) return;
        _markingAll = true;

        // ① 即时层：缓存全部标记已读，UI 立即反馈
        $A.messageCache.forEach(m => { m.is_unread = false; });
        refreshView();

        // ② 后端批量：一条 SQL，reader_id 用消息自身 recipient_id
        try {
            const { keyword, sender, recipient } = getActiveFilters();
            const filters = {};
            if (keyword) filters.keyword = keyword;
            if (sender) filters.sender = sender;
            if (recipient) filters.member = recipient;
            await AppApi.postMarkAllRead(filters);
        } catch {} finally {
            _markingAll = false;
            await loadMembers();
        }
    }

    function collectExportFilters() {
        const { keyword, sender, recipient, readStatus } = getActiveFilters();
        const filters = {};
        if (keyword) filters.keyword = keyword;
        if (sender) filters.sender = sender;
        if (recipient) filters.member = recipient;
        if (readStatus === 'unread') filters.unread_only = true;
        if (readStatus === 'read') filters.read_only = true;
        return filters;
    }

    async function handleExportCSV() {
        await AppApi.postExportCSV(collectExportFilters());
    }

    async function handleExportHTML(locale) {
        await AppApi.postExportHTML(collectExportFilters(), locale);
    }

    // ─── 筛选 ─────────────────────────────────────

    function getActiveFilters() {
        const keyword = document.getElementById('filter-keyword')?.value.trim().toLowerCase() || '';
        const sender = document.getElementById('filter-sender')?.value || '';
        const recipient = document.getElementById('filter-recipient')?.value || '';
        const readStatus = document.getElementById('filter-read')?.value || '';
        return { keyword, sender, recipient, readStatus };
    }

    function getFilterParams() {
        return collectExportFilters();
    }

    function refreshView(totalFromDB) {
        clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(() => {
            UIRenderer.renderMessages($A.messageCache, false, totalFromDB);
            setTimeout(() => UIRenderer.initScrollState(), 100);
        }, 100);
    }

    function setMemberFilter(memberName) {
        const currentRecipient = document.getElementById('filter-recipient')?.value || '';
        const currentRead = document.getElementById('filter-read')?.value || '';
        if (memberName && currentRecipient === memberName && currentRead === 'unread') {
            clearAllFilters();
        } else {
            const kw = document.getElementById('filter-keyword'); if (kw) kw.value = '';
            const s = document.getElementById('filter-sender'); if (s) s.value = '';
            const r = document.getElementById('filter-recipient'); if (r) r.value = memberName || '';
            const rs = document.getElementById('filter-read'); if (rs) rs.value = memberName ? 'unread' : '';
        }
        if (typeof window.__clearMemberSelection === 'function') window.__clearMemberSelection();
        loadMessages(getFilterParams());
    }
    window.__setMemberFilter = setMemberFilter;

    function clearAllFilters() {
        const kw = document.getElementById('filter-keyword'); if (kw) kw.value = '';
        const s = document.getElementById('filter-sender'); if (s) s.value = '';
        const r = document.getElementById('filter-recipient'); if (r) r.value = '';
        const rs = document.getElementById('filter-read'); if (rs) rs.value = '';
        if (typeof window.__clearMemberSelection === 'function') window.__clearMemberSelection();
    }

    async function handleFilterChange(e) {
        const target = e.target;
        if (target.tagName === 'SELECT' && target.id === 'filter-sender') {
            const recipientEl = document.getElementById('filter-recipient');
            if (recipientEl && target.value && target.value === recipientEl.value) {
                recipientEl.value = '';
            }
        }
        if (target.id === 'filter-recipient' && !target.value) clearMemberSelectionSidebar();
        await loadMessages(getFilterParams());
    }

    function clearMemberSelectionSidebar() {
        if (typeof window.__clearMemberSelection === 'function') window.__clearMemberSelection();
    }

    function debounceKeyword() {
        clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(() => loadMessages(getFilterParams()), 200);
    }

    function populateFilterDropdowns(members) {
        const names = $A.inputMemberNames.length > 0 ? $A.inputMemberNames : [...new Set((members || []).map(m => m.name).filter(Boolean))];
        const fp = [...names].sort().join(',');
        if (fp === _filterFingerprint) return; // 成员未变，跳过重建
        _filterFingerprint = fp;

        $A.filterMemberNames = names;
        const app = window.__alpineApp;
        if (app) app.filterMemberNames = names;
    }

    function showEmptyProject() {
        const msgInner = document.getElementById('msg-inner');
        if (msgInner) msgInner.innerHTML = '<div data-i18n="msg_empty_project" style="text-align:center;padding:60px 20px;color:var(--text-secondary);font-size:14px">' + I18N.t('msg_empty_project') + '</div>';
        const filterBar = document.getElementById('message-filter-bar');
        if (filterBar) filterBar.style.display = 'none';
    }

    return {
        load: loadMessages,
        loadMore: loadMoreMessages,
        loadMembers,
        handleMarkAll,
        handleExportCSV,
        handleExportHTML,
        handleSendMessage,
        handleToggleReadClick,
        handleFilterChange,
        debounceKeyword,
        populateDropdowns,
        getFilterParams,
        getActiveFilters,
        refreshView,
        applyMemberStatus,
        fetchMemberStatus,
        reloadAll,
        fullReload,
        showEmptyProject,
    };
})();

// ★ 全局桥接
window._reloadAll = function() { MessagesModule.reloadAll('sse'); };
