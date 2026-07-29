export function getWebchatPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>OpenClaw Web Chat</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --surface2: #0f3460;
  --accent: #e94560;
  --text: #eaeaea;
  --text-dim: #8892b0;
  --code-bg: #0d1117;
  --user-msg: #0f3460;
  --ai-msg: #16213e;
  --border: #2a2a4a;
  --input-bg: #16213e;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
header h1 { font-size: 16px; font-weight: 600; color: var(--accent); }
header .status { font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
header .sk-bar { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); flex-shrink: 0; }
header .sk-bar input {
  background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); padding: 4px 8px; font-size: 12px; width: 220px; outline: none; font-family: monospace;
}
header .sk-bar input:focus { border-color: var(--accent); }
header .sk-bar input::placeholder { color: var(--text-dim); opacity: .5; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.green { background: #4caf50; }
.dot.gray { background: #666; }
#messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
#messages::-webkit-scrollbar { width: 6px; }
#messages::-webkit-scrollbar-track { background: transparent; }
#messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; line-height: 1.6; word-break: break-word; }
.msg.user { align-self: flex-end; background: var(--user-msg); border-bottom-right-radius: 4px; }
.msg.ai { align-self: flex-start; background: var(--ai-msg); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.msg.ai.streaming { border-color: var(--accent); }
.msg .content { white-space: pre-wrap; font-size: 14px; }
.msg .content code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
.msg .content pre { background: var(--code-bg); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.msg .content pre code { background: none; padding: 0; }
.msg.ai .meta { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.welcome { text-align: center; color: var(--text-dim); margin: 40px 0; font-size: 14px; }
.welcome h2 { font-size: 20px; color: var(--accent); margin-bottom: 8px; }
#input-area {
  flex-shrink: 0;
  padding: 12px 20px 16px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  display: flex;
  gap: 10px;
}
#input-area textarea {
  flex: 1;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  min-height: 44px;
  max-height: 120px;
  outline: none;
  transition: border-color .2s;
}
#input-area textarea:focus { border-color: var(--accent); }
#input-area button {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity .2s;
}
#input-area button:hover { opacity: .9; }
#input-area button:disabled { opacity: .5; cursor: not-allowed; }
.typing-indicator { display: flex; gap: 4px; padding: 8px 14px; }
.typing-indicator span { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); animation: typing 1.4s infinite ease-in-out; }
.typing-indicator span:nth-child(2) { animation-delay: .2s; }
.typing-indicator span:nth-child(3) { animation-delay: .4s; }
@keyframes typing { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }
</style>
</head>
<body>
<header>
  <h1>OpenClaw Web Chat</h1>
  <div class="sk-bar"><span>sessionKey:</span><input id="sk-input" type="text" placeholder="留空则自动生成" /></div>
  <div class="status"><span class="dot" id="status-dot"></span><span id="status-text">connecting...</span></div>
</header>
<div id="messages">
  <div class="welcome">
    <h2>OpenClaw AI Chat</h2>
    <p>在下方输入消息开始对话</p>
  </div>
</div>
<div id="input-area">
  <textarea id="input" placeholder="输入消息... (Shift+Enter 换行, Enter 发送)" rows="1"></textarea>
  <button id="send-btn" onclick="sendMessage()">发送</button>
</div>
<script>
const HOST = location.host || 'localhost:3210';
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
let ws = null;
let currentStreamMsg = null;
let isStreaming = false;
let reconnectTimer = null;
let connectAttempt = 0;

function setStatus(connected) {
  statusDot.className = 'dot ' + (connected ? 'green' : 'gray');
  statusText.textContent = connected ? 'connected' : (connectAttempt > 1 ? 'reconnecting...' : 'disconnected');
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  connectAttempt++;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams(location.search);
  const sk = params.get('sessionKey');
  const qs = sk ? '?sessionKey=' + encodeURIComponent(sk) : '';
  const url = proto + '//' + HOST + qs;
  console.log('[webchat] Connecting to:', url, 'attempt:', connectAttempt);

  const skInput = document.getElementById('sk-input');
  if (skInput) {
    skInput.value = sk || '';
    skInput.addEventListener('change', function() {
      const val = skInput.value.trim();
      const newParams = new URLSearchParams(location.search);
      if (val) {
        newParams.set('sessionKey', val);
      } else {
        newParams.delete('sessionKey');
      }
      const newUrl = location.pathname + (newParams.toString() ? '?' + newParams.toString() : '');
      history.replaceState(null, '', newUrl);
      addSystemMsg('sessionKey 将在下次发送消息时生效: ' + (val || '(自动生成)'));
    });
  }
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[webchat] WebSocket constructor error:', err);
    setStatus(false);
    addSystemMsg('WebSocket 创建失败: ' + err.message, true);
    return;
  }
  let openTimeout = setTimeout(function() {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.warn('[webchat] Connection timeout (10s), closing...');
      ws.close();
      setStatus(false);
    }
  }, 10000);
  ws.onopen = function() {
    clearTimeout(openTimeout);
    console.log('[webchat] Connected!');
    setStatus(true);
    connectAttempt = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  ws.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      handleMessage(data);
    } catch (err) {
      console.error('[webchat] JSON parse error:', err);
    }
  };
  ws.onclose = function(event) {
    clearTimeout(openTimeout);
    console.log('[webchat] Disconnected, code:', event.code, 'reason:', event.reason);
    setStatus(false);
    if (!reconnectTimer) reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = function(err) {
    clearTimeout(openTimeout);
    console.error('[webchat] WebSocket error:', err);
    setStatus(false);
  };
}

