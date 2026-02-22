import {
  clearPersistedAccessToken,
  CONTROL_CLIENT_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  State,
  TERMINAL_REPLAY_TAIL_BYTES,
  createWsAuthMessage,
  fetchSessionReplayOffset,
  fetchSessionLogBytes,
  getSessionOffset,
  persistTokenExpiry,
  setActionButtonsEnabled,
  setSessionOffset,
  wsUrl
} from './state.js';
import { writeClipboardText } from './clipboard.js';
import { bootstrapSessionReplayOffset } from './session-replay-offset-policy.js';

function withReconnectJitter(baseDelayMs) {
  const safeBase = Math.max(300, Math.floor(baseDelayMs));
  const jitter = Math.round(safeBase * ((Math.random() * 0.4) - 0.2));
  return Math.max(300, safeBase + jitter);
}

async function reconnectSessionWithBootstrappedOffset(term, sessionId) {
  if (!sessionId) {
    return;
  }
  await bootstrapSessionReplayOffset(sessionId, {
    getSessionOffset,
    setSessionOffset,
    fetchSessionReplayOffset,
    fetchSessionLogBytes,
    replayTailBytes: TERMINAL_REPLAY_TAIL_BYTES
  });
  await term.reconnect(sessionId);
}

export function createControl({ term, sessionTabs, statusBar, toast, actions, qualityMonitor }) {
  return {
    send(payload) {
      if (!State.controlSocket || State.controlSocket.readyState !== WebSocket.OPEN) {
        return false;
      }
      State.controlSocket.send(JSON.stringify(payload));
      return true;
    },

    handleMessage(event) {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        statusBar.setText('控制消息解析失败');
        toast.show('控制消息解析失败', 'danger');
        return;
      }

      if (payload.type === 'hello') {
        State.serverCapabilities = Array.isArray(payload.capabilities)
          ? payload.capabilities.filter((entry) => typeof entry === 'string')
          : [];
        return;
      }

      if (payload.type === 'auth.ok') {
        State.controlConnected = true;
        if (typeof payload.expiresAt === 'string' && payload.expiresAt) {
          State.tokenExpiresAt = payload.expiresAt;
          persistTokenExpiry(payload.expiresAt);
        }
        statusBar.setControl('online');
        statusBar.setText('控制通道已鉴权');
        if (qualityMonitor && typeof qualityMonitor.onControlReady === 'function') {
          qualityMonitor.onControlReady();
        }
        if (State.controlSocket && State.controlSocket.readyState === WebSocket.OPEN) {
          State.controlSocket.send(
            JSON.stringify({
              type: 'hello',
              version: CONTROL_PROTOCOL_VERSION,
              capabilities: CONTROL_CLIENT_CAPABILITIES
            })
          );
        }
        return;
      }

      if (payload.type === 'heartbeat.pong') {
        if (qualityMonitor && typeof qualityMonitor.onPong === 'function') {
          qualityMonitor.onPong(payload);
        }
        return;
      }

      if (payload.type === 'spawned' && payload.sessionId) {
        State.currentSessionId = payload.sessionId;
        State.killRequested = false;
        actions.resetKillRequest();
        setSessionOffset(payload.sessionId, 0);
        if (typeof payload.cwd === 'string' && payload.cwd) {
          State.cwd = payload.cwd;
          statusBar.setCwd(payload.cwd);
        }
        statusBar.setSession(payload.sessionId);
        statusBar.setTerminal('warn');
        setActionButtonsEnabled(true);
        void term.connect(payload.sessionId, { replayFrom: 0, cwd: payload.cwd });
        term.scheduleResize();
        const cli = payload.cli || 'shell';
        statusBar.setText(`已启动 ${cli}`);
        toast.show(`已启动 ${cli}，会话已附加`, 'success');
        return;
      }

      if (payload.type === 'exited' && payload.sessionId) {
        const exitedSessionId = payload.sessionId;
        const isCurrentSession = exitedSessionId === State.currentSessionId;
        if (typeof term.handleSessionExit === 'function') {
          term.handleSessionExit(exitedSessionId);
        }
        if (State.killInFlight && State.killTargetSessionId === exitedSessionId) {
          State.killRequested = false;
          actions.resetKillRequest();
          setActionButtonsEnabled(!!State.currentSessionId && !State.killInFlight);
        }
        if (!isCurrentSession) {
          return;
        }
        const code = Number.isFinite(payload.exitCode) ? payload.exitCode : Number(payload.exitCode) || 0;
        if (State.killRequested) {
          statusBar.setText('会话已关闭');
          toast.show('会话已关闭', 'warn');
        } else {
          statusBar.setText(`会话已退出 (code=${code})`);
          toast.show(`会话已退出 (code=${code})`, code === 0 ? 'info' : 'danger');
        }
        delete State.sessionOffsets[exitedSessionId];
        State.killRequested = false;
        actions.resetKillRequest();
        if (!State.currentSessionId || State.currentSessionId === exitedSessionId) {
          State.currentSessionId = '';
          statusBar.setSession('');
        }
        setActionButtonsEnabled(!!State.currentSessionId && !State.killInFlight);
        return;
      }

      if (payload.type === 'sessions' && Array.isArray(payload.list)) {
        const isFirstSessionsMessage = !State.initialSessionsReceived;
        State.initialSessionsReceived = true;
        const sessions = sessionTabs.update(payload.list);

        if (State.currentSessionId) {
          const activeSession = sessions.find((item) => item.id === State.currentSessionId);
          if (!activeSession) {
            const missingSessionId = State.currentSessionId;
            State.currentSessionId = '';
            State.killRequested = false;
            actions.resetKillRequest();
            statusBar.setSession('');
            setActionButtonsEnabled(false);
            if (typeof term.handleSessionExit === 'function') {
              term.handleSessionExit(missingSessionId);
            } else {
              term.disconnect();
            }
          } else {
            if (activeSession.cwd) {
              State.cwd = activeSession.cwd;
              statusBar.setCwd(activeSession.cwd);
            }
            const canReconnect =
              !State.terminalConnected &&
              (!State.terminalSocket || State.terminalSocket.readyState === WebSocket.CLOSED) &&
              !State.terminalReconnectTimer;
            if (canReconnect) {
              void reconnectSessionWithBootstrappedOffset(term, activeSession.id).finally(() => {
                term.scheduleResize();
              });
            }
          }
        } else if (sessions.length > 0 && isFirstSessionsMessage) {
          const latest = sessions[sessions.length - 1];
          State.currentSessionId = latest.id;
          State.killRequested = false;
          actions.resetKillRequest();
          statusBar.setSession(latest.id);
          if (latest.cwd) {
            State.cwd = latest.cwd;
            statusBar.setCwd(latest.cwd);
          }
          setActionButtonsEnabled(true);
          void reconnectSessionWithBootstrappedOffset(term, latest.id).finally(() => {
            term.scheduleResize();
          });
        } else if (sessions.length > 0) {
          setActionButtonsEnabled(false);
        } else if (isFirstSessionsMessage) {
          actions.spawn();
        } else {
          setActionButtonsEnabled(false);
        }

        sessionTabs.renderActiveState();
        return;
      }

      if (
        payload.type === 'clipboard' &&
        typeof payload.sessionId === 'string' &&
        typeof payload.text === 'string' &&
        payload.text
      ) {
        void writeClipboardText(payload.text);
        return;
      }

      if (payload.type === 'error') {
        const message = payload.message || '控制通道错误';
        statusBar.setText(message);
        toast.show(message, 'danger');
      }
    },

    scheduleReconnect() {
      if (State.reconnectTimer) {
        window.clearTimeout(State.reconnectTimer);
      }
      const baseDelay = Math.max(1000, State.reconnectDelayMs);
      const delay = withReconnectJitter(baseDelay);
      State.reconnectTimer = window.setTimeout(() => {
        State.reconnectTimer = 0;
        this.connect();
        State.reconnectDelayMs = Math.min(baseDelay * 2, 30000);
      }, delay);
    },

    reconnectNow() {
      if (State.reconnectTimer) {
        window.clearTimeout(State.reconnectTimer);
        State.reconnectTimer = 0;
      }
      this.connect();
    },

    connect() {
      if (!State.token) {
        statusBar.setControl('offline');
        return false;
      }
      if (
        State.controlSocket &&
        (State.controlSocket.readyState === WebSocket.OPEN ||
          State.controlSocket.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      statusBar.setControl('warn');
      statusBar.setText('正在连接控制通道...');
      const socket = new WebSocket(wsUrl('/ws/control'));
      State.controlSocket = socket;

      socket.onopen = () => {
        if (State.controlSocket !== socket) {
          return;
        }
        State.reconnectDelayMs = 1000;
        State.controlConnected = false;
        statusBar.setControl('warn');
        statusBar.setText('控制通道鉴权中...');
        socket.send(createWsAuthMessage());
      };

      socket.onmessage = (event) => {
        this.handleMessage(event);
      };

      socket.onclose = (event) => {
        if (State.controlSocket !== socket) {
          return;
        }
        State.controlSocket = null;
        State.controlConnected = false;
        State.serverCapabilities = [];
        if (qualityMonitor && typeof qualityMonitor.onControlClosed === 'function') {
          qualityMonitor.onControlClosed();
        }
        if (event.code === 4401) {
          if (State.tokenWarningTimer) {
            window.clearTimeout(State.tokenWarningTimer);
            State.tokenWarningTimer = 0;
          }
          if (State.tokenRefreshTimer) {
            window.clearTimeout(State.tokenRefreshTimer);
            State.tokenRefreshTimer = 0;
          }
          clearPersistedAccessToken();
          State.token = '';
          State.tokenExpiresAt = '';
          statusBar.setControl('offline');
          statusBar.setText('访问令牌无效，请重新使用 #token 链接登录');
          toast.show('认证已失效，请重新登录', 'danger');
          return;
        }
        statusBar.setControl('warn');
        statusBar.setText('控制通道已断开，正在自动重连（可等待重连，或刷新页面并检查网络）');
        toast.show('控制通道已断开，正在自动重连；可刷新页面并检查网络', 'warn');
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    }
  };
}
