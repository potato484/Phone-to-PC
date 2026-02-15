import {
  CAPABILITY_TERMINAL_BINARY_V1,
  DOM,
  FitAddonCtor,
  RESIZE_DEBOUNCE_MS,
  State,
  TERMINAL_BINARY_CODEC,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_INPUT_BATCH_CHARS,
  TERMINAL_INPUT_DIRECT_CHARS,
  TERMINAL_FRAME_TYPE_INPUT,
  TERMINAL_FRAME_TYPE_OUTPUT,
  TERMINAL_MAX_PANES,
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

const DEFAULT_FONT_SIZE = 14;
const RECONNECT_PROGRESS_TICK_MS = 80;

function clampFontSize(size) {
  if (!Number.isFinite(size)) {
    return DEFAULT_FONT_SIZE;
  }
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)));
}

export function createTerm({ getControl, statusBar, toast, onActiveSessionChange }) {
  const panes = new Map();
  const paneOrder = [];
  let paneCounter = 0;
  let activePaneId = '';
  let reconnectProgressTimer = 0;

  function getPane(paneId) {
    if (!paneId) {
      return null;
    }
    return panes.get(paneId) || null;
  }

  function getActivePane() {
    return getPane(activePaneId);
  }

  function setPaneConnectionState(pane, state) {
    if (!pane || !pane.rootEl) {
      return;
    }
    pane.rootEl.dataset.connection = state;
  }

  function updatePaneTitle(pane) {
    if (!pane || !pane.titleEl) {
      return;
    }
    if (!pane.sessionId) {
      pane.titleEl.textContent = `面板 ${pane.index}`;
      pane.rootEl.dataset.sessionId = '';
      return;
    }
    pane.rootEl.dataset.sessionId = pane.sessionId;
    const cwdLabel = pane.cwd ? ` · ${pane.cwd}` : '';
    pane.titleEl.textContent = `${shortenSessionId(pane.sessionId)}${cwdLabel}`;
  }

  function stopReconnectProgress() {
    if (reconnectProgressTimer) {
      window.clearInterval(reconnectProgressTimer);
      reconnectProgressTimer = 0;
    }
    if (DOM.terminalReconnect) {
      DOM.terminalReconnect.hidden = true;
    }
    if (DOM.terminalReconnectFill) {
      DOM.terminalReconnectFill.style.width = '0%';
    }
    if (DOM.terminalReconnectText) {
      DOM.terminalReconnectText.textContent = '';
    }
  }

  function renderReconnectProgress() {
    const pane = getActivePane();
    if (!pane || !pane.reconnectTimer || pane.reconnectDelayActive <= 0) {
      stopReconnectProgress();
      return;
    }
    const elapsed = Date.now() - pane.reconnectStartedAt;
    const progress = Math.max(0, Math.min(1, elapsed / pane.reconnectDelayActive));
    const remaining = Math.max(0, Math.ceil((pane.reconnectDelayActive - elapsed) / 1000));
    if (DOM.terminalReconnect) {
      DOM.terminalReconnect.hidden = false;
    }
    if (DOM.terminalReconnectFill) {
      DOM.terminalReconnectFill.style.width = `${Math.round(progress * 100)}%`;
    }
    if (DOM.terminalReconnectText) {
      DOM.terminalReconnectText.textContent = `终端断开，${remaining}s 后重连`;
    }
  }

  function syncReconnectProgressForActivePane() {
    const pane = getActivePane();
    if (!pane || !pane.reconnectTimer || pane.reconnectDelayActive <= 0) {
      stopReconnectProgress();
      return;
    }
    renderReconnectProgress();
    if (!reconnectProgressTimer) {
      reconnectProgressTimer = window.setInterval(renderReconnectProgress, RECONNECT_PROGRESS_TICK_MS);
    }
  }

  function syncLegacyStateFromActivePane() {
    const pane = getActivePane();
    State.terminal = pane ? pane.terminal : null;
    State.fitAddon = pane ? pane.fitAddon : null;
    State.webglAddon = pane ? pane.webglAddon : null;
    State.terminalSocket = pane ? pane.socket : null;
    State.terminalConnected = !!(pane && pane.connected);
    State.terminalBinaryEnabled = !!(pane && pane.binaryEnabled);
    State.currentSessionId = pane && pane.sessionId ? pane.sessionId : '';

    if (pane && pane.sessionId) {
      statusBar.setSession(pane.sessionId);
    } else {
      statusBar.setSession('');
    }

    if (!pane) {
      statusBar.setTerminal('offline');
    } else if (pane.connected) {
      statusBar.setTerminal('online');
    } else if (pane.reconnectTimer) {
      statusBar.setTerminal('warn');
    } else if (pane.sessionId) {
      statusBar.setTerminal('warn');
    } else {
      statusBar.setTerminal('offline');
    }

    if (typeof onActiveSessionChange === 'function') {
      onActiveSessionChange(State.currentSessionId || '');
    }
    syncReconnectProgressForActivePane();
  }

  function setActivePane(paneId, options = {}) {
    const pane = getPane(paneId);
    if (!pane) {
      return;
    }
    activePaneId = pane.id;
    panes.forEach((entry) => {
      entry.rootEl.classList.toggle('is-active', entry.id === pane.id);
    });
    if (options.focus !== false) {
      pane.terminal.focus();
    }
    syncLegacyStateFromActivePane();
  }

  function updatePaneOrderingAndLayout() {
    if (!DOM.terminalGrid) {
      return;
    }

    paneOrder.forEach((paneId, index) => {
      const pane = getPane(paneId);
      if (!pane) {
        return;
      }
      pane.index = index + 1;
      updatePaneTitle(pane);
      if (pane.closeBtnEl) {
        pane.closeBtnEl.hidden = panes.size <= 1;
      }
    });

    DOM.terminalGrid.dataset.paneCount = String(panes.size);
  }

  function sendResizeForPane(pane) {
    if (!pane || !pane.sessionId || !pane.terminal) {
      return;
    }
    const cols = pane.terminal.cols;
    const rows = pane.terminal.rows;
    if (
      pane.lastResizeSessionId === pane.sessionId &&
      pane.lastResizeCols === cols &&
      pane.lastResizeRows === rows
    ) {
      return;
    }

    const control = getControl();
    const sent = control
      ? control.send({
          type: 'resize',
          sessionId: pane.sessionId,
          cols,
          rows
        })
      : false;
    if (!sent) {
      return;
    }
    pane.lastResizeSessionId = pane.sessionId;
    pane.lastResizeCols = cols;
    pane.lastResizeRows = rows;
  }

  function fitAllPanes(force = false) {
    if (!force && State.zoomActive) {
      return;
    }
    if (!force && State.keyboardVisible) {
      State.pendingResizeAfterKeyboard = true;
      return;
    }

    panes.forEach((pane) => {
      if (!pane.fitAddon || !pane.terminal) {
        return;
      }
      pane.fitAddon.fit();
      sendResizeForPane(pane);
    });
  }

  function resetPaneIoBuffers(pane) {
    if (pane.inputRafId) {
      window.cancelAnimationFrame(pane.inputRafId);
      pane.inputRafId = 0;
    }
    pane.inputQueue = '';
    pane.writeQueue.length = 0;
    pane.writeQueuedBytes = 0;
    pane.writeInProgress = false;
    pane.writeBackpressured = false;
  }

  function sendPaneTerminalInput(pane, socket, data) {
    if (!data) {
      return;
    }
    if (pane.binaryEnabled) {
      socket.send(encodeTerminalFrame(TERMINAL_FRAME_TYPE_INPUT, pane.sessionId, data));
      return;
    }
    socket.send(data);
  }

  function flushPaneQueuedInput(pane, socket) {
    if (!pane.inputQueue) {
      return;
    }
    sendPaneTerminalInput(pane, socket, pane.inputQueue);
    pane.inputQueue = '';
  }

  function sendDataOnPane(pane, data) {
    const socket = pane.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !pane.sessionId) {
      return false;
    }
    if (!data) {
      return true;
    }

    if (data.length <= TERMINAL_INPUT_DIRECT_CHARS && !pane.inputQueue) {
      sendPaneTerminalInput(pane, socket, data);
      return true;
    }

    if (data.length >= TERMINAL_INPUT_BATCH_CHARS) {
      if (pane.inputRafId) {
        window.cancelAnimationFrame(pane.inputRafId);
        pane.inputRafId = 0;
      }
      flushPaneQueuedInput(pane, socket);
      sendPaneTerminalInput(pane, socket, data);
      return true;
    }

    pane.inputQueue += data;
    if (pane.inputQueue.length >= TERMINAL_INPUT_BATCH_CHARS) {
      if (pane.inputRafId) {
        window.cancelAnimationFrame(pane.inputRafId);
        pane.inputRafId = 0;
      }
      flushPaneQueuedInput(pane, socket);
      return true;
    }

    if (!pane.inputRafId) {
      pane.inputRafId = window.requestAnimationFrame(() => {
        pane.inputRafId = 0;
        const activeSocket = pane.socket;
        if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !pane.inputQueue) {
          return;
        }
        flushPaneQueuedInput(pane, activeSocket);
      });
    }
    return true;
  }

  function drainPaneOutput(pane) {
    if (!pane.terminal || pane.writeInProgress) {
      return;
    }
    const chunk = pane.writeQueue.shift();
    if (!chunk) {
      if (pane.writeBackpressured && pane.writeQueuedBytes <= TERMINAL_WRITE_LOW_WATER_BYTES) {
        pane.writeBackpressured = false;
      }
      return;
    }

    pane.writeInProgress = true;
    pane.writeQueuedBytes = Math.max(0, pane.writeQueuedBytes - chunk.queueBytes);
    pane.terminal.write(chunk.data, () => {
      pane.writeInProgress = false;
      if (chunk.sessionId && chunk.logBytes > 0) {
        addSessionOffset(chunk.sessionId, chunk.logBytes);
      }
      if (pane.writeBackpressured && pane.writeQueuedBytes <= TERMINAL_WRITE_LOW_WATER_BYTES) {
        pane.writeBackpressured = false;
      }
      drainPaneOutput(pane);
    });
  }

  function queuePaneOutput(pane, data, options = {}) {
    if (!pane.terminal || !data) {
      return;
    }
    const queueEntry = {
      data,
      queueBytes: data.length,
      sessionId: typeof options.sessionId === 'string' ? options.sessionId : '',
      logBytes: Number.isFinite(options.logBytes) ? Math.max(0, Math.floor(options.logBytes)) : 0
    };
    pane.writeQueue.push(queueEntry);
    pane.writeQueuedBytes += queueEntry.queueBytes;
    if (!pane.writeBackpressured && pane.writeQueuedBytes >= TERMINAL_WRITE_HIGH_WATER_BYTES) {
      pane.writeBackpressured = true;
    }
    drainPaneOutput(pane);
  }

  function clearPaneReconnectTimer(pane) {
    if (!pane.reconnectTimer) {
      return;
    }
    window.clearTimeout(pane.reconnectTimer);
    pane.reconnectTimer = 0;
    pane.reconnectDelayActive = 0;
    pane.reconnectStartedAt = 0;
    if (pane.id === activePaneId) {
      syncReconnectProgressForActivePane();
    }
  }

  async function connectPane(pane, sessionId, options = {}) {
    if (!pane || !pane.terminal || !sessionId) {
      return;
    }
    const { clearTerminal = true, replayFrom, keepReconnectDelay = false, cwd } = options;
    pane.connectSeq += 1;
    const connectSeq = pane.connectSeq;

    clearPaneReconnectTimer(pane);
    resetPaneIoBuffers(pane);
    if (pane.socket) {
      pane.socket.onclose = null;
      pane.socket.close();
      pane.socket = null;
    }
    pane.connected = false;
    pane.binaryEnabled = false;

    pane.sessionId = sessionId;
    if (typeof cwd === 'string' && cwd) {
      pane.cwd = cwd;
    }
    updatePaneTitle(pane);
    setPaneConnectionState(pane, 'connecting');

    if (clearTerminal) {
      pane.terminal.write('\x1bc');
    }
    if (!keepReconnectDelay) {
      pane.reconnectDelayMs = 1000;
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

    if (connectSeq !== pane.connectSeq || pane.sessionId !== sessionId || !panes.has(pane.id)) {
      return;
    }

    const supportsBinaryCodec =
      Array.isArray(State.serverCapabilities) &&
      State.serverCapabilities.includes(CAPABILITY_TERMINAL_BINARY_V1);
    pane.binaryEnabled = supportsBinaryCodec;

    const extraParams = { session: sessionId };
    if (effectiveReplayFrom > 0) {
      extraParams.replayFrom = effectiveReplayFrom;
    }
    if (supportsBinaryCodec) {
      extraParams.codec = TERMINAL_BINARY_CODEC;
    }
    const socket = new WebSocket(wsUrl('/ws/terminal', extraParams));
    socket.binaryType = 'arraybuffer';
    pane.socket = socket;

    if (pane.id === activePaneId) {
      statusBar.setTerminal('warn');
      statusBar.setText(`正在附加会话 ${shortenSessionId(sessionId)}...`);
      syncLegacyStateFromActivePane();
    }

    socket.onopen = () => {
      if (pane.socket !== socket || connectSeq !== pane.connectSeq) {
        return;
      }
      pane.connected = true;
      pane.reconnectDelayMs = 1000;
      pane.reconnectDelayActive = 0;
      pane.reconnectStartedAt = 0;
      setPaneConnectionState(pane, 'online');
      if (pane.id === activePaneId) {
        statusBar.setTerminal('online');
        statusBar.setText(`会话 ${shortenSessionId(sessionId)} 已附加`);
        syncLegacyStateFromActivePane();
      }
      sendResizeForPane(pane);
    };

    socket.onmessage = (event) => {
      if (pane.socket !== socket) {
        return;
      }
      let data = '';
      let logBytes = 0;
      if (typeof event.data === 'string') {
        data = event.data;
        logBytes = textEncoder.encode(data).byteLength;
      } else if (event.data instanceof ArrayBuffer) {
        if (pane.binaryEnabled) {
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
        queuePaneOutput(pane, data, { sessionId, logBytes });
      }
    };

    socket.onclose = () => {
      if (pane.socket !== socket) {
        return;
      }
      pane.socket = null;
      pane.connected = false;
      pane.binaryEnabled = false;
      resetPaneIoBuffers(pane);
      if (!pane.sessionId) {
        setPaneConnectionState(pane, 'idle');
        if (pane.id === activePaneId) {
          syncLegacyStateFromActivePane();
        }
        return;
      }
      setPaneConnectionState(pane, 'offline');
      if (pane.id === activePaneId) {
        statusBar.setTerminal('warn');
      }
      schedulePaneReconnect(pane);
    };

    socket.onerror = () => {
      if (pane.socket === socket) {
        socket.close();
      }
    };
  }

  async function reconnectPane(pane) {
    if (!pane || !pane.sessionId || !panes.has(pane.id)) {
      return;
    }
    const replayFrom = getSessionOffset(pane.sessionId);
    await connectPane(pane, pane.sessionId, {
      clearTerminal: false,
      replayFrom: replayFrom >= 0 ? replayFrom : 0,
      keepReconnectDelay: true,
      cwd: pane.cwd
    });
  }

  function schedulePaneReconnect(pane) {
    if (!pane.sessionId) {
      return;
    }
    clearPaneReconnectTimer(pane);
    const delay = pane.reconnectDelayMs;
    pane.reconnectDelayActive = delay;
    pane.reconnectStartedAt = Date.now();
    pane.reconnectTimer = window.setTimeout(() => {
      pane.reconnectTimer = 0;
      pane.reconnectDelayActive = 0;
      pane.reconnectStartedAt = 0;
      if (!pane.sessionId || !panes.has(pane.id)) {
        return;
      }
      pane.reconnectDelayMs = Math.min(pane.reconnectDelayMs * 2, 20000);
      void reconnectPane(pane);
    }, delay);

    if (pane.id === activePaneId) {
      statusBar.setTerminal('warn');
      statusBar.setText(`终端连接断开，${Math.ceil(delay / 1000)}s 后重连...`);
      syncReconnectProgressForActivePane();
    }
  }

  function disconnectPane(pane, options = {}) {
    if (!pane) {
      return;
    }
    const { clearSession = false } = options;
    clearPaneReconnectTimer(pane);
    resetPaneIoBuffers(pane);
    if (pane.socket) {
      pane.socket.onclose = null;
      pane.socket.close();
      pane.socket = null;
    }
    pane.connected = false;
    pane.binaryEnabled = false;
    pane.lastResizeSessionId = '';
    pane.lastResizeCols = 0;
    pane.lastResizeRows = 0;
    if (clearSession) {
      pane.sessionId = '';
      pane.cwd = '';
    }
    updatePaneTitle(pane);
    setPaneConnectionState(pane, pane.sessionId ? 'offline' : 'idle');
    if (pane.id === activePaneId) {
      syncLegacyStateFromActivePane();
    }
  }

  function createPane() {
    if (!DOM.terminalGrid || panes.size >= TERMINAL_MAX_PANES) {
      return null;
    }

    paneCounter += 1;
    const paneId = `pane-${paneCounter}`;
    const rootEl = document.createElement('section');
    rootEl.className = 'terminal-pane';
    rootEl.dataset.paneId = paneId;

    const headerEl = document.createElement('header');
    headerEl.className = 'terminal-pane-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'terminal-pane-title';
    headerEl.appendChild(titleEl);

    const closeBtnEl = document.createElement('button');
    closeBtnEl.type = 'button';
    closeBtnEl.className = 'terminal-pane-close';
    closeBtnEl.textContent = '×';
    closeBtnEl.title = '关闭面板';
    closeBtnEl.setAttribute('aria-label', '关闭面板');
    headerEl.appendChild(closeBtnEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'terminal-pane-body';

    const terminalHostEl = document.createElement('div');
    terminalHostEl.className = 'terminal-pane-terminal';
    bodyEl.appendChild(terminalHostEl);

    rootEl.appendChild(headerEl);
    rootEl.appendChild(bodyEl);
    DOM.terminalGrid.appendChild(rootEl);

    const terminal = new TerminalCtor({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'IBM Plex Mono, Menlo, Consolas, monospace',
      fontSize: clampFontSize(State.terminalFontSize || DEFAULT_FONT_SIZE),
      theme: {
        background: '#090b14',
        foreground: '#f0f2f8'
      }
    });
    const fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostEl);

    let webglAddon = null;
    if (WebglAddonCtor) {
      try {
        webglAddon = new WebglAddonCtor();
        terminal.loadAddon(webglAddon);
        if (webglAddon && typeof webglAddon.onContextLoss === 'function') {
          webglAddon.onContextLoss(() => {
            toast.show('WebGL 上下文丢失，已回退默认渲染', 'warn');
            if (webglAddon && typeof webglAddon.dispose === 'function') {
              webglAddon.dispose();
            }
            webglAddon = null;
          });
        }
      } catch {
        webglAddon = null;
      }
    }

    const pane = {
      id: paneId,
      index: paneOrder.length + 1,
      rootEl,
      titleEl,
      closeBtnEl,
      terminalHostEl,
      terminal,
      fitAddon,
      webglAddon,
      socket: null,
      inputDisposable: null,
      inputQueue: '',
      inputRafId: 0,
      writeQueue: [],
      writeQueuedBytes: 0,
      writeInProgress: false,
      writeBackpressured: false,
      connected: false,
      binaryEnabled: false,
      reconnectDelayMs: 1000,
      reconnectDelayActive: 0,
      reconnectStartedAt: 0,
      reconnectTimer: 0,
      connectSeq: 0,
      sessionId: '',
      cwd: '',
      lastResizeSessionId: '',
      lastResizeCols: 0,
      lastResizeRows: 0
    };

    pane.inputDisposable = terminal.onData((data) => {
      setActivePane(pane.id);
      sendDataOnPane(pane, data);
    });

    rootEl.addEventListener('click', () => {
      setActivePane(pane.id);
    });

    closeBtnEl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panes.size <= 1) {
        toast.show('至少保留一个面板', 'warn');
        return;
      }
      removePane(pane.id);
    });

    panes.set(pane.id, pane);
    paneOrder.push(pane.id);
    setPaneConnectionState(pane, 'idle');
    updatePaneTitle(pane);
    updatePaneOrderingAndLayout();
    return pane;
  }

  function removePane(paneId, options = {}) {
    const { allowEmpty = false } = options;
    const pane = getPane(paneId);
    if (!pane || (!allowEmpty && panes.size <= 1)) {
      return false;
    }
    const removeIndex = paneOrder.indexOf(paneId);
    if (removeIndex >= 0) {
      paneOrder.splice(removeIndex, 1);
    }
    const wasActive = paneId === activePaneId;

    disconnectPane(pane, { clearSession: true });
    if (pane.inputDisposable) {
      pane.inputDisposable.dispose();
      pane.inputDisposable = null;
    }
    if (pane.webglAddon && typeof pane.webglAddon.dispose === 'function') {
      pane.webglAddon.dispose();
      pane.webglAddon = null;
    }
    pane.terminal.dispose();
    pane.rootEl.remove();
    panes.delete(paneId);

    if (wasActive) {
      const fallbackId = paneOrder[removeIndex] || paneOrder[removeIndex - 1] || paneOrder[0] || '';
      activePaneId = '';
      if (fallbackId) {
        setActivePane(fallbackId, { focus: false });
      } else {
        syncLegacyStateFromActivePane();
      }
    } else {
      syncLegacyStateFromActivePane();
    }
    updatePaneOrderingAndLayout();
    return true;
  }

  function closePanesBySession(sessionId) {
    if (!sessionId) {
      return 0;
    }
    const targetPaneIds = paneOrder.filter((paneId) => {
      const pane = getPane(paneId);
      return !!(pane && pane.sessionId === sessionId);
    });
    if (targetPaneIds.length === 0) {
      return 0;
    }

    let removedCount = 0;
    targetPaneIds.forEach((paneId) => {
      if (removePane(paneId, { allowEmpty: true })) {
        removedCount += 1;
      }
    });

    if (panes.size === 0) {
      const fallbackPane = createPane();
      if (fallbackPane) {
        setActivePane(fallbackPane.id, { focus: false });
      }
    }
    syncLegacyStateFromActivePane();
    return removedCount;
  }

  return {
    init() {
      if (!TerminalCtor || !FitAddonCtor || !DOM.terminalWrap || !DOM.terminalGrid) {
        statusBar.setText('xterm.js 本地资源加载失败');
        toast.show('xterm.js 本地资源加载失败', 'danger');
        return;
      }
      State.terminalFontSize = clampFontSize(State.terminalFontSize || DEFAULT_FONT_SIZE);
      if (panes.size === 0) {
        const firstPane = createPane();
        if (!firstPane) {
          statusBar.setText('终端初始化失败');
          return;
        }
        setActivePane(firstPane.id);
      }

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

      this.scheduleResize(true);
      window.requestAnimationFrame(() => {
        this.scheduleResize(true);
      });
    },

    scheduleResize(force = false) {
      if (panes.size === 0) {
        return;
      }
      if (!force && State.zoomActive) {
        return;
      }
      if (!force && State.keyboardVisible) {
        State.pendingResizeAfterKeyboard = true;
        return;
      }

      const runFit = () => {
        if (State.resizeRafId) {
          return;
        }
        State.resizeRafId = window.requestAnimationFrame(() => {
          State.resizeRafId = 0;
          fitAllPanes(force);
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
      }
      State.resizeDebounceTimer = window.setTimeout(() => {
        State.resizeDebounceTimer = 0;
        runFit();
      }, RESIZE_DEBOUNCE_MS);
    },

    sendData(data) {
      const pane = getActivePane();
      if (!pane) {
        return false;
      }
      return sendDataOnPane(pane, data);
    },

    async connect(sessionId, options = {}) {
      if (!sessionId) {
        return;
      }
      let pane = getActivePane();
      if (!pane) {
        pane = createPane();
        if (!pane) {
          return;
        }
        setActivePane(pane.id);
      }
      await connectPane(pane, sessionId, options);
      if (pane.id === activePaneId) {
        syncLegacyStateFromActivePane();
      }
    },

    async reconnect(sessionId) {
      if (!sessionId) {
        return;
      }
      let pane = getActivePane();
      if (!pane || pane.sessionId !== sessionId) {
        pane = Array.from(panes.values()).find((entry) => entry.sessionId === sessionId) || getActivePane();
      }
      if (!pane) {
        return;
      }
      if (pane.sessionId !== sessionId) {
        const replayFrom = getSessionOffset(sessionId);
        await connectPane(pane, sessionId, {
          clearTerminal: false,
          replayFrom: replayFrom >= 0 ? replayFrom : 0,
          keepReconnectDelay: true
        });
      } else {
        await reconnectPane(pane);
      }
      if (pane.id === activePaneId) {
        syncLegacyStateFromActivePane();
      }
    },

    disconnect() {
      const pane = getActivePane();
      if (!pane) {
        return;
      }
      disconnectPane(pane, { clearSession: true });
      syncLegacyStateFromActivePane();
    },

    handleSessionExit(sessionId) {
      if (!sessionId) {
        return;
      }
      if (closePanesBySession(sessionId) > 0) {
        return;
      }
      panes.forEach((pane) => {
        if (pane.sessionId !== sessionId) {
          return;
        }
        disconnectPane(pane, { clearSession: true });
      });
      syncLegacyStateFromActivePane();
    },

    closePanesBySession(sessionId) {
      return closePanesBySession(sessionId);
    },

    openSessionInNewPane(sessionId, options = {}) {
      if (!sessionId) {
        return false;
      }
      if (panes.size >= TERMINAL_MAX_PANES) {
        toast.show(`最多支持 ${TERMINAL_MAX_PANES} 个面板`, 'warn');
        return false;
      }
      const pane = createPane();
      if (!pane) {
        return false;
      }
      setActivePane(pane.id);
      void connectPane(pane, sessionId, {
        clearTerminal: true,
        cwd: options.cwd
      });
      syncLegacyStateFromActivePane();
      return true;
    },

    forceReconnectNow() {
      panes.forEach((pane) => {
        if (!pane.sessionId || pane.connected) {
          return;
        }
        if (pane.reconnectTimer) {
          window.clearTimeout(pane.reconnectTimer);
          pane.reconnectTimer = 0;
        }
        pane.reconnectDelayActive = 0;
        pane.reconnectStartedAt = 0;
        void reconnectPane(pane);
      });
      syncReconnectProgressForActivePane();
    },

    setFontSize(fontSize) {
      const nextSize = clampFontSize(fontSize);
      const current = clampFontSize(State.terminalFontSize || DEFAULT_FONT_SIZE);
      if (nextSize === current) {
        return current;
      }
      State.terminalFontSize = nextSize;
      panes.forEach((pane) => {
        pane.terminal.options.fontSize = nextSize;
      });
      this.scheduleResize(true);
      return nextSize;
    },

    scaleFont(baseFontSize, scale) {
      const base = clampFontSize(baseFontSize || State.terminalFontSize || DEFAULT_FONT_SIZE);
      if (!Number.isFinite(scale) || scale <= 0) {
        return base;
      }
      return this.setFontSize(base * scale);
    },

    getFontSize() {
      return clampFontSize(State.terminalFontSize || DEFAULT_FONT_SIZE);
    },

    getActiveSelectionText() {
      const pane = getActivePane();
      if (!pane || !pane.terminal || typeof pane.terminal.getSelection !== 'function') {
        return '';
      }
      return pane.terminal.getSelection() || '';
    },

    clearActiveSelection() {
      const pane = getActivePane();
      if (!pane || !pane.terminal || typeof pane.terminal.clearSelection !== 'function') {
        return;
      }
      pane.terminal.clearSelection();
    },

    focusActivePane() {
      const pane = getActivePane();
      if (!pane || !pane.terminal || typeof pane.terminal.focus !== 'function') {
        return false;
      }
      pane.terminal.focus();
      return true;
    }
  };
}
