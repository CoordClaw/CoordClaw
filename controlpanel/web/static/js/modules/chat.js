/**
 * 聊天模块 — 团队创建对话 / 成员聊天 / 流式渲染 / 进度面板
 * 依赖：window.App, I18N, UIRenderer, AppApi
 */
const ChatModule = (function() {
    'use strict';

    const $A = window.App;

    // ─── 配置 ─────────────────────────────────────

    const CFG = {
        sessionKey: 'agent:main:coordclawabcdefg',
        get title()           { return I18N.t('chat_title'); },
        get defaultInput()    { return I18N.t('chat_default_input'); },
        get systemMsg()       { return I18N.t('chat_system_msg'); },
        get sendBtn()         { return I18N.t('chat_send_btn'); },
        get registerBtn()     { return I18N.t('chat_register_btn'); },
        get progressTitle()   { return I18N.t('chat_progress_title'); },
        get progressWaiting() { return I18N.t('chat_progress_waiting'); },
        get thinking()        { return I18N.t('chat_thinking'); },
        get errorInterrupt()  { return I18N.t('chat_error_interrupt'); },
        get alertNoWebchat()  { return I18N.t('chat_no_webchat'); },
    };

    // ─── 内部状态 ─────────────────────────────────

    let _overlayEl = null;
    let _nextPrompt = '';
    const _sessionKey = CFG.sessionKey;

    // 历史轮询状态（模块级单例，跨 overlay 复用，靠 openChatOverlay/closeFn 复位避免泄漏）
    let _streaming = false;          // 本端出现过 stream 即为 true，且永不自动复位（出现过即永久停轮询）
    let _pollTimer = null;           // 递归 setTimeout 的句柄
    let _pollWebchatUrl = '';
    let _pollSessionKey = '';
    let _pollAiName = '';
    const POLL_INTERVAL = 5000;      // 周期轮询间隔(ms)

    // ─── Markdown 解析 ────────────────────────────

    function parseMD(text) {
        let html = text;
        html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');
        html = html.replace(/^---$/gm, '<hr>');
        html = html.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
            const lines = block.trim().split('\n');
            let t = '<table>';
            for (let i = 0; i < lines.length; i++) {
                const cells = lines[i].split('|').filter(c => c.trim());
                if (cells.every(c => /^[-: ]+$/.test(c.trim()))) continue;
                t += '<tr>' + cells.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
            }
            return t + '</table>';
        });
        html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
        html = html.replace(/([^\n]+)\n\n/g, '<p>$1</p>\n');
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    // ─── 流式渲染器 ───────────────────────────────

    class StreamRenderer {
        constructor(el, scrollContainer) {
            this.el = el; this.scroll = scrollContainer; this.text = ''; this.timer = null;
            // 流式阶段用纯文本节点追加，避免每 chunk 全量 parseMD + innerHTML 重建 → O(n²) 卡顿
            this._textNode = document.createTextNode('');
            this._dotsSpan = document.createElement('span');
            this._dotsSpan.className = 'chat-loading-dots';
            this._dotsSpan.innerHTML = '<span>.</span><span>.</span><span>.</span>';
            this.el.innerHTML = '';  // 清掉构造前预设的 loading dots（dots 默认显示，作为连接等待图标）
            this.el.appendChild(this._textNode);
            this.el.appendChild(this._dotsSpan);
        }
        append(chunk) {
            this.text += chunk;
            this._textNode.textContent = this.text;
            this._armDots();
            this.scroll.scrollTop = this.scroll.scrollHeight;
        }
        set(text) {
            this.text = text;
            this._textNode.textContent = this.text;
            this._armDots();
            this.scroll.scrollTop = this.scroll.scrollHeight;
        }
        _armDots() {
            clearTimeout(this.timer);
            this._dotsSpan.style.display = 'none';
            this.timer = setTimeout(() => {
                this._dotsSpan.style.display = '';
                this.scroll.scrollTop = this.scroll.scrollHeight;
            }, 500);
        }
        stop() {
            clearTimeout(this.timer);
            this._dotsSpan.remove();
            // 定型：一次性 parseMD 渲染完整 Markdown
            this.el.innerHTML = parseMD(this.text);
            this.scroll.scrollTop = this.scroll.scrollHeight;
        }
        destroy() { clearTimeout(this.timer); }
        // 错误/中断时隐藏连接等待图标（防"已收部分文本后中断"导致 dots 残留）
        hideWaiting() { clearTimeout(this.timer); this._dotsSpan.style.display = 'none'; }
    }

    function createSSEStream(url, renderer, onDone, onError) {
        const es = new EventSource(url);
        const finish = () => { renderer.stop(); es.close(); onDone(); };
        es.addEventListener('streaming', (e) => { renderer.append(e.data); });
        es.addEventListener('reply', (e) => {
            if (/^(🧭|New session)/.test(e.data)) return;
            renderer.set(e.data);
        });
        es.addEventListener('idle', finish);
        es.addEventListener('done', finish);
        es.addEventListener('error', () => { renderer.destroy(); renderer.hideWaiting(); es.close(); onError(); });
        return es;
    }

    function addChatMsg(role, text) {
        const area = document.getElementById('chat-msg-area');
        if (!area) return null;
        // ★ 合并：上一条同 role → 追加到已有 bubble
        const last = area.lastElementChild;
        if (last && last.classList.contains('chat-bubble-wrapper')) {
            const lastRole = last.querySelector('.chat-msg-user, .chat-msg-ai');
            if (lastRole && lastRole.classList.contains('chat-msg-' + role)) {
                const p = document.createElement('p');
                p.style.margin = '4px 0';
                p.textContent = text;
                lastRole.appendChild(p);
                area.scrollTop = area.scrollHeight;
                return lastRole;
            }
        }
        const div = document.createElement('div');
        div.className = `chat-msg-${role}`;
        div.textContent = text;
        area.appendChild(div);
        area.scrollTop = area.scrollHeight;
        return div;
    }

    // ─── 历史消息加载 ──────────────────────────────

    function addHistoryBubble(role, text, aiName, silent = false) {
        const area = document.getElementById('chat-msg-area');
        if (!area) return null;
        const cssRole = role === 'assistant' ? 'ai' : role;
        const name = cssRole === 'user' ? I18N.t('chat_user_name') : aiName;
        const side = cssRole === 'user' ? 'right' : 'left';
        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper chat-bubble-${side}`;
        const COLLAPSE_THRESHOLD = 400;
        const long = typeof text === 'string' && text.length > COLLAPSE_THRESHOLD;
        let html = `<div class="chat-bubble-name">${UIRenderer.escapeHtml(name)}</div>`;
        html += `<div class="chat-msg-${cssRole}${long ? ' chat-msg-collapsed' : ''}">${parseMD(text)}</div>`;
        if (long) {
            html += `<div class="chat-msg-toggle" role="button" tabindex="0">${I18N.t('chat_expand')}</div>`;
        }
        wrapper.innerHTML = html;
        area.appendChild(wrapper);
        if (long) {
            const body = wrapper.querySelector('.chat-msg-collapsed');
            const toggle = wrapper.querySelector('.chat-msg-toggle');
            const onToggle = () => {
                const collapsed = body.classList.toggle('chat-msg-collapsed');
                toggle.textContent = collapsed ? I18N.t('chat_expand') : I18N.t('chat_collapse');
            };
            toggle.addEventListener('click', onToggle);
            toggle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
            });
        }
        if (!silent) area.scrollTop = area.scrollHeight;
        return wrapper;
    }

    // 助手消息合并为单气泡：name 作为卡片上方的标签（在气泡外），整段回合是 .chat-assistant-bubble 一张统一卡片
    function openAssistantBubble(aiName, silent = false) {
        const area = document.getElementById('chat-msg-area');
        if (!area) return null;
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-bubble-wrapper chat-bubble-left';
        wrapper.innerHTML =
            `<div class="chat-bubble-name">${UIRenderer.escapeHtml(aiName)}</div>` +
            `<div class="chat-assistant-bubble"><div class="chat-assistant-body"></div></div>`;
        area.appendChild(wrapper);
        if (!silent) area.scrollTop = area.scrollHeight;
        return wrapper.querySelector('.chat-assistant-body');
    }

    // 助手文本段：始终展开（不做长文折叠）
    function appendTextBlock(body, text) {
        const div = document.createElement('div');
        div.className = 'chat-msg-ai';
        div.innerHTML = parseMD(text);
        body.appendChild(div);
    }

    // 单个 toolCall 渲染为一行缩写（不展开参数巨量正文；用 textContent 防 XSS）
    function appendToolLine(body, part) {
        const name = part.name || (part.type || 'tool');
        const args = part.arguments || part.partialArgs || {};
        let detail;
        if (name === 'exec' && args.command) {
            detail = args.command;
        } else if ((name === 'read' || name === 'write') && args.path) {
            detail = args.path;                       // write 的 content 巨量，绝不拼
        } else {
            try { detail = JSON.stringify(args); } catch { detail = ''; }
        }
        const MAX = 120;
        let label = typeof detail === 'string' ? detail : (detail == null ? '' : String(detail));
        if (label.length > MAX) label = label.slice(0, MAX) + '…';
        const div = document.createElement('div');
        div.className = 'chat-msg-tool';
        div.title = typeof detail === 'string' ? detail : '';   // 全量存 title
        div.textContent = `🔧 ${name}: ${label}`;
        body.appendChild(div);
    }

    // 连续 >2 个 toolCall：折叠成一组，summary 可点展开/收起
    function appendToolGroup(body, parts) {
        const group = document.createElement('div');
        group.className = 'chat-tool-group chat-tool-group-collapsed';
        const summary = document.createElement('div');
        summary.className = 'chat-tool-group-summary';
        summary.setAttribute('role', 'button');
        summary.setAttribute('tabindex', '0');
        const setLabel = (collapsed) => {
            summary.textContent = `🔧 ${parts.length} ${I18N.t('chat_tool_calls')} ${collapsed ? '▸' : '▾'}`;
        };
        setLabel(true);
        const lines = document.createElement('div');
        lines.className = 'chat-tool-lines';
        for (const p of parts) appendToolLine(lines, p);
        group.appendChild(summary);
        group.appendChild(lines);
        body.appendChild(group);
        const onToggle = () => {
            const collapsed = group.classList.toggle('chat-tool-group-collapsed');
            setLabel(collapsed);
        };
        summary.addEventListener('click', onToggle);
        summary.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
        });
    }

    function extractText(content) {
        if (!Array.isArray(content)) return null;
        const texts = content.filter(c => c.type === 'text').map(c => c.text || '');
        return texts.length ? texts.join('\n') : null;
    }

    // 历史加载完成后若没有任何气泡渲染，则提示"暂无历史消息"
    function showHistoryEmptyIfNeeded(area) {
        if (!area) return;
        const rendered = area.querySelectorAll('.chat-bubble-wrapper').length;
        if (rendered === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'chat-empty';
            emptyEl.textContent = I18N.t('chat_no_history');
            area.appendChild(emptyEl);
        }
    }

    // 历史轮询：复用同一渲染核心。初始加载与周期轮询共用此函数（避免双路径竞争）。
    // 三道闸门：入口 gate1 → await fetch → gate2(在途拦截) → 渲染 → gate3(排下轮前防 re-arm)。
    // 纯净阶段（无 stream）可安全清空已有历史气泡后整段重渲染，因为此时不存在 live 气泡。
    async function pollTick(showLoading) {
        if (_streaming) return;                          // 闸门1：出现过 stream → 永不轮询
        if (!_overlayEl) return;                          // overlay 已关闭/替换，不再轮询
        const area = document.getElementById('chat-msg-area');
        if (!area) return;

        // 加载中动态提示（仅首轮显示，周期轮询不闪）
        let loadingEl = null;
        if (showLoading) {
            loadingEl = document.createElement('div');
            loadingEl.className = 'chat-loading';
            loadingEl.innerHTML = `<span class="spinner"></span><span>${I18N.t('chat_loading')}</span>`;
            area.appendChild(loadingEl);
        }

        try {
            const resp = await fetch(`${_pollWebchatUrl}/api/history?sessionKey=${encodeURIComponent(_pollSessionKey)}`);
            if (loadingEl) loadingEl.remove();           // X16：提前返回也要先清 spinner
            if (_streaming) return;                       // 闸门2：在途请求落地前拦截（堵 A）
            if (!_overlayEl) return;                      // overlay 中途关闭
            if (!resp.ok) return;                         // 失败保留现状，不闪空（r3）
            const data = await resp.json();
            if (_streaming) return;                       // 闸门2b：json 解析期间出现 stream
            if (!_overlayEl) return;
            if (!data.ok || !Array.isArray(data.messages)) { showHistoryEmptyIfNeeded(area); return; }

            // 滚动守卫：清空前紧邻一瞬用【当前】位置测（fetch/json 之后已是当前）
            const distBottom = area.scrollHeight - area.scrollTop;
            const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight <= 60;

            // 纯净阶段清空历史气泡（绝不碰 .chat-msg-system 与 doSend 直接子气泡）
            area.querySelectorAll('.chat-bubble-wrapper, .chat-empty, .chat-loading').forEach(el => el.remove());

            // 跨消息合并：同一轮 assistant 回复（被隐藏的 toolResult 隔开）合并为单个气泡，
            // 用户消息作为回合边界。name 只在气泡顶部出现一次（卡片上方标签）。
            let currentBody = null;     // 当前 assistant 气泡的内容容器
            let toolRunBuffer = [];     // 连续 toolCall 缓冲（跨消息累积，文本/回合边界打断）

            const ensureBody = () => {
                if (!currentBody) currentBody = openAssistantBubble(_pollAiName, true);
                return currentBody;
            };
            const flushToolRun = () => {
                if (!toolRunBuffer.length) return;
                const body = ensureBody();
                if (toolRunBuffer.length > 2) appendToolGroup(body, toolRunBuffer);  // 连续 >2 折叠
                else for (const p of toolRunBuffer) appendToolLine(body, p);         // ≤2 展开
                toolRunBuffer = [];
            };

            for (const msg of data.messages) {
                if (msg.role === 'toolResult') continue;            // 三类之外：隐藏（不打断 assistant 回合）
                if (msg.role === 'user') {
                    flushToolRun();                                 // 收尾上一轮 assistant
                    currentBody = null;
                    const text = typeof msg.content === 'string'
                        ? msg.content
                        : extractText(msg.content);                 // 兼容 user.content 为数组
                    if (text && text.trim()) addHistoryBubble('user', text, _pollAiName, true);
                } else if (msg.role === 'assistant') {
                    const parts = Array.isArray(msg.content)
                        ? msg.content
                        : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
                    for (const p of parts) {
                        if (p.type === 'text') {
                            if (p.text && p.text.trim()) {
                                flushToolRun();                     // 文本打断 toolCall 连续性
                                appendTextBlock(ensureBody(), p.text);
                            }
                        } else if (p.type === 'toolCall') {
                            toolRunBuffer.push(p);                  // 跨消息累积连续 toolCall
                        }
                        // 其它 part 类型忽略
                    }
                }
                // 其它 role（system 等）忽略
            }
            flushToolRun();                                         // 收尾最后一轮
            showHistoryEmptyIfNeeded(area);                        // 无任何消息则提示空

            if (atBottom) area.scrollTop = area.scrollHeight;             // R1：在底部→跟随到底
            else area.scrollTop = Math.max(0, area.scrollHeight - distBottom);  // R2：离底→保持离底距离
        } catch {
            if (loadingEl) loadingEl.remove();
            showHistoryEmptyIfNeeded(area);                        // 加载失败兜底显示空提示
        }

        if (_streaming) return;                          // 闸门3：排下轮前再判，防 re-arm
        if (!_overlayEl) return;
        _pollTimer = setTimeout(() => pollTick(false), POLL_INTERVAL);   // 递归 setTimeout：poll 完成才排下轮
    }

    // 启动历史轮询：设置上下文 + 立即首轮（带 spinner）+ 之后周期轮询
    function startPolling(webchatUrl, sessionKey, aiName) {
        _pollWebchatUrl = webchatUrl;
        _pollSessionKey = sessionKey;
        _pollAiName = aiName;
        _streaming = false;                              // 全新 overlay，先复位
        clearTimeout(_pollTimer);
        pollTick(true);
    }

    // ─── 通用聊天覆盖层 ───────────────────────────

    async function openChatOverlay(opts) {
        const webchatUrl = $A.config?.webchatUrl || $A.config?.webchatUrl;
        if (!webchatUrl) { alert(CFG.alertNoWebchat); return; }
        if (_overlayEl) _overlayEl.remove();
        clearTimeout(_pollTimer);                       // H1：替换旧 overlay 时清掉遗留轮询定时器（堵 X12 孤儿定时器）
        _streaming = false;                             // H1：复位，避免旧 overlay 的 stream 状态串台到新 overlay（堵 X13）

        const overlay = document.createElement('div');
        overlay.className = 'chat-widget-overlay';
        const wide = opts.showProgress ? ' chat-widget-modal-wide' : '';
        const panelHtml = opts.showProgress ? `
                    <div class="chat-progress-panel">
                        <div class="chat-progress-title">${CFG.progressTitle}</div>
                        <div class="chat-progress-steps" id="team-progress-steps">
                            <div class="prog-step"><span class="prog-dot">○</span> ${CFG.progressWaiting}</div>
                        </div>
                        <button class="chat-progress-register" id="btn-register-team" disabled>${CFG.registerBtn}</button>
                    </div>` : '';
        overlay.innerHTML = `
            <div class="chat-widget-modal${wide}">
                <div class="chat-widget-header">
                    <span>${UIRenderer.escapeHtml(opts.title)}</span>
                    <button class="chat-widget-close" title="${I18N.t('title_close')}">✕</button>
                </div>
                <div class="chat-widget-main">
                    <div class="chat-custom-panel${opts.showProgress ? '' : ' chat-custom-panel-full'}">
                        <div class="chat-custom-messages" id="chat-msg-area">
                            <div class="chat-msg-system">${opts.systemMsg}</div>
                        </div>
                        <div class="chat-input-box" style="margin:0 12px 10px 12px">
                            <div id="input-body">
                                <textarea id="chat-input" rows="3" autocomplete="off">${UIRenderer.escapeHtml(opts.defaultInput)}</textarea>
                            </div>
                            <div id="input-controls-row">
                                <div id="input-controls">
                                    <select id="chat-input-model" style="max-width:180px" title="${I18N.t('model_title')}">
                                        <option value="">${I18N.t('model_loading')}</option>
                                    </select>
                                </div>
                                <button id="chat-send-btn" title="${CFG.sendBtn}">➤</button>
                            </div>
                        </div>
                    </div>${panelHtml}
                </div>
            </div>`;
        document.body.appendChild(overlay);
        _overlayEl = overlay;

        const closeFn = () => {
            if (opts.showMonitor) AppApi.postStopTeamMonitor().catch(() => {});
            ModelModule.unregister(overlay.querySelector('#chat-input-model'));
            clearTimeout(_pollTimer);                   // H5：关闭弹窗必须清定时器（堵 I 泄漏）
            _streaming = false;
            overlay.remove(); _overlayEl = null;
        };
        overlay.querySelector('.chat-widget-close').addEventListener('click', closeFn);

        const input = overlay.querySelector('#chat-input');
        const sendBtn = overlay.querySelector('#chat-send-btn');
        const msgArea = overlay.querySelector('#chat-msg-area');
        const sessionKey = opts.sessionKey;

        // ★ 加载模型下拉（per-session 模式，注册制，关闭自动注销）
        const modelEl = overlay.querySelector('#chat-input-model');
        if (modelEl) {
            ModelModule.register(modelEl, {
                placeholder: I18N.t('model_placeholder'),
                showFollow: true,
                sessionKey: opts.sessionKey,
                agentId: opts.agentId,
            });
        }

        // ★ 启动历史轮询（首轮带 spinner 的立即加载 + 周期增量感知），成员私聊用成员名，团队创建用 AI助手
        const aiName = opts.showProgress ? I18N.t('chat_ai_name') : opts.title;
        startPolling(webchatUrl, sessionKey, aiName);

        const doSend = () => {
            const text = input.value.trim();
            if (!text || sendBtn.disabled) return;
            input.value = '';
            sendBtn.disabled = true;
            clearTimeout(_pollTimer);                   // H3：本端出现 stream → 永久停止历史轮询
            _streaming = true;                          // （出现即停，stream 结束后不自动复位，本 overlay 不再轮询）
            const fullText = opts.showMonitor && _nextPrompt ? (text + '\n' + _nextPrompt) : text;
            addChatMsg('user', fullText);
            const replyEl = addChatMsg('ai', '');
            const renderer = new StreamRenderer(replyEl, msgArea);
            createSSEStream(
                `${webchatUrl}/api/stream?text=${encodeURIComponent(fullText)}&sessionKey=${encodeURIComponent(sessionKey)}`,
                renderer,
                () => { sendBtn.disabled = false; input.focus(); },
                () => { sendBtn.disabled = false; if (!renderer.text) replyEl.innerHTML = CFG.errorInterrupt; }
            );
        };
        sendBtn.addEventListener('click', doSend);
        input.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;            // 中文输入法组合中：放行选词
            if (e.key !== 'Enter') return;                              // 非回车：放行默认行为
            if (e.ctrlKey || e.metaKey || e.shiftKey) {                 // 修饰键+回车 = 手动插入换行
                e.preventDefault();                                     // 先阻止原生换行（避免 Shift 双换行）
                const s = input.selectionStart, end = input.selectionEnd, v = input.value;
                input.value = v.slice(0, s) + '\n' + v.slice(end);      // 光标处插入换行
                input.selectionStart = input.selectionEnd = s + 1;      // 光标移到换行后
                input.dispatchEvent(new Event('input', { bubbles: true })); // 触发 auto-resize/草稿监听
                return;
            }
            e.preventDefault();                                        // 纯回车：吞掉默认换行并发送
            doSend();
        });

        if (opts.showMonitor) {
            try {
                const resp = await AppApi.postStartTeamMonitor();
                const init = await resp.json();
                if (init.nextPrompt) _nextPrompt = resolveNextPrompt(init.stage, init.nextPrompt);
                // ★ 恢复已有进度（断点续传）
                if (init.stages && init.stages.some(s => s.done)) updateTeamCreateProgress(init);
            } catch (e) { console.warn('[TeamMonitor] 启动失败:', e); }
        }
    }

    // ─── 公共入口 ─────────────────────────────────

    async function openTeamCreateChat() {
        await openChatOverlay({
            sessionKey: _sessionKey,
            title: CFG.title,
            defaultInput: CFG.defaultInput,
            systemMsg: CFG.systemMsg,
            showProgress: true,
            showMonitor: true,
        });
    }

    async function openMemberChat(memberName, sessionKey, agentId) {
        await openChatOverlay({
            sessionKey,
            agentId,
            title: memberName,
            defaultInput: '',
            systemMsg: I18N.t('chat_direct_talk'),
            showProgress: false,
            showMonitor: false,
        });
    }

    // ─── 进度面板更新（SSE 推送触发） ──────────────

    // 由"已完成阶段"解析应拼接给 AI 的"下一阶段提示"；全部完成/无效则停止拼接（返回 ''）
    function resolveNextPrompt(completedStage, fallbackPrompt) {
        if (typeof completedStage === 'number' && completedStage >= 5) return '';
        const next = (typeof completedStage === 'number' && completedStage >= 1) ? completedStage + 1 : 1;
        return I18N.t('chat_stage_' + next + '_prompt') || fallbackPrompt || '';
    }

    function updateTeamCreateProgress(data) {
        const stepsEl = document.getElementById('team-progress-steps');
        const regBtn = document.getElementById('btn-register-team');
        if (!stepsEl) return;

        _nextPrompt = resolveNextPrompt(data.stage, data.nextPrompt);
        if (data.teamId) regBtn?.setAttribute('data-team-id', data.teamId);
        const stages = data.stages || [];
        let html = '';
        stages.forEach((s, i) => {
            const done = s.done;
            const stageKey = 'chat_stage_' + s.stage + '_name';
            const stageName = I18N.t(stageKey) || s.name;
            html += `<div class="prog-step${done ? ' done' : ''}">
                <span class="prog-dot">${done ? '✓' : '○'}</span>
                <span>${UIRenderer.escapeHtml(stageName)}</span>
            </div>`;
            if (i === 0 && done && data.dirPath) {
                const name = data.dirPath.split(/[\\/]/).pop();
                html += `<div class="prog-link" data-action="open-folder" data-path="${UIRenderer.escapeHtml(data.dirPath)}">📂 ${UIRenderer.escapeHtml(name)}</div>`;
            }
            if (i === 2 && done && data.teamsoulPath) {
                html += `<div class="prog-link" data-action="open-file" data-path="${UIRenderer.escapeHtml(data.teamsoulPath)}">📄 teamsoul.md</div>`;
            }
            if (i === 3 && done && data.teamRulePath) {
                html += `<div class="prog-link" data-action="open-file" data-path="${UIRenderer.escapeHtml(data.teamRulePath)}">📄 team RULE.md</div>`;
            }
        });
        stepsEl.innerHTML = html;

        stepsEl.querySelectorAll('.prog-link').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', async (e) => {
                e.preventDefault();
                const action = el.dataset.action;
                const path = el.dataset.path;
                if (action === 'open-folder') {
                    await AppApi.postOpenFolder(path);
                } else if (action === 'open-file') {
                    await AppApi.postOpenFile({ path });
                }
            });
        });

        if (regBtn) {
            regBtn.disabled = (data.stage < 5);
        }
    }

    function closeOverlay() {
        if (_overlayEl) {
            clearTimeout(_pollTimer);                   // 程序化关闭同样清定时器 + 复位
            _streaming = false;
            _overlayEl.remove(); _overlayEl = null;
        }
    }

    // ─── 公开 API ─────────────────────────────────

    return {
        CFG,
        openTeamCreateChat,
        openMemberChat,
        updateProgress: updateTeamCreateProgress,
        closeOverlay,
        get overlayEl() { return _overlayEl; },
    };
})();