function handleMessage(data) {
  switch (data.type) {
    case 'connected':
      var w = document.querySelector('.welcome');
      if (w) w.remove();
      var runtimeStatus = data.runtimeReady === true ? 'Runtime OK' : '\u26a0\ufe0f Runtime not ready (dispatch API unavailable)';
      addSystemMsg('已连接 \u2014 ' + (data.sessionKey || 'session') + ' \u2014 ' + runtimeStatus);
      if (data.sessionKey) {
        var skInput = document.getElementById('sk-input');
        if (skInput) skInput.value = data.sessionKey;
        var newParams = new URLSearchParams(location.search);
        newParams.set('sessionKey', data.sessionKey);
        var newUrl = location.pathname + '?' + newParams.toString();
        history.replaceState(null, '', newUrl);
      }
      if (data.css && typeof data.css === 'object') {
        var root = document.documentElement;
        for (var k in data.css) {
          if (data.css.hasOwnProperty(k)) root.style.setProperty(k, data.css[k]);
        }
      }
      if (data.cssText) {
        var s = document.createElement('style');
        s.textContent = data.cssText;
        document.head.appendChild(s);
      }
      // 连接后拉取历史消息
      var historySk = data.sessionKey || (skInput && skInput.value) || sk;
      if (historySk) {
        ws.send(JSON.stringify({ type: 'history', sessionKey: historySk }));
      }
      break;
    case 'streaming':
      if (isStreaming && currentStreamMsg) {
        currentStreamMsg.querySelector('.content').innerHTML = renderMarkdown(data.text || '');
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        isStreaming = true;
        currentStreamMsg = addMsg('ai', data.text || '');
        currentStreamMsg.classList.add('streaming');
      }
      break;
    case 'reply':
      if (currentStreamMsg) {
        currentStreamMsg.classList.remove('streaming');
        currentStreamMsg.querySelector('.content').innerHTML = renderMarkdown(data.text || '');
        currentStreamMsg = null;
      } else {
        addMsg('ai', data.text || '');
      }
      isStreaming = false;
      sendBtn.disabled = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case 'idle':
      if (currentStreamMsg) {
        currentStreamMsg.classList.remove('streaming');
        currentStreamMsg = null;
      }
      isStreaming = false;
      sendBtn.disabled = false;
      inputEl.focus();
      break;
      sendBtn.disabled = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case 'history':
      // 服务器返回的历史消息
      if (data.messages && Array.isArray(data.messages)) {
        var msgs = messagesEl.querySelectorAll('.msg');
        msgs.forEach(function(m) { m.remove(); });
        data.messages.forEach(function(msg) {
          var role = msg.role === 'user' ? 'user' : 'ai';
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
                content += (content ? '\n' : '') + '[result: ' + (typeof tr === 'string' ? (tr.length > 200 ? tr.slice(0, 200) + '...' : tr) : '...') + ']';
              }
            }
          }
          if (content) addMsg(role, content);
        });
        var w2 = document.querySelector('.welcome');
        if (w2) w2.remove();
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      break;
    case 'error':
      addSystemMsg('❌ Error: ' + (data.text || 'unknown'), true);
      isStreaming = false;
      if (currentStreamMsg) {
        currentStreamMsg.classList.remove('streaming');
        currentStreamMsg = null;
      }
      sendBtn.disabled = false;
      break;
    case 'debug':
      addSystemMsg('🔍 ' + (data.text || ''), false);
      break;
    case 'shutdown':
      addSystemMsg('\u670d\u52a1\u5668\u6b63\u5728\u5173\u95ed...', true);
      setStatus(false);
      break;
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = '<div class="content">' + renderMarkdown(text) + '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addSystemMsg(text, isError) {
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;font-size:12px;color:' + (isError ? 'var(--accent)' : 'var(--text-dim)') + ';padding:4px;';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text) {
  if (!text) return '';
  return escapeHtml(text);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function applyConfig(cfg) {
  if (!cfg || !cfg.ok) return;
  // 应用 CSS 变量
  if (cfg.css && typeof cfg.css === 'object') {
    var root = document.documentElement;
    for (var k in cfg.css) {
      if (cfg.css.hasOwnProperty(k)) root.style.setProperty(k, cfg.css[k]);
    }
  }
  // 应用完整 CSS
  if (cfg.cssText) {
    var s = document.createElement('style');
    s.textContent = cfg.cssText;
    document.head.appendChild(s);
  }
  // 应用标题
  if (cfg.title) {
    var h1 = document.querySelector('header h1');
    if (h1) h1.textContent = cfg.title;
    document.title = cfg.title;
  }
  // 应用占位符
  if (cfg.placeholder) {
    var inp = document.getElementById('input');
    if (inp) inp.placeholder = cfg.placeholder;
  }
}

// 页面加载时获取配置
fetch('/config').then(function(r) { return r.json(); }).then(applyConfig).catch(function() {});

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const w = document.querySelector('.welcome');
  if (w) w.remove();
  addMsg('user', text);
  const payload = { type: 'message', text: text };
  const sk = document.getElementById('sk-input');
  if (sk && sk.value.trim()) {
    payload.sessionKey = sk.value.trim();
  }
  ws.send(JSON.stringify(payload));
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;
  isStreaming = false;
  currentStreamMsg = null;
}

inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', function() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

connect();
</script>
</body>
</html>`;
}