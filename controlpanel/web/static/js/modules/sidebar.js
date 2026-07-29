/**
 * 侧边栏模块 — 宽度/折叠/Tab/拖拽调整
 * 依赖：I18N（仅 toggleCollapse 需要更新按钮标题）
 */
const SidebarModule = (function() {
    'use strict';

    const RAIL_WIDTH = 40;
    const MIN_WIDTH = 160;
    const MAX_WIDTH = 360;
    const DEFAULT_WIDTH = 224;
    const KEY_WIDTH = 'sidebarWidth';
    const KEY_COLLAPSED = 'sidebarCollapsed';
    const KEY_ACTIVE_TAB = 'sidebarActiveTab';

    function init() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;

        const savedWidth = parseInt(localStorage.getItem(KEY_WIDTH), 10);
        if (savedWidth && savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) {
            sidebar.style.width = savedWidth + 'px';
        } else {
            sidebar.style.width = DEFAULT_WIDTH + 'px';
        }

        const collapsed = localStorage.getItem(KEY_COLLAPSED) === 'true';
        if (!collapsed) sidebar.classList.remove('collapsed');

        initResize();
    }

    function switchTab(tabId) {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;

        sidebar.querySelectorAll('.rail-tab[data-tab]').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabId);
        });
        sidebar.querySelectorAll('.sidebar-card').forEach(card => {
            card.classList.toggle('active', card.dataset.tab === tabId);
        });
        localStorage.setItem(KEY_ACTIVE_TAB, tabId);
    }

    function toggleCollapse() {
        const sidebar = document.getElementById('sidebar');
        const toggleBtn = document.getElementById('sidebar-toggle');
        if (!sidebar) return;

        const isCollapsed = sidebar.classList.toggle('collapsed');
        localStorage.setItem(KEY_COLLAPSED, isCollapsed);

        if (toggleBtn) {
            if (isCollapsed) {
                toggleBtn.setAttribute('data-i18n-title', 'sidebar_expand');
                toggleBtn.title = I18N.t('sidebar_expand');
            } else {
                toggleBtn.setAttribute('data-i18n-title', 'sidebar_collapse');
                toggleBtn.title = I18N.t('sidebar_collapse');
            }
        }
    }

    function initResize() {
        const sidebar = document.getElementById('sidebar');
        const handle = document.getElementById('sidebar-resize');
        if (!sidebar || !handle) return;

        let startX = 0;
        let startWidth = 0;
        let isResizing = false;

        handle.addEventListener('mousedown', (e) => {
            if (sidebar.classList.contains('collapsed')) return;
            e.preventDefault();
            startX = e.clientX;
            startWidth = sidebar.offsetWidth;
            isResizing = true;
            handle.classList.add('resizing');
            document.body.classList.add('sidebar-resizing');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const diff = e.clientX - startX;
            const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + diff));
            sidebar.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            handle.classList.remove('resizing');
            document.body.classList.remove('sidebar-resizing');
            const finalWidth = sidebar.offsetWidth;
            if (finalWidth >= MIN_WIDTH && finalWidth <= MAX_WIDTH) {
                localStorage.setItem(KEY_WIDTH, finalWidth);
            }
        });
    }

    return { init, switchTab, toggleCollapse };
})();
