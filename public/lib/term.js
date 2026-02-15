import {
  CAPABILITY_TERMINAL_BINARY_V1,
  DOM,
  FitAddonCtor,
  RESIZE_DEBOUNCE_MS,
  State,
  TERMINAL_BINARY_CODEC,
  TERMINAL_INPUT_BATCH_CHARS,
  TERMINAL_INPUT_DIRECT_CHARS,
  TERMINAL_FRAME_TYPE_INPUT,
  TERMINAL_FRAME_TYPE_OUTPUT,
  TERMINAL_REPLAY_TAIL_BYTES,
  TERMINAL_WRITE_HIGH_WATER_BYTES,
  TERMINAL_WRITE_LOW_WATER_BYTES,
  TerminalCtor,
  WebglAddonCtor,
  addSessionOffset,
  decodeTerminalFrame,
  encodeTerminalFrame,
  fetchSessionLogBytes,
  getSessionOffset,
  setSessionOffset,
  shortenSessionId,
  textDecoder,
  textEncoder,
  wsUrl
} from './state.js';

export function createTerm({ getControl, statusBar, toast }) {
  return {
    init() {
      if (!TerminalCtor || !FitAddonCtor || !DOM.terminalRoot) {
        statusBar.setText('xterm.js 本地资源加载失败');
        toast.show('xterm.js 本地资源加载失败', 'danger');
        return;
      }

      State.terminal = new TerminalCtor({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'IBM Plex Mono, Menlo, Consolas, monospace',
        fontSize: 14,
        theme: {
          background: '#090b14',
          foreground: '#f0f2f8'
        }
      });

      State.fitAddon = new FitAddonCtor();
      State.terminal.loadAddon(State.fitAddon);
      State.terminal.open(DOM.terminalRoot);
      State.fitAddon.fit();

      if (WebglAddonCtor) {
        try {
          State.webglAddon = new WebglAddonCtor();
          State.terminal.loadAddon(State.webglAddon);
          if (State.webglAddon && typeof State.webglAddon.onContextLoss === 'function') {
            State.webglAddon.onContextLoss(() => {
              toast.show('WebGL 上下文丢失，已回退默认渲染', 'warn');
              if (State.webglAddon && typeof State.webglAddon.dispose === 'function') {
                State.webglAddon.dispose();
              }
              State.webglAddon = null;
            });
          }
        } catch {
          State.webglAddon = null;
        }
      }

      this.bindResizeSources();
      this.scheduleResize();
    },

    bindResizeSources() {
      if (window.ResizeObserver && DOM.terminalWrap) {
        State.resizeObserver = new ResizeObserver(() => {
          this.scheduleResize();
        });
        State.resizeObserver.observe(DOM.terminalWrap);
      }
      window.addEventListener(
        'resize',
        () => {
          this.scheduleResize();
        },
        { passive: true }
      );
    },

    scheduleResize(force = false) {
      if (!State.terminal || !State.fitAddon) {
        return;
      }
      if (State.zoomActive && !force) {
        return;
      }
      if (State.keyboardVisible && !force) {
        State.pendingResizeAfterKeyboard = true;
        return;
      }

      const runFit = () => {
        if (State.resizeRafId) {
          return;
        }
        State.resizeRafId = window.requestAnimationFrame(() => {
          State.resizeRafId = 0;
          if (!State.fitAddon || !State.terminal) {
            return;
          }
          if (State.keyboardVisible && !force) {
            State.pendingResizeAfterKeyboard = true;
            return;
          }
          State.fitAddon.fit();
          this.sendResize();
        });
      };

      if (force) {
        if (State.resizeDebounceTimer) {
          window.clearTimeout(State.resizeDebounceTimer);
          State.resizeDebounceTimer = 0;
        }
        runFit();
        return;
      }
      if (State.resizeDebounceTimer) {
        window.clearTimeout(State.resizeDebounceTimer);
        State.resizeDebounceTimer = 0;
      }
      State.resizeDebounceTimer = window.setTimeout(() => {
        State.resizeDebounceTimer = 0;
        runFit();
      }, RESIZE_DEBOUNCE_MS);
    },

    sendResize() {
      if (!State.currentSessionId || !State.terminal) {
        return;
      }
      const cols = State.terminal.cols;
      const rows = State.terminal.rows;
      if (
        State.lastResizeSessionId === State.currentSessionId &&
        State.lastResizeCols === cols &&
        State.lastResizeRows === rows
      ) {
        return;
      }

      const control = getControl();
      const sent = control
        ? control.send({
            type: 'resize',
            sessionId: State.currentSessionId,
            cols,
            rows
          })
        : false;

      if (!sent) {
        return;
      }
      State.lastResizeSessionId = State.currentSessionId;
      State.lastResizeCols = cols;
      State.lastResizeRows = rows;
    },

    sendTerminalInput(socket, sessionId, data) {
      if (!data) {
        return;
      }
      if (State.terminalBinaryEnabled) {
        socket.send(encodeTerminalFrame(TERMINAL_FRAME_TYPE_INPUT, sessionId, data));
        return;
      }
      socket.send(data);
    },

    flushQueuedInput(socket, sessionId) {
      if (!State.terminalInputQueue) {
        return;
      }
      this.sendTerminalInput(socket, sessionId, State.terminalInputQueue);
      State.terminalInputQueue = '';
    },

    sendData(data) {
      const socket = State.terminalSocket;
      const sessionId = State.currentSessionId;
      if (!sessionId || !socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (!data) {
        return true;
      }

      if (data.length <= TERMINAL_INPUT_DIRECT_CHARS && !State.terminalInputQueue) {
        this.sendTerminalInput(socket, sessionId, data);
        return true;
      }

      if (data.length >= TERMINAL_INPUT_BATCH_CHARS) {
        if (State.terminalInputRafId) {
          window.cancelAnimationFrame(State.terminalInputRafId);
          State.terminalInputRafId = 0;
        }
        this.flushQueuedInput(socket, sessionId);
        this.sendTerminalInput(socket, sessionId, data);
        return true;
      }

      State.terminalInputQueue += data;
      if (State.terminalInputQueue.length >= TERMINAL_INPUT_BATCH_CHARS) {
        if (State.terminalInputRafId) {
          window.cancelAnimationFrame(State.terminalInputRafId);
          State.terminalInputRafId = 0;
        }
        this.flushQueuedInput(socket, sessionId);
        return true;
      }

      if (!State.terminalInputRafId) {
        State.terminalInputRafId = window.requestAnimationFrame(() => {
          State.terminalInputRafId = 0;
          const activeSocket = State.terminalSocket;
          if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !State.terminalInputQueue) {
            return;
          }
          const activeSessionId = State.currentSessionId;
          if (!activeSessionId) {
            return;
          }
          this.flushQueuedInput(activeSocket, activeSessionId);
        });
      }
      return true;
    },

    queueServerOutput(data, options = {}) {
      if (!State.terminal || !data) {
        return;
      }
      const queueEntry = {
        data,
        queueBytes: data.length,
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : '',
        logBytes: Number.isFinite(options.logBytes) ? Math.max(0, Math.floor(options.logBytes)) : 0
      };
      State.terminalWriteQueue.push(queueEntry);
      State.terminalWriteQueuedBytes += queueEntry.queueBytes;
      if (!State.terminalBackpressured && State.terminalWriteQueuedBytes >= TERMINAL_WRITE_HIGH_WATER_BYTES) {
        State.terminalBackpressured = true;
      }
      this.drainServerOutput();
    },

    drainServerOutput() {
      if (!State.terminal || State.terminalWriteInProgress) {
        return;
      }
      const chunk = State.terminalWriteQueue.shift();
      if (!chunk) {
        if (State.terminalBackpressured && State.terminalWriteQueuedBytes <= TERMINAL_WRITE_LOW_WATER_BYTES) {
          State.terminalBackpressured = false;
        }
        return;
      }
      State.terminalWriteInProgress = true;
      State.terminalWriteQueuedBytes = Math.max(0, State.terminalWriteQueuedBytes - chunk.queueBytes);
      State.terminal.write(chunk.data, () => {
        State.terminalWriteInProgress = false;
        if (chunk.sessionId && chunk.logBytes > 0) {
          addSessionOffset(chunk.sessionId, chunk.logBytes);
        }
        if (State.terminalBackpressured && State.terminalWriteQueuedBytes <= TERMINAL_WRITE_LOW_WATER_BYTES) {
          State.terminalBackpressured = false;
        }
        this.drainServerOutput();
      });
    },

    resetIoBuffers() {
      if (State.terminalInputRafId) {
        window.cancelAnimationFrame(State.terminalInputRafId);
        State.terminalInputRafId = 0;
      }
      State.terminalInputQueue = '';
      State.terminalWriteQueue.length = 0;
      State.terminalWriteQueuedBytes = 0;
      State.terminalWriteInProgress = false;
      State.terminalBackpressured = false;
    },

    cancelTerminalReconnect() {
      if (State.terminalReconnectTimer) {
        window.clearTimeout(State.terminalReconnectTimer);
        State.terminalReconnectTimer = 0;
      }
    },

    bindTerminalInput() {
      if (!State.terminal) {
        return;
      }
      if (State.terminalInputDisposable) {
        State.terminalInputDisposable.dispose();
      }
      State.terminalInputDisposable = State.terminal.onData((data) => {
        this.sendData(data);
      });
    },

    disconnect() {
      this.cancelTerminalReconnect();
      if (State.resizeDebounceTimer) {
        window.clearTimeout(State.resizeDebounceTimer);
        State.resizeDebounceTimer = 0;
      }
      if (State.terminalInputDisposable) {
        State.terminalInputDisposable.dispose();
        State.terminalInputDisposable = null;
      }
      this.resetIoBuffers();
      if (State.terminalSocket) {
        State.terminalSocket.onclose = null;
        State.terminalSocket.close();
        State.terminalSocket = null;
      }
      State.terminalConnected = false;
      State.terminalBinaryEnabled = false;
      statusBar.setTerminal('offline');
    },

    scheduleTerminalReconnect(sessionId) {
      if (!sessionId || sessionId !== State.currentSessionId) {
        return;
      }
      this.cancelTerminalReconnect();
      const delay = State.terminalReconnectDelayMs;
      statusBar.setTerminal('warn');
      statusBar.setText(`终端连接断开，${Math.ceil(delay / 1000)}s 后重连...`);
      State.terminalReconnectTimer = window.setTimeout(() => {
        State.terminalReconnectTimer = 0;
        if (sessionId !== State.currentSessionId) {
          return;
        }
        State.terminalReconnectDelayMs = Math.min(State.terminalReconnectDelayMs * 2, 20000);
        void this.reconnect(sessionId);
      }, delay);
    },

    async reconnect(sessionId) {
      if (!State.terminal || !sessionId || sessionId !== State.currentSessionId) {
        return;
      }
      const replayFrom = getSessionOffset(sessionId);
      await this.connect(sessionId, {
        clearTerminal: replayFrom === 0,
        replayFrom: replayFrom > 0 ? replayFrom : undefined,
        keepReconnectDelay: true
      });
    },

    async connect(sessionId, options = {}) {
      if (!State.terminal) {
        return;
      }
      const { clearTerminal = true, replayFrom, keepReconnectDelay = false } = options;
      State.terminalConnectSeq += 1;
      const connectSeq = State.terminalConnectSeq;

      this.disconnect();
      if (clearTerminal) {
        State.terminal.write('\x1bc');
      }
      if (!keepReconnectDelay) {
        State.terminalReconnectDelayMs = 1000;
      }

      let effectiveReplayFrom = 0;
      if (Number.isFinite(replayFrom) && replayFrom >= 0) {
        effectiveReplayFrom = Math.floor(replayFrom);
      } else if (!clearTerminal) {
        effectiveReplayFrom = getSessionOffset(sessionId);
      } else {
        const logBytes = await fetchSessionLogBytes(sessionId);
        effectiveReplayFrom = Math.max(0, logBytes - TERMINAL_REPLAY_TAIL_BYTES);
      }
      setSessionOffset(sessionId, effectiveReplayFrom);

      if (connectSeq !== State.terminalConnectSeq || sessionId !== State.currentSessionId) {
        return;
      }

      const supportsBinaryCodec =
        Array.isArray(State.serverCapabilities) &&
        State.serverCapabilities.includes(CAPABILITY_TERMINAL_BINARY_V1);
      State.terminalBinaryEnabled = supportsBinaryCodec;

      const extraParams = { session: sessionId };
      if (effectiveReplayFrom > 0) {
        extraParams.replayFrom = effectiveReplayFrom;
      }
      if (supportsBinaryCodec) {
        extraParams.codec = TERMINAL_BINARY_CODEC;
      }
      const socket = new WebSocket(wsUrl('/ws/terminal', extraParams));
      socket.binaryType = 'arraybuffer';
      State.terminalSocket = socket;
      statusBar.setTerminal('warn');

      socket.onopen = () => {
        if (State.terminalSocket !== socket) {
          return;
        }
        State.terminalConnected = true;
        State.terminalReconnectDelayMs = 1000;
        statusBar.setTerminal('online');
        statusBar.setText(`会话 ${shortenSessionId(sessionId)} 已附加`);
        this.bindTerminalInput();
        this.sendResize();
      };

      socket.onmessage = (event) => {
        if (State.terminalSocket !== socket) {
          return;
        }
        let data = '';
        let logBytes = 0;
        if (typeof event.data === 'string') {
          data = event.data;
          logBytes = textEncoder.encode(data).byteLength;
        } else if (event.data instanceof ArrayBuffer) {
          if (State.terminalBinaryEnabled) {
            const frame = decodeTerminalFrame(event.data, sessionId);
            if (!frame || frame.frameType !== TERMINAL_FRAME_TYPE_OUTPUT) {
              return;
            }
            data = frame.payloadText;
            logBytes = frame.payloadBytes;
          } else {
            logBytes = event.data.byteLength;
            data = textDecoder.decode(event.data);
          }
        }
        if (data) {
          this.queueServerOutput(data, {
            sessionId,
            logBytes
          });
        }
      };

      socket.onclose = () => {
        if (State.terminalSocket !== socket) {
          return;
        }
        State.terminalSocket = null;
        State.terminalConnected = false;
        this.resetIoBuffers();
        if (State.currentSessionId === sessionId) {
          this.scheduleTerminalReconnect(sessionId);
        }
      };

      socket.onerror = () => {
        if (State.terminalSocket === socket) {
          socket.close();
        }
      };
    }
  };
}
