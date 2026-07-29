/**
 * WebChat Widget - CSS 样式
 *
 * 功能24: 可嵌入聊天的样式表，支持 light/dark 双主题
 */

export function getWidgetCss(): string {
  return `
/* ==WebChatWidgetCSS== */

/* ====== 变量 ====== */
.wcw-widget.wcw-dark {
  --wcw-bg: #1a1a2e;
  --wcw-surface: #16213e;
  --wcw-accent: #e94560;
  --wcw-text: #eaeaea;
  --wcw-text-dim: #8892b0;
  --wcw-border: #2a2a4a;
  --wcw-user-bg: #0f3460;
  --wcw-ai-bg: #16213e;
  --wcw-input-bg: #16213e;
  --wcw-code-bg: #0d1117;
}

.wcw-widget.wcw-light {
  --wcw-bg: #f5f5f5;
  --wcw-surface: #ffffff;
  --wcw-accent: #c62828;
  --wcw-text: #1a1a2e;
  --wcw-text-dim: #666;
  --wcw-border: #ddd;
  --wcw-user-bg: #e3f2fd;
  --wcw-ai-bg: #fafafa;
  --wcw-input-bg: #fff;
  --wcw-code-bg: #f0f0f0;
}

/* ====== 容器 ====== */
.wcw-widget {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--wcw-bg);
  color: var(--wcw-text);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wcw-border);
  border-radius: 8px;
  overflow: hidden;
  /* 外部控制尺寸 */
  width: 100%;
  height: 100%;
  min-height: 200px;
  max-height: 600px;
}

/* ====== 头部 ====== */
.wcw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--wcw-surface);
  border-bottom: 1px solid var(--wcw-border);
  flex-shrink: 0;
}
.wcw-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wcw-accent);
}
.wcw-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--wcw-text-dim);
}

/* ====== 状态指示点 ====== */
.wcw-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.wcw-dot-green { background: #4caf50; box-shadow: 0 0 4px rgba(76,175,80,.5); }
.wcw-dot-red   { background: #f44336; }
.wcw-dot-gray  { background: #666; }

/* ====== 消息区域 ====== */
.wcw-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}
.wcw-messages::-webkit-scrollbar { width: 4px; }
.wcw-messages::-webkit-scrollbar-track { background: transparent; }
.wcw-messages::-webkit-scrollbar-thumb { background: var(--wcw-border); border-radius: 2px; }

/* ====== 消息气泡 ====== */
.wcw-msg {
  max-width: 90%;
  padding: 8px 11px;
  border-radius: 10px;
  line-height: 1.55;
  word-break: break-word;
  font-size: 13px;
}
.wcw-msg-user {
  align-self: flex-end;
  background: var(--wcw-user-bg);
  border-bottom-right-radius: 3px;
}
.wcw-msg-ai {
  align-self: flex-start;
  background: var(--wcw-ai-bg);
  border: 1px solid var(--wcw-border);
  border-bottom-left-radius: 3px;
}
.wcw-msg-system {
  align-self: center;
  background: transparent;
  color: var(--wcw-text-dim);
  font-size: 11px;
  text-align: center;
  padding: 4px 8px;
}
.wcw-msg .wcw-content { white-space: pre-wrap; }
.wcw-msg .wcw-content code {
  background: var(--wcw-code-bg);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.wcw-msg .wcw-meta {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: var(--wcw-text-dim);
}

/* ====== 输入区域 ====== */
.wcw-input-area {
  display: flex;
  gap: 8px;
  padding: 8px 12px 10px;
  background: var(--wcw-surface);
  border-top: 1px solid var(--wcw-border);
  flex-shrink: 0;
  align-items: flex-end;
}
.wcw-input {
  flex: 1;
  background: var(--wcw-input-bg);
  border: 1px solid var(--wcw-border);
  border-radius: 6px;
  padding: 7px 10px;
  color: var(--wcw-text);
  font-size: 13px;
  font-family: inherit;
  resize: none;
  outline: none;
  transition: border-color .15s;
  max-height: 100px;
  overflow-y: auto;
  line-height: 1.45;
}
.wcw-input:focus { border-color: var(--wcw-accent); }
.wcw-input::placeholder { color: var(--wcw-text-dim); opacity: .7; }

.wcw-send-btn {
  padding: 7px 14px;
  background: var(--wcw-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: opacity .15s;
}
.wcw-send-btn:hover { opacity: .85; }
.wcw-send-btn:active { opacity: .7; }

/* ====== 空状态 ====== */
.wcw-empty {
  text-align: center;
  color: var(--wcw-text-dim);
  padding: 30px 10px;
  font-size: 13px;
}

/* ==EndWebChatWidgetCSS==
`.trim();
}
