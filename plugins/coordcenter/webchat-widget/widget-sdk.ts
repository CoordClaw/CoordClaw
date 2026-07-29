/**
 * WebChat Widget SDK - 前端 JavaScript
 *
 * 功能24: 可嵌入的聊天 Widget，复用 OpenClaw /__openclaw__/ws 协议
 *
 * 使用方式：
 *   <script src="/coordclaw-plugin/coordclawcenter/webchat/widget.js"></script>
 *   <link  href="/coordclaw-plugin/coordclawcenter/webchat/widget.css" rel="stylesheet">
 *   <script>
 *     const chat = new WebChatWidget({ container: '#chat-panel', sessionKey: 'agent/default/main' });
 *     chat.open();
 *   </script>
 */

export function getWidgetSdkJs(): string {
  return `
// ==WebChatWidgetSDK==
(function() {
  'use strict';

  // ==================== 工具函数 ====================

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function timeStr(ts) {
    var d = new Date(ts);
    var pad = function(n) { return n < 10 ? '0' + n : n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ==================== RPC 客户端 ====================

  /**
   * OpenClaw WebSocket RPC Client
   * 连接 /__openclaw__/ws，实现 JSON-RPC 双向通信
   */
  function WsRpcClient(wsUrl, token) {
    var self = this;
    this.wsUrl = wsUrl || 'ws://127.0.0.1:28789';
    this.token = token || '';
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.pendingCallbacks = {};       // id -> { resolve, reject }
    this.eventListeners = {};         // event -> Set<callback>
    this._reqIdSeq = 0;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;

    // ---------- 连接管理 ----------

    /** 构建 WebSocket 完整 URL */
    this._buildWsUrl = function() {
      var base = self.wsUrl;
      if (!base && typeof window !== 'undefined' && window.location) {
        base = window.location.origin.replace(/^http/, 'ws');
      }
      base = (base || 'ws://127.0.0.1:28789').replace(/\\/+$/, '');
      return base.indexOf('/__openclaw__/ws') === -1 ? base + '/__openclaw__/ws' : base;
    };

    /** 从 /config 接口获取配置（自动获取 token 和 wsUrl） */
    this._fetchConfig = function() {
      return new Promise(function(resolve, reject) {
        try {
          // widget.js 从 Gateway 加载，直接用页面 origin 获取 config
          var httpBase = self.wsUrl
            ? self.wsUrl.replace(/^ws(s?):/, 'http$1:')
            : (typeof window !== 'undefined' && window.location ? window.location.origin : 'http://127.0.0.1:28789');
          var configUrl = httpBase.replace(/\\/+$/, '') + '/coordclaw-plugin/coordclawcenter/webchat/config';
          var xhr = new XMLHttpRequest();
          xhr.open('GET', configUrl, true);
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var cfg = JSON.parse(xhr.responseText);
                resolve(cfg);
              } catch(e) { reject(e); }
            } else {
              reject(new Error('Config fetch status: ' + xhr.status));
            }
          };
          xhr.onerror = function() { reject(new Error('Config fetch network error')); };
          xhr.timeout = 5000;
          xhr.ontimeout = function() { reject(new Error('Config fetch timeout')); };
          xhr.send();
        } catch(e) { reject(e); }
      });
    };

    this.connect = function() {
      if (self.ws && (self.ws.readyState === 0 || self.ws.readyState === 1)) return Promise.resolve();

      return new Promise(function(resolve, reject) {
        try {
          self.ws = new WebSocket(self._buildWsUrl());
        } catch(e) { reject(e); return; }

        self.ws.onopen = function() {
          self.connected = true;
          self._emit('connection', true);
          // 发送 connect 握手
          self._sendRequest('connect', {
            client: { id: 'webchat-ui', mode: 'webchat', version: '1.0.0', platform: 'browser' },
            protocol: { min: 3, max: 3 },
            role: 'operator',
            auth: self.token ? { token: self.token } : undefined
          }).then(function() {
            self.authenticated = true;
            self.reconnectAttempt = 0;
            if (self.reconnectTimer) { clearTimeout(self.reconnectTimer); self.reconnectTimer = null; }
            self._emit('auth', true);
            resolve();
          }).catch(function(err) {
            reject(new Error('Connect auth failed: ' + (err.message || err)));
          });
        };

        self.ws.onmessage = function(evt) {
          self._onMessage(evt.data);
        };

        self.ws.onclose = function() {
          self.connected = false;
          self.authenticated = false;
          self._emit('connection', false);
          self._emit('auth', false);
          // 拒绝所有 pending callbacks
          for (var id in self.pendingCallbacks) {
            self.pendingCallbacks[id].reject(new Error('Connection closed'));
          }
          self.pendingCallbacks = {};
          // 自动重连：最多 10 次，每次间隔 3 秒
          if (!self.reconnectTimer && self.reconnectAttempt < 10) {
            self.reconnectAttempt++;
            self.reconnectTimer = setTimeout(function() {
              self.reconnectTimer = null;
              self.connect().catch(function() {});
            }, 3000);
          }
        };

        self.ws.onerror = function(err) {
          self._emit('error', new Error('WebSocket error'));
        };
      });
    };

    this.disconnect = function() {
      if (self.ws) { self.ws.close(); self.ws = null; }
    };

    this.isConnected = function() { return self.connected && self.authenticated; };

    // ---------- RPC 调用 ----------

    this._sendRequest = function(method, params) {
      return new Promise(function(resolve, reject) {
        var id = String(++self._reqIdSeq);
        self.pendingCallbacks[id] = { resolve: resolve, reject: reject, method: method };
        var frame = JSON.stringify({
          type: 'req',
          id: id,
          method: method,
          params: params || {}
        });
        try {
          self.ws.send(frame);
        } catch(e) {
          delete self.pendingCallbacks[id];
          reject(e);
        }
      });
    };

    /** 发送聊天消息 */
    this.sendChat = function(sessionKey, message) {
      return self._sendRequest('sessions.send', {
        key: sessionKey,
        message: message,
        timeoutMs: 120000,
        idempotencyKey: uuid()
      });
    };

    /** 中止当前回复 */
    this.abortChat = function(runId) {
      return self._sendRequest('chat.abort', { runId: runId });
    };

    /** 订阅 session 事件 */
    this.subscribeSessions = function() {
      return self._sendRequest('sessions.subscribe', {});
    };

    /** 获取会话历史消息 */
    this.fetchHistory = function(sessionKey) {
      return self._sendRequest('chat.history', {
        sessionKey: sessionKey,
        limit: 100
      });
    };

    // ---------- 消息解析 ----------

    this._onMessage = function(rawData) {
      var msg;
      try { msg = JSON.parse(rawData); } catch(e) { return; }

      // 响应帧
      if (msg.type === 'res') {
        var cb = self.pendingCallbacks[msg.id];
        if (cb) {
          delete self.pendingCallbacks[msg.id];
          if (msg.ok) {
            cb.resolve(msg.payload || msg);
          } else {
            cb.reject(new Error((msg.error && msg.error.message) || 'Request failed'));
          }
        }
        return;
      }

      // 事件帧
      if (msg.type === 'event') {
        self._emit(msg.event, msg.payload);
        return;
      }
    };

    // ---------- 事件系统 ----------

    this.on = function(event, callback) {
      if (!self.eventListeners[event]) self.eventListeners[event] = new Set();
      self.eventListeners[event].add(callback);
      return function() { self.eventListeners[event].delete(callback); };  // unsubscribe
    };

    this._emit = function(event, data) {
      var listeners = self.eventListeners[event];
      if (!listeners) return;
      listeners.forEach(function(cb) { try { cb(data); } catch(e) {} });
    };
  }

  // ==================== Widget UI ====================

  /**
   * WebChatWidget - 可嵌入聊天组件
   *
   * @param {Object} opts
   * @param {string|HTMLElement} opts.container - CSS 选择器或 DOM 元素
   * @param {string} [opts.sessionKey] - 目标 session key
   * @param {string} [opts.wsUrl] - WS 地址（不填则从 /config 自动获取）
   * @param {string} [opts.token] - Gateway Token
   * @param {string} [opts.theme='dark'] - light / dark
   * @param {string} [opts.title] - 标题文字
   * @param {string} [opts.placeholder] - 输入框占位符
   * @param {Function} [opts.onMessage] - 收到消息回调
   * @param {Function} [opts.onConnectionChange] - 连接状态变化回调
   * @param {Function} [opts.onError] - 错误回调
   */
  function WebChatWidget(opts) {
    var self = this;
    this.opts = Object.assign({
      theme: 'dark',
      title: 'AI Chat',
      placeholder: '输入消息...',
      wsUrl: '',
      token: ''
    }, opts || {});

    this.container = null;
    this.el = null;           // Widget 根元素
    this.msgListEl = null;    // 消息列表容器
    this.inputEl = null;      // 输入框
    this.statusEl = null;     // 状态指示器
    this.rpc = null;          // WsRpcClient 实例
    this.currentRunId = null; // 当前正在进行的 run ID
    this.opened = false;

    // ========== 渲染 ==========

    this.render = function() {
      // 解析 container
      if (typeof self.opts.container === 'string') {
        self.container = document.querySelector(self.opts.container);
      } else {
        self.container = self.opts.container;
      }
      if (!self.container) throw new Error('Container not found: ' + self.opts.container);

      var themeClass = self.opts.theme === 'light' ? 'wcw-light' : 'wcw-dark';

      self.el = document.createElement('div');
      self.el.className = 'wcw-widget ' + themeClass;
      self.el.innerHTML =
        '<div class="wcw-header">' +
          '<span class="wcw-title">' + escHtml(self.opts.title) + '</span>' +
          '<span class="wcw-status"><i class="wcw-dot wcw-dot-gray"></i><span class="wcw-status-text">未连接</span></span>' +
        '</div>' +
        '<div class="wcw-messages"></div>' +
        '<div class="wcw-input-area">' +
          '<textarea class="wcw-input" rows="1" placeholder="' + escHtml(self.opts.placeholder) + '" maxlength="4000"></textarea>' +
          '<button class="wcw-send-btn" type="button">发送</button>' +
        '</div>';

      // 注入自定义 CSS（变量覆盖 + 完整样式）
      var customStyle = document.createElement('style');
      var cssChunks = [];
      var cssVars = self.opts.css;
      if (cssVars && typeof cssVars === 'object') {
        var varLines = [];
        for (var k in cssVars) {
          if (cssVars.hasOwnProperty(k)) varLines.push('  ' + k + ': ' + cssVars[k] + ';');
        }
        if (varLines.length > 0) {
          cssChunks.push('.wcw-widget { ' + varLines.join(' ') + ' }');
        }
      }
      if (self.opts.cssText && typeof self.opts.cssText === 'string') {
        cssChunks.push(self.opts.cssText);
      }
      if (cssChunks.length > 0) {
        customStyle.textContent = cssChunks.join('\n');
        self.el.appendChild(customStyle);
      }

      self.container.appendChild(self.el);

      // 缓存 DOM 引用
      self.msgListEl = self.el.querySelector('.wcw-messages');
      self.inputEl = self.el.querySelector('.wcw-input');
      self.statusEl = self.el.querySelector('.wcw-status');

      // 绑定事件
      self._bindEvents();
    };

    this._bindEvents = function() {
      var sendBtn = self.el.querySelector('.wcw-send-btn');

      sendBtn.addEventListener('click', function() { self._sendMessage(); });

      self.inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          self._sendMessage();
        }
        // 自动调整高度
        setTimeout(function() {
          self.inputEl.style.height = 'auto';
          self.inputEl.style.height = Math.min(self.inputEl.scrollHeight, 120) + 'px';
        }, 0);
      });

      // 窗口大小变化时滚动到底部
      window.addEventListener('resize', function() { self._scrollBottom(); });
    };

    // ========== 连接管理 ==========

    this.open = function() {
      if (self.opened) return;
      self.opened = true;

      if (!self.el) self.render();

      self._updateStatus('connecting', '连接中...');

      // 自动获取配置（如果 wsUrl 或 token 未提供）
      var connectPromise = Promise.resolve();
      if (!self.opts.wsUrl || !self.opts.token) {
        self._updateStatus('connecting', '获取配置中...');
        // 先创建临时客户端用于请求 config
        var tempRpc = new WsRpcClient(self.opts.wsUrl, self.opts.token);
        connectPromise = tempRpc._fetchConfig().then(function(cfg) {
          if (cfg.success) {
            if (!self.opts.wsUrl && cfg.wsUrl) self.opts.wsUrl = cfg.wsUrl;
            if (!self.opts.token && cfg.token) self.opts.token = cfg.token;
            if (cfg.sessions && cfg.sessions.length > 0 && !self.opts.sessionKey) {
              self.opts.sessionKey = cfg.sessions[0].sessionKey;
            }
          }
          return cfg;
        }).catch(function(err) {
          // config 获取失败不阻塞，使用默认值继续
          console.warn('[WebChatWidget] Config fetch failed, using defaults:', err.message);
          return null;
        });
      }

      connectPromise.then(function() {
        // 初始化 RPC 客户端（此时 token 和 wsUrl 应已就绪）
        self.rpc = new WsRpcClient(self.opts.wsUrl, self.opts.token);

        // 注册事件监听
        self.rpc.on('connection', function(connected) {
          self._updateStatus(connected ? 'connected-auth' : 'disconnected', connected ? '已连接' : '已断开');
          if (self.opts.onConnectionChange) self.opts.onConnectionChange(connected);
        });

        self.rpc.on('auth', function(ok) {
          if (ok) {
            self._updateStatus('online', '在线');
            self.rpc.subscribeSessions().catch(function(){});
            self.loadHistory();
          } else {
            self._updateStatus('error', '认证失败: Token 无效或未配置');
          }
        });

        self.rpc.on('chat', function(payload) {
          self._handleChatEvent(payload);
        });

        self.rpc.on('error', function(err) {
          self._addErrorMsg(err.message || '未知错误');
          if (self.opts.onError) self.opts.onError(err);
        });

        // 开始连接
        return self.rpc.connect();
      }).then(function() {
        // 连接成功（在 connect 内部 resolve）
      }).catch(function(err) {
        self._updateStatus('error', '连接失败: ' + (err.message || ''));
        if (self.opts.onError) self.opts.onError(err);
      });
    };

    this.close = function() {
      if (!self.opened) return;
      self.opened = false;
      if (self.rpc) { self.rpc.disconnect(); self.rpc = null; }
      if (self.el && self.el.parentNode) { self.el.parentNode.removeChild(self.el); }
      self.el = null;
    };

    this.destroy = function() {
      self.close();
    };

    // ========== 消息收发 ==========

    this._sendMessage = function() {
      var text = (self.inputEl.value || '').trim();
      if (!text) return;
      if (!self.rpc || !self.rpc.isConnected()) {
        self._addErrorMsg('未连接，请等待连接建立');
        return;
      }
      if (!self.opts.sessionKey) {
        self._addErrorMsg('未设置 sessionKey');
        return;
      }

      // 清空输入框
      self.inputEl.value = '';
      self.inputEl.style.height = 'auto';

      // 显示用户消息
      self._appendMsg('user', text);
      self._scrollBottom();

      // 通过 RPC 发送
      self.rpc.sendChat(self.opts.sessionKey, text).then(function(res) {
        if (res && res.runId) {
          self.currentRunId = res.runId;
        }
      }).catch(function(err) {
        self._addErrorMsg('发送失败: ' + (err.message || ''));
      });
    };

    this._handleChatEvent = function(payload) {
      if (!payload) return;
      var text = '';
      var content = payload.message && payload.message.content;
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          if (content[i].type === 'text' && content[i].text) {
            text += content[i].text;
          }
        }
      }

      if (!text) return;

      var state = payload.state || 'delta';

      if (state === 'delta') {
        // 流式：更新最后一条 assistant 消息，或新建一条
        self._updateOrAppendAssistant(text);
      } else if (state === 'done') {
        self._updateOrAppendAssistant(text);
        self.currentRunId = null;
      } else if (state === 'error') {
        var errMsg = payload.error || text;
        self._appendMsg('system', '[错误] ' + errMsg);
        self.currentRunId = null;
      }

      self._scrollBottom();

      if (self.opts.onMessage) {
        self.opts.onMessage({ role: 'assistant', content: text, timestamp: Date.now(), state: state });
      }
    };

    // ========== UI 操作 ==========

    this._appendMsg = function(role, text) {
      var div = document.createElement('div');
      div.className = 'wcw-msg wcw-msg-' + role;
      div.setAttribute('data-role', role);
      var timeSpan = document.createElement('span');
      timeSpan.className = 'wcw-meta';
      timeSpan.textContent = timeStr(Date.now());
      var contentDiv = document.createElement('div');
      contentDiv.className = 'wcw-content';
      contentDiv.innerHTML = escHtml(text).replace(/\\n/g, '<br>');
      div.appendChild(contentDiv);
      if (role !== 'user') div.appendChild(timeSpan);
      self.msgListEl.appendChild(div);
      return div;
    };

    this._updateOrAppendAssistant = function(text) {
      var last = self.msgListEl.lastElementChild;
      if (last && last.getAttribute('data-role') === 'assistant') {
        var contentDiv = last.querySelector('.wcw-content');
        if (contentDiv) contentDiv.innerHTML = escHtml(text).replace(/\\n/g, '<br>');
      } else {
        self._appendMsg('assistant', text);
      }
    };

    this._addErrorMsg = function(text) {
      self._appendMsg('system', text);
      self._scrollBottom();
    };

    this._updateStatus = function(state, label) {
      if (!self.statusEl) return;
      var dot = self.statusEl.querySelector('.wcw-dot');
      var txt = self.statusEl.querySelector('.wcw-status-text');

      dot.className = 'wcw-dot';
      if (state === 'online') dot.className += ' wcw-dot-green';
      else if (state === 'error') dot.className += ' wcw-dot-red';
      else dot.className += ' wcw-dot-gray';

      if (txt) txt.textContent = label;
    };

    this._scrollBottom = function() {
      if (self.msgListEl) self.msgListEl.scrollTop = self.msgListEl.scrollHeight;
    };

    /** 渲染历史消息列表 */
    this._renderHistory = function(messages) {
      if (!self.msgListEl) return;
      // 清空欢迎消息（如果有）
      self.msgListEl.innerHTML = '';
      var roles = { user: 'user', assistant: 'assistant', system: 'system', tool: 'system' };
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        var role = roles[msg.role] || 'system';
        var content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (var j = 0; j < msg.content.length; j++) {
            if (msg.content[j].type === 'text' && msg.content[j].text) {
              content += (content ? '\n' : '') + msg.content[j].text;
            } else if (msg.content[j].type === 'tool_use') {
              content += (content ? '\n' : '') + '[tool: ' + (msg.content[j].name || 'unknown') + ']';
            } else if (msg.content[j].type === 'tool_result') {
              var tr = msg.content[j].content;
              var truncated = typeof tr === 'string' ? (tr.length > 200 ? tr.slice(0, 200) + '...' : tr) : '[tool result]';
              content += (content ? '\n' : '') + '[result: ' + truncated + ']';
            }
          }
        }
        if (content) self._appendMsg(role, content);
      }
      self._scrollBottom();
    };

    // ========== 公开 API ==========

    this.setSessionKey = function(key) {
      self.opts.sessionKey = key;
      // 切换 session 后自动拉取历史
      if (self.rpc && self.rpc.isConnected()) self.loadHistory();
    };

    /** 拉取并渲染当前 session 的历史消息 */
    this.loadHistory = function(sessionKey) {
      var sk = sessionKey || self.opts.sessionKey;
      if (!sk || !self.rpc || !self.rpc.isConnected()) return;
      self.rpc.fetchHistory(sk).then(function(res) {
        var msgs = (res && res.messages) ? res.messages : [];
        if (!Array.isArray(msgs) && res && res.result && Array.isArray(res.result.messages)) {
          msgs = res.result.messages;
        }
        if (Array.isArray(msgs) && msgs.length > 0) {
          self._renderHistory(msgs);
        }
      }).catch(function(err) {
        console.warn('[WebChatWidget] History fetch failed:', err.message);
      });
    };

    this.sendMessage = function(text) {
      self.inputEl.value = text || '';
      self._sendMessage();
    };

    /** 动态更新 CSS 变量 */
    this.setCss = function(vars) {
      if (!vars || typeof vars !== 'object') return;
      var existing = self.opts.css || {};
      for (var k in vars) {
        if (vars.hasOwnProperty(k)) existing[k] = vars[k];
      }
      self.opts.css = existing;
      // 查找或创建注入 style 标签
      var styleEl = self.el && self.el.querySelector('style[data-wcw-custom]');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-wcw-custom', '1');
        if (self.el) self.el.insertBefore(styleEl, self.el.firstChild);
      }
      var lines = [];
      for (var k2 in self.opts.css) {
        if (self.opts.css.hasOwnProperty(k2)) lines.push('  ' + k2 + ': ' + self.opts.css[k2] + ';');
      }
      var cssChunks = [];
      if (lines.length > 0) cssChunks.push('.wcw-widget { ' + lines.join(' ') + ' }');
      if (self.opts.cssText) cssChunks.push(self.opts.cssText);
      styleEl.textContent = cssChunks.join('\n');
    };

    /** 动态更新完整 CSS 字符串 */
    this.setCssText = function(cssText) {
      self.opts.cssText = cssText || '';
      var styleEl = self.el && self.el.querySelector('style[data-wcw-custom]');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-wcw-custom', '1');
        if (self.el) self.el.insertBefore(styleEl, self.el.firstChild);
      }
      var cssChunks = [];
      var cssVars = self.opts.css;
      if (cssVars && typeof cssVars === 'object') {
        var lines = [];
        for (var k in cssVars) {
          if (cssVars.hasOwnProperty(k)) lines.push('  ' + k + ': ' + cssVars[k] + ';');
        }
        if (lines.length > 0) cssChunks.push('.wcw-widget { ' + lines.join(' ') + ' }');
      }
      if (cssText) cssChunks.push(cssText);
      styleEl.textContent = cssChunks.join('\n');
    };

    /** 运行时覆盖主题 */
    this.setTheme = function(theme) {
      self.opts.theme = theme;
      if (self.el) {
        self.el.classList.remove('wcw-light', 'wcw-dark');
        self.el.classList.add(theme === 'light' ? 'wcw-light' : 'wcw-dark');
      }
    };
  }

  // ==================== 全局注册 ====================

  window.WebChatWidget = WebChatWidget;

  // 如果配置了自动初始化（data-wcw 属性），自动创建实例
  document.addEventListener('DOMContentLoaded', function() {
    var autoEls = document.querySelectorAll('[data-wcw-auto]');
    autoEls.forEach(function(el) {
      new WebChatWidget({
        container: el,
        sessionKey: el.getAttribute('data-wcw-session') || '',
        wsUrl: el.getAttribute('data-wcw-url') || '',
        token: el.getAttribute('data-wcw-token') || '',
        theme: el.getAttribute('data-wcw-theme') || 'dark',
        title: el.getAttribute('data-wcw-title') || 'AI Chat'
      }).open();
    });
  });

})();
// ==EndWebChatWidgetSDK==
`.trim();
}
