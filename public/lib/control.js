import {
  CONTROL_CLIENT_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  State,
  setActionButtonsEnabled,
  setSessionOffset,
  wsUrl
} from './state.js';

export function createControl({ term, sessionTabs, statusBar, toast, actions }) {
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
        actions.resetKillConfirm();
        void term.connect(payload.sessionId, { replayFrom: 0, cwd: payload.cwd });
        term.scheduleResize();
        const cli = payload.cli || 'shell';
        statusBar.setText(`已启动 ${cli}`);
        toast.show(`已启动 ${cli}，会话已附加`, 'success');
        if (!State.pushAutoRequested && !State.pushRegistered && 'Notification' in window) {
          State.pushAutoRequested = true;
          void actions
            .requestPush({
              silentPermissionDenied: true,
              silentFailure: true,
              showSuccessToast: false
            })
            .catch(() => {});
        }
        return;
      }

      if (payload.type === 'exited' && payload.sessionId) {
        const exitedSessionId = payload.sessionId;
        const isCurrentSession = exitedSessionId === State.currentSessionId;
        if (typeof term.handleSessionExit === 'function') {
          term.handleSessionExit(exitedSessionId);
        }
        if (!isCurrentSession) {
          return;
        }
        const code = Number.isFinite(payload.exitCode) ? payload.exitCode : Number(payload.exitCode) || 0;
        statusBar.setText(`会话已退出 (code=${code})`);
        if (State.killRequested) {
          toast.show('会话已终止', 'warn');
        } else {
          toast.show(`会话已退出 (code=${code})`, code === 0 ? 'info' : 'danger');
        }
        delete State.sessionOffsets[exitedSessionId];
        State.currentSessionId = '';
        State.killRequested = false;
        actions.resetKillRequest();
        statusBar.setSession('');
        setActionButtonsEnabled(false);
        actions.resetKillConfirm();
        term.disconnect();
        return;
      }

      if (payload.type === 'sessions' && Array.isArray(payload.list)) {
        const isFirstSessionsMessage = !State.initialSessionsReceived;
        State.initialSessionsReceived = true;
        const sessions = sessionTabs.update(payload.list);

        if (State.currentSessionId) {
          const activeSession = sessions.find((item) => item.id === State.currentSessionId);
          if (!activeSession) {
            State.currentSessionId = '';
            State.killRequested = false;
            actions.resetKillRequest();
            statusBar.setSession('');
            setActionButtonsEnabled(false);
            actions.resetKillConfirm();
            term.disconnect();
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
              void term.reconnect(activeSession.id);
              term.scheduleResize();
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
          actions.resetKillConfirm();
          void term.reconnect(latest.id);
          term.scheduleResize();
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
        if (navigator.clipboard && navigator.clipboard.writeText) {
          void navigator.clipboard.writeText(payload.text).catch(() => {});
        }
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
      State.reconnectTimer = window.setTimeout(() => {
        State.reconnectTimer = 0;
        this.connect();
        State.reconnectDelayMs = Math.min(State.reconnectDelayMs * 2, 20000);
      }, State.reconnectDelayMs);
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
        statusBar.setText('缺少 token，请使用 #token=... 打开');
        return;
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
        State.controlConnected = true;
        statusBar.setControl('online');
        statusBar.setText('控制通道已连接');
        socket.send(
          JSON.stringify({
            type: 'hello',
            version: CONTROL_PROTOCOL_VERSION,
            capabilities: CONTROL_CLIENT_CAPABILITIES
          })
        );
      };

      socket.onmessage = (event) => {
        this.handleMessage(event);
      };

      socket.onclose = () => {
        if (State.controlSocket !== socket) {
          return;
        }
        State.controlSocket = null;
        State.controlConnected = false;
        State.serverCapabilities = [];
        statusBar.setControl('warn');
        statusBar.setText('连接断开，正在重连...');
        toast.show('连接断开，正在重连...', 'warn');
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    }
  };
}
