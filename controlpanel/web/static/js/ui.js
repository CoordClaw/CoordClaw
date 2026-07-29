/**
 * UI渲染模块 V3 - CoordClaw Web
 * 依据：苏晓 UI设计规范 V1.1（已审核 100/100）
 * 实现：D2 头像生成、D3 消息卡片布局、D4 响应式支持、D5 已读/未读视觉区分
 */

const UIRenderer = (function() {
    'use strict';

    // ==================== ★ 统一的工具函数 ====================

    /**
     * ★ 统一的未读状态判断函数（唯一入口）
     */
    function isMessageUnread(msg) {
        return msg.is_unread === true;
    }

    // ==================== D2 头像生成 ====================

    function generateAvatarGradient(name) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(name);
        const hash = Array.from(bytes).reduce((sum, byte) => (sum + byte) % 360, 0);
        const startHue = hash;
        const endHue = (hash + 60) % 360;
        return `linear-gradient(45deg, hsl(${startHue}, 70%, 50%), hsl(${endHue}, 70%, 50%))`;
    }
    window.avatarGradient = generateAvatarGradient;

    function getLastChar(name) {
        return (name || '?').slice(-1);
    }
    window.avatarChar = getLastChar;

    function getSenderName(msg) {
        return msg.from_name || msg.sender || I18N.t('msg_unknown_sender');
    }

    // ==================== DOM缓存 ====================

    let dom = {};
    let isAtBottom = true;
    let hasNewMessagesWhileScrolled = false;
    const scrollThreshold = 150;

    let paginationState = {
        totalMessages: 0,
        loadedCount: 0,
        pageSize: 50,
        oldestLoadedId: null,
        isLoadingMore: false,
        hasMore: true
    };

    let onLoadMoreCallback = null;
    let onToggleReadCallback = null;
    let _paginationGen = 0;

    function cacheDOMElements() {
        dom.messageList = document.getElementById('message-list');
        dom.msgInner = document.getElementById('msg-inner');
        dom.memberList = document.getElementById('member-list');
        dom.connectionStatus = document.getElementById('connection-status');
        dom.gatewayStatus = document.getElementById('gateway-status');
		dom.lastUpdate = document.getElementById('last-update');
		dom.msgCount = document.getElementById('msg-count');
		if (dom.msgCount) dom.msgCount.textContent = I18N.t('status_loading');
		dom.sseMode = document.getElementById('sse-mode');
		dom.filterSender = document.getElementById('filter-sender');
		dom.btnMarkAll = document.getElementById('btn-mark-all');
		dom.scrollToLatestBtn = document.getElementById('scroll-to-latest');
		dom.scrollToLatestWrapper = document.getElementById('scroll-to-latest-wrapper');

        if (dom.scrollToLatestBtn) {
            dom.scrollToLatestBtn.addEventListener('click', handleScrollToLatest);
        }

        if (dom.messageList) {
            dom.messageList.addEventListener('scroll', handleScroll);
        }

        initNavDropdowns();
    }

    function initNavDropdowns() {
        const triggers = document.querySelectorAll('.nav-trigger');
        triggers.forEach(trigger => {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const menuKey = trigger.dataset.menu;
                const dropdown = document.querySelector(`[data-menu-id="${menuKey}"]`);
                if (!dropdown) return;

                const isOpen = dropdown.classList.contains('open');
                closeAllDropdowns();

                if (!isOpen) {
                    dropdown.classList.add('open');
                    trigger.setAttribute('aria-expanded', 'true');
                }
            });
        });

        // 为菜单项绑定点击事件
        const menuItems = document.querySelectorAll('.nav-item');
        menuItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                if (action && typeof window.__navActionHandler === 'function') {
                    window.__navActionHandler(action, item);
                }
                closeAllDropdowns();
            });
        });

        document.addEventListener('click', () => closeAllDropdowns());
    }

    function closeAllDropdowns() {
        document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
        document.querySelectorAll('.nav-trigger[aria-expanded="true"]').forEach(t => t.setAttribute('aria-expanded', 'false'));
    }

    function handleScroll() {
        if (!dom.messageList) return;

        const { scrollTop, scrollHeight, clientHeight } = dom.messageList;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        const distanceFromTop = scrollTop;

        isAtBottom = distanceFromBottom < scrollThreshold;

        if (isAtBottom) {
            hideScrollToLatestButton();
            hasNewMessagesWhileScrolled = false;
        } else {
            showScrollToLatestButton();
        }

        if (distanceFromTop < 100 && paginationState.hasMore && !paginationState.isLoadingMore) {
            handleLoadMore();
        }
    }

    function initScrollState() {
        if (dom.messageList) {
            const { scrollTop, scrollHeight, clientHeight } = dom.messageList;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
            isAtBottom = distanceFromBottom < scrollThreshold;
            if (!isAtBottom) {
                showScrollToLatestButton();
            }
        }
    }

    function handleScrollToLatest() {
        scrollToBottom();
        hasNewMessagesWhileScrolled = false;
        hideScrollToLatestButton();
        if (dom.scrollToLatestBtn) {
            dom.scrollToLatestBtn.classList.remove('has-new-messages');
        }
    }

    function showScrollToLatestButton() {
        const app = window.__alpineApp;
        if (app) app.isScrolledUp = true;
        if (hasNewMessagesWhileScrolled) {
            if (app) app.hasNewMessages = true;
        }
    }

    function hideScrollToLatestButton() {
        const app = window.__alpineApp;
        if (app) { app.isScrolledUp = false; app.hasNewMessages = false; }
    }

    function notifyNewMessages() {
        if (!isAtBottom) {
            hasNewMessagesWhileScrolled = true;
            showScrollToLatestButton();
        }
    }

    // ==================== 分页加载功能 ====================

    function handleLoadMore() {
        if (paginationState.isLoadingMore || !paginationState.hasMore) return;
        paginationState.isLoadingMore = true;

        const gen = _paginationGen;
        updateLoadStatus(I18N.t('msg_load_more'));

        if (onLoadMoreCallback) {
            onLoadMoreCallback(paginationState.oldestLoadedId, paginationState.pageSize)
                .then(result => {
                    if (gen !== _paginationGen) return;

                    const newMessages = result?.messages || (Array.isArray(result) ? result : []);
                    const hasMore = result?.hasMore ?? (newMessages.length >= paginationState.pageSize);
                    if (newMessages && newMessages.length > 0) {
                        prependOldMessages(newMessages);
                        paginationState.oldestLoadedId = newMessages[0]?.id;
                        paginationState.loadedCount += newMessages.length;
                        paginationState.hasMore = hasMore;
                    } else {
                        paginationState.hasMore = false;
                        updateLoadStatus(I18N.t('msg_loaded_all'));
                    }
                })
                .catch(err => {
                    console.error('[UI] 加载更多失败:', err);
                    updateLoadStatus(I18N.t('msg_load_failed'));
                })
                .finally(() => {
                    if (gen === _paginationGen) {
                        paginationState.isLoadingMore = false;
                    }
                });
        }
    }

    function prependOldMessages(messages) {
        if (!messages || messages.length === 0) return;

        const fragment = document.createDocumentFragment();
        const temp = document.createElement('div');
        messages.forEach(msg => {
            temp.innerHTML = renderMessage(msg, isMessageUnread(msg));
            while (temp.firstChild) fragment.appendChild(temp.firstChild);
        });

        // 保持滚动位置
        const scrollHeightBefore = dom.messageList.scrollHeight;
        const scrollTopBefore = dom.messageList.scrollTop;

        dom.msgInner.insertBefore(fragment, dom.msgInner.firstChild);

        const scrollHeightAfter = dom.messageList.scrollHeight;
        dom.messageList.scrollTop = scrollTopBefore + (scrollHeightAfter - scrollHeightBefore);

        updateMsgCount();
    }

    function initPagination(total, loaded, oldestId) {
        paginationState.totalMessages = total;
        paginationState.loadedCount = loaded;
        paginationState.oldestLoadedId = oldestId;
        paginationState.hasMore = loaded < total;
        paginationState.isLoadingMore = false;
    }

    // ★ 仅设置消息总数(不触碰 loaded/hasMore/oldest)，供边界权威设定与 SSE 对账使用
    function setTotalCount(total) {
        if (total == null) return;
        paginationState.totalMessages = total;
        updateMsgCount();
    }

    // ★ 暴露当前分页世代，供异步计数操作做陈旧丢弃
    function getPaginationGen() {
        return _paginationGen;
    }

    function updateLoadStatus(text) {
        if (dom.msgCount) {
            dom.msgCount.textContent = text;
        }
    }

    // ==================== D3/D5 消息卡片渲染 ====================

    function _msgTime(msg) {
        const t = msg.created_at || msg.timestamp;
        return t ? new Date(t).getTime() : 0;
    }

    function formatTime(isoString) {
        if (!isoString || isoString === 'undefined' || isoString === 'null') {
            return '—';
        }

        let d;

        try {
            if (typeof isoString === 'number') {
                d = new Date(isoString > 1e12 ? isoString : isoString * 1000);
            } else if (typeof isoString === 'string') {
                const cleaned = isoString.trim();
                d = new Date(cleaned);

                if (isNaN(d.getTime()) && cleaned.includes(' ')) {
                    const normalized = cleaned.replace(' ', 'T');
                    d = new Date(normalized);
                }

                if (isNaN(d.getTime()) && !cleaned.includes('Z') && !cleaned.includes('+')) {
                    d = new Date(cleaned + 'Z');
                }

                if (isNaN(d.getTime())) {
                    const dateMatch = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
                    if (dateMatch) {
                        const [, year, month, day, hour, min, sec] = dateMatch;
                        d = new Date(
                            parseInt(year),
                            parseInt(month) - 1,
                            parseInt(day),
                            parseInt(hour),
                            parseInt(min),
                            parseInt(sec || '0')
                        );
                    }
                }
            } else {
                return '—';
            }

            if (!d || isNaN(d.getTime())) {
                return isoString;
            }

            const hours = String(d.getHours()).padStart(2, '0');
            const minutes = String(d.getMinutes()).padStart(2, '0');
            const seconds = String(d.getSeconds()).padStart(2, '0');
            const timeStr = `${hours}:${minutes}:${seconds}`;

            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

            if (msgDate.getTime() === today.getTime()) {
                return timeStr;                          // 今天 → 14:32:08
            } else {
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${year}-${month}-${day} ${timeStr}`;  // 更早 → 2026-05-18 14:32:08
            }

        } catch (error) {
            console.error('[UI] ❌ 时间格式化错误:', error, '输入值:', isoString);
            return String(isoString);
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderMessage(msg, isUnread) {
        const senderName = getSenderName(msg);
        const safeSender = escapeHtml(senderName);
        const recipientName = msg.recipient || '';
        const time = formatTime(msg.created_at || msg.timestamp);
        const content = escapeHtml(msg.content || msg.message || '').replace(/\\n/g, '<br>');
        const toName = recipientName
            ? `<span class="recipient-arrow">→</span><span class="recipient-name">${escapeHtml(recipientName)}</span>`
            : '';
        const avatarGradient = generateAvatarGradient(senderName);
        const lastChar = getLastChar(senderName);
        const isRecipientRead = !isUnread;
        const readBtnClass = isRecipientRead ? 'read-tag' : 'read-tag unread-btn';
        const ariaLabel = `${isUnread ? I18N.t('msg_unread') : I18N.t('msg_read')}: ${safeSender} ${time}`;

        return `<div class="msg-card ${isUnread ? 'unread' : 'read'}" data-id="${escapeHtml(String(msg.id || ''))}" data-msg-id="${escapeHtml(String(msg.msg_id || ''))}" data-sender="${safeSender}" data-recipient="${escapeHtml(recipientName)}" data-recipient-id="${escapeHtml(msg.recipient_id || '')}" id="message-${escapeHtml(String(msg.id || ''))}" role="article" aria-label="${ariaLabel}" tabindex="0">
            <div class="flex items-start">
                <div class="avatar" style="background: ${avatarGradient};">${lastChar}</div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center mb-1 flex-wrap">
                        <span class="sender">${safeSender}</span>${toName}
                        <span class="timestamp ml-auto">${time}</span>
                    </div>
                    <p class="message-content">${content}</p>
                    ${(msg.view_count > 0) ? `<div class="view-count" title="${I18N.tp('msg_view_title', msg.view_count)}">${I18N.tp('msg_view_count', msg.view_count)}</div>` : ''}
                </div>
                <span class="${readBtnClass}" title="${I18N.t('msg_toggle_read_title')}">${isRecipientRead ? '✓' : '○'}</span>
            </div>
        </div>`;
    }

    function renderMessages(messages, append, total) {
        if (!append) dom.msgInner.innerHTML = '';

        if (messages.length === 0 && !append) {
            dom.msgInner.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text" data-i18n="msg_empty">${I18N.t('msg_empty')}</div></div>`;
            updateMsgCount();
            updateFirstMessage(null);
            updateLoadStatus(I18N.t('msg_no_records'));
            return;
        }

        // ★ 去重：以 msg_id（优先）或 id 作为唯一标识
        const seen = new Set();
        const unique = messages.filter(m => {
            const key = m.msg_id || (m.id != null ? String(m.id) : null);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const seenDates = new Set();
        // ★ 按时间升序（旧→新），新消息自然在底部
        const sorted = [...unique].sort((a, b) => _msgTime(a) - _msgTime(b));
        let html = '';
        sorted.forEach(msg => {
            const msgDate = msg.created_date ? (() => {
                const [y, m, d] = msg.created_date.split('-');
                return I18N.getLocale() === 'en' ? `${m}/${d}/${y}` : `${y}年${parseInt(m)}月${parseInt(d)}日`;
            })() : '';
            if (!seenDates.has(msgDate) && msgDate) {
                seenDates.add(msgDate);
                html += `<div class="date-separator" aria-hidden="true">${escapeHtml(msgDate)}</div>`;
            }
            html += renderMessage(msg, isMessageUnread(msg));
        });

        if (!append) {
            dom.msgInner.innerHTML = html;
            bindMessageCardEvents(dom.messageList);
            if (total !== undefined) {
                initPagination(total, messages.length, sorted[0]?.id);
            }
            // ★ 双 RAF 确保浏览器完成布局后计算正确 scrollHeight
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    scrollToBottom();
                    isAtBottom = true;
                });
            });
        } else {
            const temp = document.createElement('div');
            temp.innerHTML = html;
            while (temp.firstChild) {
                dom.msgInner.appendChild(temp.firstChild);
            }
            notifyNewMessages();
            paginationState.loadedCount += messages.length;
            bindMessageCardEvents(dom.messageList);
        }
        updateMsgCount();
    }

    /**
     * 批量绑定消息卡片事件（innerHTML 后调用）
     */
    function bindMessageCardEvents(container) {
        // ★ 事件委托（主通路，innerHTML 后始终有效）
        if (!container._readTagDelegation) {
            container._readTagDelegation = true;
            container.addEventListener('click', (e) => {
                const tag = e.target.closest('.read-tag');
                if (!tag) return;
                e.stopPropagation();
                const card = tag.closest('.msg-card');
                if (card && typeof onToggleReadCallback === 'function') {
                    onToggleReadCallback(card, tag);
                }
            });
        }
    }

    // ==================== D5 已读/未读状态切换 ====================

    function toggleReadStatus(messageId, isUnread) {
        const card = document.getElementById(`message-${messageId}`);
        if (!card) return;

        if (isUnread) {
            card.classList.remove('read');
            card.classList.add('unread');
        } else {
            card.classList.remove('unread');
            card.classList.add('read');
        }
    }

    function batchUpdateCardReadStatus(msgIds, isUnread) {
        if (!Array.isArray(msgIds)) return;
        msgIds.forEach(id => toggleReadStatus(id, isUnread));
    }

    // ==================== 成员列表渲染 ====================

    function renderMembers(members) {
        const app = window.__alpineApp;
        if (!app) return;
        const teamMemberNames = new Set((window.App?.config?.members || []).map(m => m.name));
        const filterRecipient = document.getElementById('filter-recipient')?.value || '';
        const filterRead = document.getElementById('filter-read')?.value || '';
        app.memberList = (members || []).map(member => {
            const name = member.name || '';
            const unread = member.unread_count || 0;
            const selected = name && filterRecipient === name && filterRead === 'unread';
            return {
                name,
                agentId: member.agent_id || '',
                sessionKey: member.sessionKey || '',
                role: member.role || '',
                unread,
                unreadClass: unread > 0 ? '' : 'zero',
                avatarBg: generateAvatarGradient(name || '?'),
                avatarChar: getLastChar(name || '?'),
                selected,
                isAgent: teamMemberNames.has(name),
                showUnreadTag: selected,
                msgTitle: I18N.tp('member_send_msg', name || ''),
                skillTitle: I18N.tp('member_config_skill', name || ''),
                ariaLabel: I18N.tp('member_aria', name || I18N.t('msg_unknown_sender'), unread),
            };
        });
    }

    function handleMemberClick(memberName) {
        if (typeof window.__setMemberFilter === 'function') {
            window.__setMemberFilter(memberName);
        }
    }
    /** 轻量更新：只改 memberList 现有对象的 selected 字段，不动数组和 processing */
    function updateMemberSelection() {
        const app = window.__alpineApp;
        if (!app?.memberList) return;
        const filterRecipient = document.getElementById('filter-recipient')?.value || '';
        const filterRead = document.getElementById('filter-read')?.value || '';
        for (const m of app.memberList) {
            m.selected = !!(m.name && filterRecipient === m.name && filterRead === 'unread');
            m.showUnreadTag = m.selected;
        }
    }

    window.handleSidebarMemberClick = handleMemberClick;
    window.__clearMemberSelection = updateMemberSelection;

    // ==================== 状态更新 ====================

    function updateConnectionStatus(mode) {
        const app = window.__alpineApp;
        if (app) {
            app.sseStatus = mode === 'sse' ? 'connected' : mode === 'poll' ? 'reconnecting' : 'disconnected';
        }
        const text = dom.sseMode;
        if (text) {
            if (mode === 'sse') { text.textContent = I18N.t('status_connected'); }
            else if (mode === 'poll') { text.textContent = I18N.t('status_polling'); }
            else { text.textContent = I18N.t('status_offline'); }
        }
    }

    function updateGatewayStatus(online) {
        const app = window.__alpineApp;
        if (app) app.gatewayStatus = online ? 'connected' : 'disconnected';
    }

    function updateMsgCount() {
        const total = paginationState.totalMessages;
        if (dom.msgCount) {
            dom.msgCount.textContent = total > 0 ? I18N.tp('msg_count', total) : I18N.t('msg_no_messages');
        }
    }

    function addToTotal(n) {
        if (!n) return;
        paginationState.totalMessages = Math.max(0, (paginationState.totalMessages || 0) + n);
        updateMsgCount();
    }

    function updateFirstMessage(firstTimestamp) {
        if (!dom.lastUpdate) return;
        if (firstTimestamp === null || firstTimestamp === undefined) {
            dom.lastUpdate.textContent = I18N.t('msg_no_messages');
            return;
        }
        const locale = I18N.getLocale() === 'en' ? 'en-US' : 'zh-CN';
        const d = firstTimestamp ? new Date(firstTimestamp) : null;
        const timeStr = (d && !isNaN(d.getTime()))
            ? d.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : new Date().toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        dom.lastUpdate.textContent = I18N.tp('msg_first_update', timeStr);
    }

    function scrollToBottom() {
        if (!dom.messageList) return;
        dom.messageList.scrollTop = dom.messageList.scrollHeight;
        isAtBottom = true;
    }

    function clearMessageList() {
        dom.msgInner.innerHTML = '';
    }

    function resetPagination() {
        _paginationGen++;
        paginationState = {
            totalMessages: 0,
            loadedCount: 0,
            pageSize: 50,
            oldestLoadedId: null,
            isLoadingMore: true,
            hasMore: false
        };
    }

    return {
        escapeHtml,
        cacheDOMElements,
        clearMessageList,
        resetPagination,
        renderMessages,
        renderMembers,
        bindMessageCardEvents,
        updateConnectionStatus,
        updateGatewayStatus,
        updateFirstMessage,
        updateMsgCount,
        addToTotal,
        setTotalCount,
        getPaginationGen,
        toggleReadStatus,
        batchUpdateCardReadStatus,
        notifyNewMessages,
        scrollToBottom,
        get isAtBottom() { return isAtBottom; },
        initScrollState,
        setLoadMoreCallback: (cb) => { onLoadMoreCallback = cb; },
        setToggleReadCallback: (cb) => { onToggleReadCallback = cb; },
        getPaginationState: () => paginationState,
        getMemberFilterState: () => {
            const r = document.getElementById('filter-recipient')?.value || '';
            const rs = document.getElementById('filter-read')?.value || '';
            return { member: r || null, readStatus: rs || null, isActive: !!(r && rs) };
        },
        clearMemberFilter: () => {
            const r = document.getElementById('filter-recipient'); if (r) r.value = '';
            const rs = document.getElementById('filter-read'); if (rs) rs.value = '';
        }
    };
})();
