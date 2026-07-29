/**
 * 主应用模块 - CoordClaw Web
 * 初始化SSE、加载数据、绑定事件
 */

// ====== Alpine.js 全局状态 ======

/** Modal 弹窗组件 — 替代 vanilla JS showModal/closeModal */
function modalState() {
  const DEFAULT_FOOTER = '<button class="btn btn-primary" @click="close()" data-i18n="modal_confirm">确定</button>';
  return {
    open: false,
    title: '',
    body: '',
    init() { window.__modal = this; },
    show(t, b, f) {
      this.title = t;
      this.body = '';  // ★ 强制清空，确保同内容再次打开时 x-html 重渲染
      if (f !== undefined) {
        if (this.$refs.footer) this.$refs.footer.innerHTML = f;
      } else {
        if (this.$refs.footer) this.$refs.footer.innerHTML = DEFAULT_FOOTER;
      }
      this.open = true;
      this.body = b;   // 设置新内容，触发 Alpine 变化检测
    },
    close() { this.open = false; },
  };
}

// 由 index.html 的 x-data="appState()" 调用
function appState() {
  return {
    // 主题
    theme: localStorage.getItem('theme') || 'dark',
    init() {
      // 初始化主题
      if (this.theme === 'light') document.documentElement.classList.add('light-theme');
    },
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
      document.documentElement.classList.toggle('light-theme', this.theme === 'light');
    },
    getThemeIcon() { return this.theme === 'dark' ? '🌓' : '☀️'; },

    // 导出下拉
    exportDropdown: false,
    toggleExportDropdown() { this.exportDropdown = !this.exportDropdown; },
    exportMessages(format) {
      this.exportDropdown = false;
      if (format === 'html') MessagesModule.handleExportHTML(I18N.getLocale());
      else MessagesModule.handleExportCSV();
    },

    // 团队内联重命名
    startTeamRename(teamId, teamName) {
      this.editingTeamId = teamId;
      this.editingTeamValue = teamName || '';
    },
    cancelTeamRename() {
      // H1: Esc 取消时 blur 不应再提交
      this.cancelling = true;
      this.editingTeamId = '';
      this.editingTeamValue = '';
      setTimeout(() => { this.cancelling = false; }, 0);
    },
    commitTeamRename(teamId) {
      // H2: 防 Enter 与 blur 双提交
      if (this.renamingInFlight) return;
      // H1: Esc 取消期间 blur 不提交
      if (this.cancelling) { this.cancelling = false; return; }
      if (this.editingTeamId !== teamId) return;

      const newValue = (this.editingTeamValue ?? '').toString();
      // H4: 前端 no-op 用原始值 === 当前名（不 trim），让"去掉尾空格"能下发；后端 trim 相等则不写盘
      const cur = this.teamList.find((t) => t.id === teamId);
      const currentName = cur ? cur.name : '';
      if (newValue === currentName) {
        this.editingTeamId = '';
        this.editingTeamValue = '';
        return;
      }

      this.renamingInFlight = true;
      const prevId = teamId;
      AppApi.postRenameTeam({ teamId, newName: newValue })
        .then(async (resp) => {
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data.success !== false) {
            const t = this.teamList.find((x) => x.id === prevId);
            if (t) t.name = data.teamName != null ? data.teamName : newValue.trim();
            this.editingTeamId = '';
            this.editingTeamValue = '';
            // H7: 同步 team.json 后刷新顶部"团队名称"（仅刷新仪表盘/顶部名，不重拉消息列表）
            if (window._refreshDashboard) await window._refreshDashboard();
          } else {
            // H5: 失败保留编辑态，弹对应 i18n 错误（不清 editingTeamId，用户就地修正）
            alert(renameTeamErrorText(data.code, data.error));
          }
        })
        .catch((e) => {
          alert(I18N.t('rename_fail') + '：' + (e && e.message ? e.message : e));
        })
        .finally(() => {
          this.renamingInFlight = false;
        });
    },

    // 项目内联重命名（与团队改名对称：H1/H2/H4/H5 防护；成功仅刷新顶部名+卡片列表，不重拉消息）
    startProjectRename(teamId, projectId, projectName) {
      this.editingProjectId = projectId;
      this.editingProjectValue = projectName || '';
    },
    cancelProjectRename() {
      // H1: Esc 取消时 blur 不应再提交
      this.cancelling = true;
      this.editingProjectId = '';
      this.editingProjectValue = '';
      setTimeout(() => { this.cancelling = false; }, 0);
    },
    commitProjectRename(teamId, projectId) {
      // H2: 防 Enter 与 blur 双提交
      if (this.renamingInFlight) return;
      // H1: Esc 取消期间 blur 不提交
      if (this.cancelling) { this.cancelling = false; return; }
      if (this.editingProjectId !== projectId) return;

      const newValue = (this.editingProjectValue ?? '').toString();
      // H4: 前端 no-op 用原始值 === 当前名（不 trim），让"去掉尾空格"能下发；后端 trim 相等则不写盘
      const team = this.projectCardList.find((t) => t.id === teamId);
      const cur = team ? (team.projects || []).find((p) => p.id === projectId) : null;
      const currentName = cur ? cur.name : '';
      if (newValue === currentName) {
        this.editingProjectId = '';
        this.editingProjectValue = '';
        return;
      }

      this.renamingInFlight = true;
      const prevTeamId = teamId, prevProjId = projectId;
      AppApi.postRenameProject({ teamId, projectId, newName: newValue })
        .then(async (resp) => {
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data.success !== false) {
            // 即时反馈（与团队改名一致）
            const tm = this.projectCardList.find((t) => t.id === prevTeamId);
            const p = tm ? (tm.projects || []).find((x) => x.id === prevProjId) : null;
            if (p) p.name = data.projectName != null ? data.projectName : newValue.trim();
            this.editingProjectId = '';
            this.editingProjectValue = '';
            // 刷新顶部"项目名称" + 卡片列表（不重拉消息列表）
            if (window._refreshDashboard) await window._refreshDashboard();
          } else {
            // H5: 失败保留编辑态，弹对应 i18n 错误（不清 editingProjectId，用户就地修正）
            alert(renameTeamErrorText(data.code, data.error));
          }
        })
        .catch((e) => {
          alert(I18N.t('rename_fail') + '：' + (e && e.message ? e.message : e));
        })
        .finally(() => {
          this.renamingInFlight = false;
        });
    },

    // 语言
    locale: I18N.getLocale() || 'zh',
    langList: I18N.getLangList(),
    langDropdown: false,
    toggleLangDropdown() {
      this.langDropdown = !this.langDropdown;
    },
    setLanguage(code) {
      I18N.setLocale(code);
      this.locale = code;
      this.langDropdown = false;
      // ★ 写入 coordclaw.json
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: code })
      }).catch(() => {});
      refreshDynamicUI();
    },
    getLocaleIcon() {
      return '🌐';
    },

    // ★ Token 用量格式化：中文按数量级用 万/亿，英文按数量级用 K/M/B
    formatTokens(v) {
      const n = Number(v) || 0;
      const u = (val, mag, suffix) => {
        const x = val / mag;
        return (x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')) + suffix;
      };
      if (this.locale === 'en') {
        if (n >= 1e9) return u(n, 1e9, 'B');
        if (n >= 1e6) return u(n, 1e6, 'M');
        if (n >= 1e3) return u(n, 1e3, 'K');
        return String(n);
      }
      // 中文：万 / 亿
      if (n >= 1e8) return u(n, 1e8, '亿');
      if (n >= 1e4) return u(n, 1e4, '万');
      return String(n);
    },
    // ★ Alpine 中调用 I18N 的便捷方法
    i18n(key) {
      void this.locale; // 建立 Alpine 响应式依赖
      return I18N.t(key);
    },

    // 侧边栏 Tab 切换
    sidebarTab: localStorage.getItem('sidebarActiveTab') || 'project',
    switchTab(tab) {
      this.sidebarTab = tab;
      localStorage.setItem('sidebarActiveTab', tab);
    },

    // 侧边栏折叠
    sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
    toggleCollapse() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      localStorage.setItem('sidebarCollapsed', this.sidebarCollapsed);
    },

    // 状态指示
    sseStatus: 'disconnected',
    gatewayStatus: 'disconnected',

    // 滚动状态（Phase 4）
    isScrolledUp: false,
    hasNewMessages: false,

    // 筛选下拉选项（Phase 4）
    filterMemberNames: [],

    // 成员列表（Phase 5 — Alpine 渲染）
    memberList: [],

    // 输入区下拉选项（Phase 6）
    inputMemberNames: [],
    inputDropdownItems: [],

    // 项目信息（Phase 7 — Alpine 渲染）
    projectName: '',
    teamName: '',
    memberCount: 0,
    tokenUsage: 0,
    projectRoot: '',
    humanMembers: [],
    autoCoordination: false,
    msgRobot: false,

    // 团队/项目卡片列表（Phase 7）
    teamList: [],
    projectCardList: [],

    // 团队内联重命名（公用 validate.ts 校验；后端 renameTeam 为权威；前端仅做 no-op 守卫）
    editingTeamId: '',
    editingTeamValue: '',
    renamingInFlight: false,
    cancelling: false,

    // 项目内联重命名（与团队改名共用 validate.ts / renameTeamErrorText / renamingInFlight / cancelling）
    editingProjectId: '',
    editingProjectValue: '',

    // 共享数据层（Phase B1）
    config: null,
    teams: [],
    messages: [],
  };
}

// ====== 全局应用命名空间 ======
window.App = {
    config: null,
    teams: [],
    messageCache: [],
    memberFilter: { member: null, showUnreadOnly: false },
    latestStatus: [],
    inputMemberNames: [],
    inputDropdownItems: [],
    filterMemberNames: [],
};

// 团队重命名错误文案映射（按后端业务码 EMPTY/INVALID_CHAR/TOO_LONG/DUPLICATE/NOT_FOUND）
function renameTeamErrorText(code, detail) {
  const map = {
    EMPTY: I18N.t('rename_err_empty'),
    INVALID_CHAR: I18N.t('rename_err_char'),
    TOO_LONG: I18N.t('rename_err_long'),
    DUPLICATE: I18N.t('rename_err_dup'),
    NOT_FOUND: I18N.t('rename_err_notfound'),
  };
  return map[code] || (detail || I18N.t('rename_fail'));
}
