(async function() {
    'use strict';
    const $A = window.App;  // 短别名
    $A.updateInfo = null;
    let _lastScrollTime = 0;

    let _currentSSEMode = 'sse';

    // ============ 共享数据层 ============
    // config/teams → window.App.config / window.App.teams

    // ★ 仪表盘 → DashboardModule / init 入口

    // ★ handleCardAction 保留

    // ★ 数据库损坏弹窗(复用,供 init 和 SSE/轮询 调用)
    let _corruptModalShown = false;
    let _repairedModalShown = false;
    async function checkDatabaseCorruption() {
        if (_corruptModalShown || (window.__modal && window.__modal.open)) return;
        try {
            const dbResp = await AppApi.getDatabaseStatus();
            const dbStatus = await dbResp.json();
            if (!dbStatus.corrupted) return;
            _corruptModalShown = true;  // 防重复弹窗

            // 备份也损坏 → 仅告警,不给恢复按钮
            const backupBad = dbStatus.backupCorrupt;
            const body =
                '<p style="margin-bottom:16px;color:var(--accent-red)">' +
                I18N.t(backupBad ? 'db_corrupted_backup_bad' : 'db_corrupted_body') +
                '</p>' +
                (backupBad ? '' :
                '<p style="margin-bottom:12px;font-size:12px;color:var(--text-secondary)">' +
                I18N.t('db_restore_warn') + '</p>') +
                '<div style="display:flex;gap:8px;justify-content:flex-end">' +
                '<button class="btn" id="btn-db-corrupt-cancel">' + I18N.t('db_restore_cancel') + '</button>' +
                (backupBad ? '' :
                '<button class="btn btn-primary" id="btn-restore-db">' + I18N.t('db_restore_confirm') + '</button>') +
                '</div>';
            showModal(I18N.t('db_corrupted_title'), body, '');

            const cancelBtn = document.getElementById('btn-db-corrupt-cancel');
            if (cancelBtn) cancelBtn.onclick = () => { window.__modal.close(); /* 仅关弹窗,横幅保留 */ };

            const restoreBtn = document.getElementById('btn-restore-db');
            if (restoreBtn) restoreBtn.onclick = async function() {
                this.disabled = true;
                this.textContent = I18N.t('db_restore_restoring');
                try {
                    const r = await AppApi.postRestoreDatabase();
                    const result = await r.json();
                    if (r.ok && result.success) {
                        alert(I18N.t('db_restore_success'));
                        _corruptModalShown = false;
                        location.reload();
                    } else {
                        alert(I18N.t('db_restore_fail') + ': ' + I18N.err(result, ''));
                        this.textContent = I18N.t('db_restore_confirm');
                    }
                } catch(e) {
                    alert(I18N.t('db_restore_fail') + ': ' + e.message);
                    this.textContent = I18N.t('db_restore_confirm');
                }
                this.disabled = false;
            };
        } catch {}
    }

    // ★ 主初始化函数（恢复 init 声明：07-17 改动把 init 改名成 checkDatabaseCorruption 后，漏删了 init 原来的结束括号，导致 538 行 } 提前关掉最外层 IIFE）
    async function init() {
        async function initEarly() {
            // ★ 初始化时检查数据库状态
            await checkDatabaseCorruption();
            ModelModule.init();
    
            // ★ 加载仪表盘全部数据（config + projects）
            await DashboardModule.loadData();
    
            // ★ 根据团队/项目状态决定默认侧边栏 Tab
            const isEmpty = $A.config?.startupStatus === 'empty' || (!$A.config?.projectRoot);
            const teams = $A.teams || [];
            const hasProjects = teams.some(t => (t.projects || []).length > 0);
            const defaultTab = isEmpty ? 'ops'
                : teams.length === 0 ? 'team'
                : !hasProjects ? 'ops'
                : 'project';
            if (isEmpty || !localStorage.getItem('sidebarActiveTab')) {
                const app = window.__alpineApp;
                if (app) app.sidebarTab = defaultTab;
                SidebarModule.switchTab(defaultTab);
            }
    
            // ★ 服务端语言优先：coordclaw.json language → 覆盖首屏默认（一致时跳过，避免冗余重绘/闪屏）
            const serverLang = $A.config?.language === 'en' ? 'en' : 'zh';
            if (serverLang !== I18N.getLocale()) {
                I18N.setLocale(serverLang);
            }
            DashboardModule.renderCards();
            SkillsModule.renderCard();
            // 初始加载成员状态（SSE 首次可能需要几秒）
            await MessagesModule.fetchMemberStatus();
        }

        function initSkillCard() {
            // ★ 技能卡片开关事件委托
            const toolsList = document.getElementById('tools-list');
            if (toolsList) {
                toolsList.addEventListener('click', async (e) => {
                    // 1. 开关按钮
                    const btn = e.target.closest('[data-action="toggle-skill"]');
                    if (btn) {
                        const name = btn.dataset.skillName;
                        btn.disabled = true;
                        try {
                            const resp = await AppApi.postSkillToggle(name);
                            const result = await resp.json();
                            if (result.enabled !== undefined) {
                                btn.classList.toggle('active', result.enabled);
                                btn.textContent = result.enabled ? I18N.t('skill_on') : I18N.t('skill_off');
                            }
                        } catch { /* ignore */ }
                        btn.disabled = false;
                        return;
                    }
                    // 2. 技能名称文字 → 打开目录
                    const nameSpan = e.target.closest('.skill-name');
                    if (nameSpan) {
                        const item = nameSpan.closest('.skill-item');
                        if (item?.dataset.skill) {
                            AppApi.getOpenSkillDir(item.dataset.skill);
                        }
                    }
                    // 3. 其他区域（空白） → 无操作
                });
            }
    
            // ★ 安装技能按钮
            const btnInstallSkill = document.getElementById('btn-install-skill');
            if (btnInstallSkill) {
                btnInstallSkill.addEventListener('click', async () => {
                    try {
                        const browseResp = await AppApi.getBrowseFolder(I18N.t('browse_skill_title'));
                        const browseData = await browseResp.json();
                        if (!browseData.path) return;
                        const installResp = await AppApi.postInstallSkill(browseData.path);
                        const result = await installResp.json();
                        if (result.success) {
                            SkillsModule.renderCardWithData(result.skills);
                        } else {
                            alert(I18N.err(result, '安装失败'));
                        }
                    } catch (e) {
                        alert(I18N.t('alert_open_fail'));
                    }
                });
            }

            const btnManagePlatforms = document.getElementById('btn-manage-platforms');
            if (btnManagePlatforms) {
                btnManagePlatforms.addEventListener('click', () => {
                    window.location.href = '/install.html';
                });
            }
        }

        function initTeamsImport() {
            // ★ 导入团队包按钮（复用系统文件选择框选 .tpkg，与安装技能同构）
            const btnImportTeam = document.getElementById('btn-import-team');
            if (btnImportTeam) {
                btnImportTeam.addEventListener('click', async () => {
                    try {
                        const browseResp = await AppApi.getBrowseFile('选择团队包 (.tpkg)');
                        const browseData = await browseResp.json();
                        if (!browseData.path) return;
                        const importResp = await AppApi.postImportTeamTpkg(browseData.path);
                        const result = await importResp.json();
                        if (result.success) {
                            alert('团队导入成功：' + (result.teamId || ''));
                            if (DashboardModule && DashboardModule.loadData) {
                                DashboardModule.loadData().then(() => DashboardModule.renderCards && DashboardModule.renderCards());
                            }
                        } else {
                            alert(I18N.err(result, '导入失败'));
                        }
                    } catch (e) {
                        alert(I18N.t('alert_open_fail') + (e && e.message ? '：' + e.message : ''));
                    }
                });
            }
        }

        function initProjectCards() {
            // ★ 项目卡片中的按钮（事件委托）
            const projectCardList = document.getElementById('project-card-list');
            if (projectCardList) {
                projectCardList.addEventListener('click', (e) => {
                    // 团队展开/折叠
                    const toggleIcon = e.target.closest('.team-toggle-icon');
                    if (toggleIcon) {
                        const group = toggleIcon.closest('.card-list-group');
                        const teamIdx = group?.dataset?.teamToggle;
                        if (teamIdx !== undefined) {
                            const projects = projectCardList.querySelector(`.card-team-projects[data-team="${teamIdx}"]`);
                            if (projects) {
                                const isCollapsed = projects.style.display === 'none';
                                projects.style.display = isCollapsed ? '' : 'none';
                                toggleIcon.textContent = isCollapsed ? '▼' : '▶';
                            }
                        }
                        return;
                    }
    
                    // 新建项目
                    if (e.target.closest('.card-list-new-row')) {
                        ProjectsModule.handleNewProjectClick();
                        return;
                    }
    
                    // 切换项目
                    const switchBtn = e.target.closest('.mini-switch-btn');
                    if (switchBtn) {
                        e.stopPropagation();
                        const item = switchBtn.closest('.card-list-item');
                        const projectId = item?.dataset?.switchProject;
                        const listCard = switchBtn.closest('.list-item-card');
                        const teamId = listCard?.dataset?.teamId;
                        if (projectId) ProjectsModule.confirmSwitchProject(projectId, teamId);
                        return;
                    }
    
                    // 内嵌操作按钮
                    const actionBtn = e.target.closest('.proj-action-icon');
                    if (actionBtn) {
                        e.stopPropagation();
                        const action = actionBtn.dataset.action;
                        const row = actionBtn.closest('.list-item-card');
                        const projId = row?.dataset?.projId;
                        const projName = row?.dataset?.projName;
                        const projRoot = row?.dataset?.projRoot;
                        const teamId = row?.dataset?.teamId;
                        if (action && projId) {
                            ProjectsModule.handleInlineProjectAction(action, projId, projName, projRoot, teamId);
                        }
                        return;
                    }
                });
            }
        }

        function initTeamCards() {
            // ★ 团队卡片中的按钮（事件委托）
            const teamList = document.getElementById('team-list');
            if (teamList) {
                teamList.addEventListener('click', (e) => {
                    // 新建团队
                    if (e.target.closest('.card-list-new-row')) {
                        ChatModule.openTeamCreateChat();
                        return;
                    }
                    // 内嵌操作
                    const actionBtn = e.target.closest('.proj-action-icon');
                    if (actionBtn) {
                        e.stopPropagation();
                        const action = actionBtn.dataset.action;
                        const row = actionBtn.closest('.list-item-card');
                        const teamId = row?.dataset?.teamId;
                        const teamName = row?.dataset?.teamName;
                        const templatePath = row?.dataset?.teamTemplate;
                        TeamsModule.handleInlineTeamAction(action, teamId, teamName, templatePath);
                        return;
                    }
                });
            }
        }

        function initSidebarCore() {
            UIRenderer.cacheDOMElements();
            UIRenderer.setLoadMoreCallback(MessagesModule.loadMore);
            // ★ 成员筛选已改由 window.__setMemberFilter 直接调用
    
            // 初始化侧边栏
            SidebarModule.init();
    
            // 卡片按钮事件委托
            const sidebarContent = document.getElementById('sidebar-content');
            if (sidebarContent) {
                sidebarContent.addEventListener('click', (e) => {
                    const btn = e.target.closest('.card-action-btn');
                    if (!btn) return;
                    const action = btn.dataset.action;
                    if (action) handleCardAction(action);
                });
            }
        }

        function initMessages() {
            // 主题和语言由 Alpine 管理（index.html x-data）
            I18N.applyDOM(); // 初始化语言
            document.getElementById('btn-mark-all').addEventListener('click', MessagesModule.handleMarkAll);
            document.getElementById('filter-keyword').addEventListener('input', MessagesModule.debounceKeyword);
            document.getElementById('filter-sender').addEventListener('change', MessagesModule.handleFilterChange);
            document.getElementById('filter-recipient').addEventListener('change', MessagesModule.handleFilterChange);
            document.getElementById('filter-read').addEventListener('change', MessagesModule.handleFilterChange);
            document.getElementById('btn-send-message').addEventListener('click', MessagesModule.handleSendMessage);
            // ★ 主消息框：回车发送、修饰键(Ctrl/Shift/Meta)+回车手动插入换行（中文输入法组合中放行选词）
            const msgInputEl = document.getElementById('message-input');
            if (msgInputEl) {
                msgInputEl.onkeydown = (e) => {
                    if (e.isComposing || e.keyCode === 229) return;            // 中文输入法：放行选词
                    if (e.key !== 'Enter') return;                              // 非回车：放行默认行为
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {                 // 修饰键+回车 = 手动插入换行
                        e.preventDefault();                                     // 先阻止原生换行（避免 Shift 双换行）
                        const s = msgInputEl.selectionStart, end = msgInputEl.selectionEnd, v = msgInputEl.value;
                        msgInputEl.value = v.slice(0, s) + '\n' + v.slice(end);  // 光标处插入换行
                        msgInputEl.selectionStart = msgInputEl.selectionEnd = s + 1; // 光标移到换行后
                        msgInputEl.dispatchEvent(new Event('input', { bubbles: true })); // 触发 auto-resize/草稿监听
                        return;
                    }
                    const sendBtnEl = document.getElementById('btn-send-message');
                    if (sendBtnEl && sendBtnEl.disabled) return;              // 发送中：不重复发送
                    if (!(msgInputEl.value || '').trim()) { e.preventDefault(); return; } // 空内容：不发送、不弹模态、吞掉空换行
                    e.preventDefault();
                    MessagesModule.handleSendMessage();
                };
            }
        }

        function initGlobalDelegation() {
            // ★ 注册团队按钮（事件委托，按钮在动态创建的 overlay 中）
            document.addEventListener('click', (e) => {
                const btn = e.target.closest('#btn-register-team');
                if (btn) {
                    btn.disabled = true;
                    btn.textContent = I18N.t('status_registering');
                    const teamId = btn.dataset.teamId;
                    AppApi.postRegisterTeam(teamId ? { teamId } : undefined)
                        .then(r => r.json())
                        .then(d => {
                            if (d.success) {
                                alert(I18N.t('alert_register_success'));
                                ChatModule.closeOverlay();
                                DashboardModule.loadData().then(() => DashboardModule.renderCards());
                            } else {
                                alert(I18N.t('alert_register_fail') + '：' + (d.error || d.message || I18N.t('modal_unknown_error')));
                                btn.disabled = false;
                                btn.textContent = ChatModule.CFG.registerBtn;
                            }
                        })
                        .catch(err => {
                            alert(I18N.t('alert_register_fail') + '：' + err.message);
                            btn.disabled = false;
                            btn.textContent = ChatModule.CFG.registerBtn;
                        });
            }
    
            // ★ 点击成员消息图标
            const msgIcon = e.target.closest('.member-msg-icon');
            if (msgIcon) {
                e.stopPropagation();
                const memberName = msgIcon.dataset.member;
                const members = $A.config?.members || [];
                const member = members.find(m => m.name === memberName);
                const sessionKey = member?.sessionKey;
                if (!sessionKey) {
                    alert(I18N.tp('member_no_session', memberName));
                    return;
                }
                ChatModule.openMemberChat(memberName, sessionKey, member.agent_id);
            }
    
            // ★ 点击成员技能图标
            const skillIcon = e.target.closest('.member-skill-icon');
            if (skillIcon) {
                e.stopPropagation();
                const memberName = skillIcon.dataset.member;
                const agentId = skillIcon.dataset.agentId;
                SkillsModule.openMemberSkill(memberName, agentId);
            }
            });
        }

        function initProjectSwitch() {
            // ★ 项目切换按钮
            const btnSwitch = document.getElementById('btn-switch-project');
            if (btnSwitch) {
                btnSwitch.addEventListener('click', ProjectsModule.handleSwitchProjectClick);
            }
        }

        function initCharCount() {
            // 字数统计
            const msgInput = document.getElementById('message-input');
            const charCount = document.getElementById('char-count');
            if (msgInput && charCount) {
                msgInput.addEventListener('input', () => {
                    charCount.textContent = msgInput.value.length;
                });
            }
        }

        function initReadCallbacks() {
            // 注册 toggle 回调（从 ui.js 的 renderMessage 内直接触发）
            UIRenderer.setToggleReadCallback(MessagesModule.handleToggleReadClick);
    
            // 初始化发送者/接收者下拉框（与侧栏成员同源）
            MessagesModule.populateDropdowns();
        }

        function initRealtime() {
            const sse = SSEClient.init();
    
            sse.on('connected', () => {
                _currentSSEMode = 'sse';
                UIRenderer.updateConnectionStatus('sse');

                // ★ 启动自愈：检查 openclaw.json 插件注册，被清理/关闭则自动修复并提示重启
                fetch('/api/self-heal-openclaw')
                    .then((r) => r.json())
                    .then((d) => {
                        if (d && d.repaired && !_repairedModalShown) {
                            _repairedModalShown = true;
                            const body =
                                '<p style="margin-bottom:12px">openclaw.json 中的 CoordClaw 插件注册被意外清理或关闭，已自动修复。</p>' +
                                '<p style="margin-bottom:12px;font-size:12px;color:var(--text-secondary)">插件需在 OpenClaw 重新加载后才生效，请按以下步骤操作：</p>' +
                                '<p style="margin-bottom:12px">① 重启 OpenClaw（或其变体）软件；<br>② 重启控制面板。</p>' +
                                '<div style="display:flex;gap:8px;justify-content:flex-end">' +
                                '<button class="btn btn-primary" id="btn-restart-panel">重启控制面板</button>' +
                                '</div>';
                            showModal('插件注册已自动修复', body, '');
                            const btn = document.getElementById('btn-restart-panel');
                            if (btn) btn.onclick = () => location.reload();
                        }
                    })
                    .catch(() => {});
            });
    
            sse.on('modechange', (mode) => {
                _currentSSEMode = mode;
                UIRenderer.updateConnectionStatus(mode);
            });
    
            sse.on('reconnecting', (count) => {
                _currentSSEMode = 'reconnecting';
                UIRenderer.updateConnectionStatus('reconnecting');
            });
    
            let _lastFp = '';
            sse.on('messages_sync', (messages) => {
                // 有筛选条件时跳过 SSE 推送，改筛选时会 fetch
                const { keyword, sender, recipient, readStatus } = MessagesModule.getActiveFilters();
                if (keyword || sender || recipient || readStatus) return;
    
                const fp = messages.map(m => `${m.msg_id}:${m.is_unread ? 1 : 0}:${m.view_count || 0}`).join(',');
                if (fp === _lastFp) return;
                _lastFp = fp;
                // ★ 新增消息数（SSE 带来的真正新消息，排除状态更新）
                const existingIds = new Set($A.messageCache.map(m => m.msg_id || String(m.id)).filter(Boolean));
                const newCount = messages.filter(m => { const k = m.msg_id || String(m.id); return k && !existingIds.has(k); }).length;
                // ★ 按 msg_id 合并：同 ID 覆盖（状态更新），新 ID 追加
                const merged = new Map();
                $A.messageCache.forEach(m => {
                    const key = m.msg_id || (m.id != null ? String(m.id) : null);
                    if (key) merged.set(key, m);
                });
                messages.forEach(m => {
                    const key = m.msg_id || (m.id != null ? String(m.id) : null);
                    if (key) merged.set(key, m); // 覆盖或新增
                });
                let cache = [...merged.values()];
                if (cache.length > 200) cache = cache.slice(-200);
                $A.messageCache = cache;
                MessagesModule.refreshView();
                // ★ 首条消息时间兜底：仅"无筛选 + 仍未知"时，用缓存最早一条补设（H-D 窄窗，随后 fetch 用真 MIN 纠正）
                if ($A.firstMessageAt == null) {
                  let minTs = null;
                  for (const m of $A.messageCache) {
                    const t = m.created_at;
                    if (t && (minTs === null || t < minTs)) minTs = t;
                  }
                  if (minTs) {
                    $A.firstMessageAt = minTs;
                    UIRenderer.updateFirstMessage(minTs);
                  }
                }
                // ★ 仅当当前视图无筛选时, SSE 增量才累加总数; 有筛选时过滤总数只由显式过滤 reload 重建, 避免盲加致多计
                const _filtered = !!(document.getElementById('filter-keyword')?.value?.trim() || document.getElementById('filter-sender')?.value || document.getElementById('filter-recipient')?.value || document.getElementById('filter-read')?.value);
                if (newCount > 0 && !_filtered) UIRenderer.addToTotal(newCount);
                MessagesModule.loadMembers();
            });
    
            sse.on('heartbeat', () => {});
    
            // ★ 刷新守卫：防止并发事件叠加触发
            let _refreshing = false;
            async function guardedRefresh(full) {
                if (_refreshing) { console.log('[App] ⏭️ 跳过重复刷新'); return; }
                _refreshing = true;
                // 暂停轮询，避免并发拉取消息
                const wasPolling = sse.getMode() === 'poll';
                sse.pausePoll?.();
                try {
                    if (full) {
                        console.log('[App] 🔔 全量刷新（配置变更）...');
                        await DashboardModule.loadConfig();
                        if (!$A.config) return;
                        // 消息列表不动：新消息走 SSE/轮询，数据库重连走 projectswitched
                        // 注册团队按钮始终可见；禁用/启用由 chat.js 的 team_create_progress 推送决定（避免 configchanged 刷新把它误禁用）
                        const regBtn = document.getElementById('btn-register-team');
                        if (regBtn) { regBtn.style.display = ''; }
                        await MessagesModule.loadMembers();
                        DashboardModule.refreshUI(_currentSSEMode);
                        MessagesModule.populateDropdowns();
                        DashboardModule.loadTeams();
                    } else {
                        console.log('[App] 🔔 轻量刷新（team.json 变更）...');
                        await DashboardModule.loadConfig();
                        if (!$A.config) return;
                        await MessagesModule.loadMembers();
                        DashboardModule.refreshUI(_currentSSEMode);
                        MessagesModule.populateDropdowns();
                    }
                } finally {
                    _refreshing = false;
                    if (wasPolling) sse.resumePoll?.();
                }
            }
    
            sse.on('configchanged', () => guardedRefresh(true));
            sse.on('teamchanged', () => guardedRefresh(false));
    
            // ★ 数据库损坏实时推送 → 弹窗
            sse.on('database_corrupted', () => {
                _corruptModalShown = false;
                checkDatabaseCorruption();
            });
    
            // ★ 10 秒轮询兜底(SSE 不可用时仍能检测损坏)
            setInterval(() => { checkDatabaseCorruption(); }, 10_000);
    
            // ★ 项目切换后重新加载全部数据（DB 重连 → 消息全量刷新）
            sse.on('projectswitched', async () => {
                console.log('[App] 🔄 项目已切换，重新加载数据...');
                await DashboardModule.loadConfig();
                MessagesModule.fullReload();
                await MessagesModule.loadMembers();
                DashboardModule.refreshUI(_currentSSEMode);
                MessagesModule.populateDropdowns();
                DashboardModule.loadTeams();
                ModelModule.refreshAll();
            });
    
            // ★ 团队创建进度推送
            sse.on('team_create_progress', (data) => {
                ChatModule.updateProgress(data);
            });
    
            // ★ 模型配置变更（SSE）
            sse.on('models_changed', () => { ModelModule.refreshAll(); });
    
            // ★ Token 用量实时推送（SSE）→ 更新项目信息区
            sse.on('token_stats_updated', (data) => {
                if (data && typeof data.estTotalTokens === 'number') {
                    const a = window.__alpineApp;
                    if (a) a.tokenUsage = data.estTotalTokens;
                }
            });
    
            // ★ 成员工作状态推送（SSE）
            sse.on('member_status', (data) => {
                $A.latestStatus = data?.snapshots || [];
                MessagesModule.applyMemberStatus();
            });
            sse.on('gateway_online', (data) => {
                UIRenderer.updateGatewayStatus(true);
                // ★ 刷新前端缓存的 gatewayUrl（端口可能已变）
                if (data?.gatewayUrl && $A.config) {
                    $A.config.gatewayUrl = data.gatewayUrl;
                    DashboardModule.syncToAlpine();
                }
                // ★ 刷新模型下拉和技能清单
                ModelModule.refreshAll();
                SkillsModule.renderCard();
            });
            sse.on('gateway_offline', () => UIRenderer.updateGatewayStatus(false));
    
            sse.on('error', (err) => {
                console.warn('[SSE] 连接问题:', err?.message || err);
            });
        }

        async function initLoad() {
            // ★ 初始加载
            if (!$A.config || !$A.config.projectRoot) {
                MessagesModule.showEmptyProject();
            } else {
                await Promise.all([MessagesModule.load(), MessagesModule.loadMembers()]);
            }
            // ★ 初始刷新状态栏 + 异步拉更新信息
            DashboardModule.refreshUI(_currentSSEMode);
            DashboardModule.fetchUpdate().then(() => DashboardModule.refreshUI(_currentSSEMode));
    
            // 定时刷新成员列表（30s）
            setInterval(() => MessagesModule.loadMembers(), 30000);
        }

        function initSidebarDelegationB() {
            // 侧边栏卡片事件委托（统一入口，覆盖所有卡片内的按钮/链接）
            const sidebarEl = document.getElementById('sidebar-content');
            if (sidebarEl) {
                sidebarEl.addEventListener('click', async (e) => {
                    // ★ 项目信息 toggles 已由 Alpine @click 处理，此处不再代理
                    if (e.target.closest('[data-action="open-project-dir"]')) {
                        ProjectsModule.openProjectDir();
                        return;
                    }
                    if (e.target.closest('[data-action="open-org-chart"]')) {
                        openOrgChart();
                        return;
                    }
                    if (e.target.closest('[data-action="open-token-stats"]')) {
                        openTokenStats();
                        return;
                    }
                    // ★ 成员行点击（筛选该成员消息；排除 msg/skill 图标）
                    if (!e.target.closest('.member-msg-icon, .member-skill-icon')) {
                        const memberRow = e.target.closest('[data-member]');
                        if (memberRow && memberRow.closest('#member-list')) {
                            if (window.handleSidebarMemberClick) {
                                window.handleSidebarMemberClick(memberRow.dataset.member);
                            }
                            return;
                        }
                    }
                });
            }
        }

        async function initAutoPlugins() {
            // ★ 异步注入 auto/ 插件（遍历 plugins.json）
            try {
                const resp = await fetch('/auto/plugins.json');
                if (!resp.ok) return;
                const data = await resp.json();
                if (data.status === 'failed') return;
                for (const [name, path] of Object.entries(data)) {
                    try {
                        const cs = document.createElement('script');
                        cs.src = '/' + path;
                        cs.async = true;
                        cs.onerror = function() {};
                        document.head.appendChild(cs);
                    } catch {}
                }
            } catch {}
        }

        await initEarly();
        initSkillCard();
        initTeamsImport();
        initProjectCards();
        initTeamCards();
        initSidebarCore();
        initMessages();
        initGlobalDelegation();
        initProjectSwitch();
        initCharCount();
        initReadCallbacks();
        initRealtime();
        await initLoad();
        initSidebarDelegationB();
        await initAutoPlugins();
    }

    /**

    // ★ 消息/筛选/成员 → MessagesModule


    /**
     * 显示模态弹窗 — 委托给 Alpine modalState 组件
     * @param {string} title - 标题
     * @param {string} body - 内容（支持 HTML）
     */
    function showModal(title, body, footer) {
        if (window.__modal) window.__modal.show(title, body, footer);
    }
    window.showModal = showModal;

    function closeModal() {
        if (window.__modal) window.__modal.close();
    }
    window.closeModal = closeModal;

    function showError(message) {
        // 发送类错误用弹窗，其他用 toast
        showModal(I18N.t('modal_op_tip'), `<p style="color: var(--accent-red);">${message}</p>`);
    }

    /**
     * 团队重置：确认 → 可选填写原因 → 调用 API
     */
    async function handleWorkspaceResetClick() {
        const confirmed = confirm(I18N.t('reset_confirm_msg'));
        if (!confirmed) return;

        const reason = prompt(I18N.t('reset_reason_prompt'), '') || '';
        await handleWorkspaceReset(reason);
    }

    /**
     * 调用团队重置 API
     */
    async function handleWorkspaceReset(reason) {
        try {
            const body = reason ? { reason } : {};
            const resp = await AppApi.postWorkspaceReset(body);
            let data;
            try {
                data = await resp.json();
            } catch {
                data = { error: `HTTP ${resp.status}` };
            }

            if (resp.ok) {
                showModal(
                    I18N.t('reset_success'),
                    '<p style="color: var(--accent-green);">' +
                    I18N.t('reset_success_detail') + '</p>'
                );
            } else {
                showModal(
                    I18N.t('reset_fail'),
                    `<p style="color: var(--accent-red);">${data.error || I18N.t('modal_unknown_error')}</p>`
                );
            }
        } catch (e) {
            showModal(
                I18N.t('reset_fail'),
                `<p style="color: var(--accent-red);">${e.message}</p>`
            );
        }
    }

    // ★ handleToggleHuman/MsgRobot/AutoCoord 已抽取到 ToggleModule

    // ★ handleCardAction 分发（侧边栏卡片按钮）
    function handleCardAction(action) {
        switch (action) {
            case 'workspace-reset':
                handleWorkspaceResetClick();
                break;
            case 'new-team':
                handleWorkspaceResetClick();
                break;
            default:
                break;
        }
    }

    // ★ 组织架构图（iframe 覆盖层）
    async function openOrgChart() {
        const isLight = document.documentElement.classList.contains('light-theme');
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(overlay);
        const closeFn = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFn(); });
        overlay.innerHTML = '<div style="position:relative;width:min(840px,92vw);max-height:84vh;background:var(--bg-primary,#1a1a2e);border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.3)" id="org-box">'
            + '<button style="position:absolute;top:8px;right:14px;z-index:10;background:none;border:none;color:var(--accent-red);font-size:20px;cursor:pointer" onclick="this.closest(\'#org-box\').parentNode.remove()">✕</button>'
            + '<iframe id="org-iframe" src="/api/org-chart?lang=' + I18N.getLocale() + (isLight ? '&theme=light' : '') + '" style="width:100%;height:80vh;max-height:84vh;border:none"></iframe>'
            + '</div>';
        window.__openOrgChart = openOrgChart;
    }
    window.openOrgChart = function() { openOrgChart(); };

    // ★ Token 明细（iframe 覆盖层，复用 openOrgChart 的模式）
    function openTokenStats() {
        const isLight = document.documentElement.classList.contains('light-theme');
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.innerHTML = '<div style="position:relative;width:min(840px,92vw);max-height:84vh;background:var(--bg-primary,#1a1a2e);border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.3)" id="tk-box">'
            + '<button style="position:absolute;top:8px;right:14px;z-index:10;background:none;border:none;color:var(--accent-red);font-size:20px;cursor:pointer" onclick="this.closest(\'#tk-box\').parentNode.remove()">✕</button>'
            + '<iframe id="tk-iframe" src="/api/token-stats-detail?lang=' + I18N.getLocale() + (isLight ? '&theme=light' : '') + '" style="width:100%;height:80vh;max-height:84vh;border:none"></iframe>'
            + '</div>';
        window.__openTokenStats = openTokenStats;
    }
    window.openTokenStats = function() { openTokenStats(); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
