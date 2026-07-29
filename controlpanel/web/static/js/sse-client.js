/**
 * SSE客户端模块 - CoordClaw Web
 * 实现SSE实时推送 + 轮询降级 + 自动重连
 */

const SSEClient = (function() {
    'use strict';

    // 配置
    const CONFIG = {
        SSE_URL: '/api/sse-stream',
        POLL_URL: '/api/messages',
        POLL_INTERVAL: 5000,
        RECONNECT_DELAY: 5000,
        MAX_RECONNECT: 10,
        RECOVERY_INTERVAL: 30000 // 轮询模式下每隔30秒尝试恢复SSE
    };

    // 状态
    let state = {
        eventSource: null,
        pollTimer: null,
        recoveryTimer: null,
        heartbeatTimer: null,  // 心跳超时看门狗
        reconnectCount: 0,
        mode: 'sse',
        lastMessageId: null,
        listeners: {}
    };

    // 事件发射器
    function emit(event, data) {
        if (state.listeners[event]) {
            state.listeners[event].forEach(cb => cb(data));
        }
    }

    // 监听事件
    function on(event, callback) {
        if (!state.listeners[event]) state.listeners[event] = [];
        state.listeners[event].push(callback);
    }

    // 切换到轮询模式
    function switchToPoll() {
        if (state.mode === 'poll') return;
        console.warn('[SSE] 降级到轮询模式');
        state.mode = 'poll';
        emit('modechange', 'poll');
        if (state.eventSource) {
            state.eventSource.close();
            state.eventSource = null;
        }
        startPolling();
        startSSERecovery();
    }

    // 轮询模式下定期尝试恢复SSE连接
    function startSSERecovery() {
        clearInterval(state.recoveryTimer);
        state.recoveryTimer = setInterval(() => {
            if (state.mode !== 'poll') {
                clearInterval(state.recoveryTimer);
                return;
            }
            console.log('[SSE] 尝试恢复SSE连接...');
            connectSSE();
        }, CONFIG.RECOVERY_INTERVAL);
    }

    // 轮询
    function startPolling() {
        clearInterval(state.pollTimer);
        state.pollTimer = setInterval(async () => {
            try {
                const resp = await fetch(CONFIG.POLL_URL + '?limit=20');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                if (data.messages && data.messages.length) {
                    emit('messages_sync', data.messages);
                    data.messages.forEach(msg => {
                        if (!state.lastMessageId || msg.id > state.lastMessageId) {
                            state.lastMessageId = msg.id;
                        }
                    });
                }
            } catch (e) {
                console.error('[Poll] 获取失败:', e.message);
            }
        }, CONFIG.POLL_INTERVAL);
    }

    // 连接SSE
    function connectSSE() {
        if (state.eventSource) state.eventSource.close();
        clearTimeout(state.heartbeatTimer);
        const es = new EventSource(CONFIG.SSE_URL);
        state.eventSource = es;

        es.onopen = () => {
            console.log('[SSE] 连接成功');
            state.reconnectCount = 0;
            // 如果从轮询模式恢复，停止轮询和恢复定时器
            if (state.mode === 'poll') {
                clearInterval(state.pollTimer);
                clearInterval(state.recoveryTimer);
                state.mode = 'sse';
                emit('modechange', 'sse');
                console.log('[SSE] 已从轮询模式恢复到SSE');
            }
            emit('connected', null);
        };

        es.addEventListener('messages_sync', (e) => {
            try {
                const messages = JSON.parse(e.data);
                if (Array.isArray(messages) && messages.length > 0) {
                    emit('messages_sync', messages);
                }
            } catch (err) {
                console.error('[SSE] 解析 messages_sync 失败:', err);
            }
        });

        es.addEventListener('config_changed', (e) => {
            try {
                emit('configchanged', JSON.parse(e.data));
            } catch (err) {
                console.error('[SSE] 解析失败:', err);
            }
        });

        es.addEventListener('team_changed', (e) => {
            emit('teamchanged', e.data ? JSON.parse(e.data) : {});
        });

        es.addEventListener('project_switched', (e) => {
            try {
                emit('projectswitched', JSON.parse(e.data));
            } catch (err) {
                console.error('[SSE] 解析失败:', err);
            }
        });

        es.addEventListener('heartbeat', () => {
            // 重置空闲超时看门狗
            clearTimeout(state.heartbeatTimer);
            state.heartbeatTimer = setTimeout(() => {
                console.warn('[SSE] 心跳超时，主动重连');
                es.close();
                if (state.reconnectCount < CONFIG.MAX_RECONNECT) {
                    state.reconnectCount++;
                    connectSSE();
                } else {
                    switchToPoll();
                }
            }, 60000);  // 2倍心跳间隔
            emit('heartbeat', null);
        });

        es.addEventListener('team_create_progress', (e) => {
            try { emit('team_create_progress', JSON.parse(e.data)); }
            catch { emit('team_create_progress', e.data); }
        });

        es.addEventListener('member_status', (e) => {
            try { emit('member_status', JSON.parse(e.data)); }
            catch { emit('member_status', e.data); }
        });
        es.addEventListener('gateway_offline', (e) => {
            try { emit('gateway_offline', JSON.parse(e.data)); }
            catch { emit('gateway_offline', { reason: 'offline' }); }
        });
        es.addEventListener('gateway_online', () => {
            emit('gateway_online', {});
        });
        es.addEventListener('models_changed', (e) => {
            try { emit('models_changed', JSON.parse(e.data)); }
            catch { emit('models_changed', {}); }
        });

        es.addEventListener('token_stats_updated', (e) => {
            try { emit('token_stats_updated', JSON.parse(e.data)); }
            catch (err) { console.error('[SSE] 解析 token_stats_updated 失败:', err); }
        });

        es.onerror = (err) => {
            console.error('[SSE] 错误:', err);
            clearTimeout(state.heartbeatTimer);
            es.close();
            if (state.reconnectCount < CONFIG.MAX_RECONNECT) {
                state.reconnectCount++;
                emit('reconnecting', state.reconnectCount);
                setTimeout(connectSSE, CONFIG.RECONNECT_DELAY);
            } else {
                console.warn('[SSE] 重连次数超限，切换轮询');
                switchToPoll();
            }
        };
    }

    // 初始化
    function init() {
        connectSSE();
        return {
            on,
            getMode: () => state.mode,
            pausePoll: () => { clearInterval(state.pollTimer); },
            resumePoll: () => { if (state.mode === 'poll') startPolling(); },
            destroy: () => {
                if (state.eventSource) state.eventSource.close();
                clearInterval(state.pollTimer);
                clearInterval(state.recoveryTimer);
            }
        };
    }

    return { init, on };
})();