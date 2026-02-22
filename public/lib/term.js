import {
  CAPABILITY_TERMINAL_BINARY_V1,
  DOM,
  FitAddonCtor,
  RESIZE_DEBOUNCE_MS,
  State,
  TOKEN_STORAGE_KEY,
  TERMINAL_BINARY_CODEC,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_INPUT_BATCH_CHARS,
  TERMINAL_INPUT_DIRECT_CHARS,
  TERMINAL_FRAME_TYPE_INPUT,
  TERMINAL_FRAME_TYPE_OUTPUT,
  TERMINAL_MAX_PANES,
  TERMINAL_WRITE_HIGH_WATER_BYTES,
  TERMINAL_WRITE_LOW_WATER_BYTES,
  TerminalCtor,
  WebglAddonCtor,
  addSessionOffset,
  createWsAuthMessage,
  decodeTerminalFrame,
  encodeTerminalFrame,
  getSessionOffset,
  setSessionOffset,
  persistTerminalFontSize,
  readPersistedTerminalFontSize,
  textDecoder,
  textEncoder,
  wsUrl
} from './state.js';
import { sanitizeInitialAttachData, shouldBlockPrivateModeParams } from './terminal-escape-policy.js';
import { resolveMobileTerminalScrollback } from './terminal-scrollback-policy.js';

const DEFAULT_FONT_SIZE = 14;
const RECONNECT_PROGRESS_TICK_MS = 80;
const INITIAL_ATTACH_SANITIZE_WINDOW_MS = 120000;
const DESKTOP_SCROLLBACK = 30000;
const TERMINAL_WRITE_BATCH_TARGET_BYTES = 24 * 1024;
const TERMINAL_CLEAR_SCREEN_SEQUENCE = '\x1b[2J\x1b[H';
const ENABLE_WEBGL_RENDERER = false;

function resolveTerminalScrollback() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse), (max-width: 900px)').matches) {
      const deviceMemory = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) : Number.NaN;
      return resolveMobileTerminalScrollback(deviceMemory);
    }
  }
  return DESKTOP_SCROLLBACK;
}

function clampFontSize(size) {
  if (!Number.isFinite(size)) {
    return DEFAULT_FONT_SIZE;
  }
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)));
}

function withReconnectJitter(baseDelayMs) {
  const safeBase = Math.max(300, Math.floor(baseDelayMs));
  const jitter = Math.round(safeBase * ((Math.random() * 0.4) - 0.2));
  return Math.max(300, safeBase + jitter);
}

export function createTerm({ getControl, statusBar, toast, onActiveSessionChange }) {
  const panes = new Map();
  const paneOrder = [];
  let paneCounter = 0;
  let activePaneId = '';
  let reconnectProgressTimer = 0;
  let suppressPaneFocusUntilMs = 0;

  function isPaneFocusSuppressed() {
    return suppressPaneFocusUntilMs > Date.now();
  }

  function suppressActivePaneFocusFor(durationMs = 0) {
    const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0;
    if (safeDurationMs <= 0) {
      return suppressPaneFocusUntilMs;
    }
    suppressPaneFocusUntilMs = Math.max(suppressPaneFocusUntilMs, Date.now() + safeDurationMs);
    return suppressPaneFocusUntilMs;
  }

  function getPane(paneId) {
    if (!paneId) {
      return null;
    }
    return panes.get(paneId) || null;
  }

  function getActivePane() {
    const activePane = getPane(activePaneId);
    if (activePane) {
      return activePane;
    }
    const fallbackPaneId = paneOrder[0] || '';
    return getPane(fallbackPaneId);
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
    const terminalName = `终端${pane.index}`;
    if (!pane.sessionId) {
      pane.titleEl.textContent = terminalName;
      pane.rootEl.dataset.sessionId = '';
      return;
    }
    pane.rootEl.dataset.sessionId = pane.sessionId;
    const cwdLabel = pane.cwd ? ` · ${pane.cwd}` : '';
    pane.titleEl.textContent = `${terminalName}${cwdLabel}`;
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
    if (options.focus !== false && !isPaneFocusSuppressed()) {
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
    panes.forEach((pane) => {
      if (!pane.fitAddon || !pane.terminal) {
        return;
      }
      pane.fitAddon.fit();
      sendResizeForPane(pane);
      schedulePaneRefresh(pane);
    });
  }

  function resetPaneIoBuffers(pane) {
    if (pane.inputRafId) {
      window.cancelAnimationFrame(pane.inputRafId);
      pane.inputRafId = 0;
    }
    if (pane.writeDrainRafId) {
      window.cancelAnimationFrame(pane.writeDrainRafId);
      pane.writeDrainRafId = 0;
    }
    if (pane.renderRefreshRafId) {
      window.cancelAnimationFrame(pane.renderRefreshRafId);
      pane.renderRefreshRafId = 0;
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

  function shouldBypassPaneInputBatching(pane) {
    if (
      !pane ||
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      !window.matchMedia('(pointer: coarse), (max-width: 900px)').matches
    ) {
      return false;
    }
    const active = document.activeElement;
    if (!(active instanceof Element)) {
      return false;
    }
    if (active.classList.contains('xterm-helper-textarea')) {
      return true;
    }
    return !!active.closest(`.terminal-pane[data-pane-id="${pane.id}"]`);
  }

  function sendDataOnPane(pane, data) {
    const socket = pane.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !pane.sessionId || !pane.connected) {
      return false;
    }
    if (!data) {
      return true;
    }
    pane.initialAttachSanitizeUntil = 0;

    if (shouldBypassPaneInputBatching(pane)) {
      if (pane.inputRafId) {
        window.cancelAnimationFrame(pane.inputRafId);
        pane.inputRafId = 0;
      }
      flushPaneQueuedInput(pane, socket);
      sendPaneTerminalInput(pane, socket, data);
      return true;
    }

    if (data.length <= TERMINAL_INPUT_DIRECT_CHARS) {
      if (pane.inputRafId) {
        window.cancelAnimationFrame(pane.inputRafId);
        pane.inputRafId = 0;
      }
      flushPaneQueuedInput(pane, socket);
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

  function schedulePaneOutputDrain(pane) {
    if (pane.writeDrainRafId) {
      return;
    }
    pane.writeDrainRafId = window.requestAnimationFrame(() => {
      pane.writeDrainRafId = 0;
      drainPaneOutput(pane);
    });
  }

  function schedulePaneRefresh(pane) {
    if (!pane || !pane.terminal || pane.renderRefreshRafId) {
      return;
    }
    pane.renderRefreshRafId = window.requestAnimationFrame(() => {
      pane.renderRefreshRafId = 0;
      if (!pane.terminal || typeof pane.terminal.refresh !== 'function') {
        return;
      }
      const rows = Number.isFinite(pane.terminal.rows) ? pane.terminal.rows : 0;
      if (rows <= 0) {
        return;
      }
      pane.terminal.refresh(0, rows - 1);
    });
  }

  function takePaneOutputBatch(pane) {
    const firstChunk = pane.writeQueue.shift();
    if (!firstChunk) {
      return null;
    }

    const dataParts = [firstChunk.data];
    let queueBytes = firstChunk.queueBytes;
    let logBytes = firstChunk.logBytes;
    let sessionId = firstChunk.sessionId;

    while (pane.writeQueue.length > 0 && queueBytes < TERMINAL_WRITE_BATCH_TARGET_BYTES) {
      const nextChunk = pane.writeQueue[0];
      if (!nextChunk) {
        pane.writeQueue.shift();
        continue;
      }
      if (
        queueBytes >= TERMINAL_WRITE_BATCH_TARGET_BYTES / 2 &&
        queueBytes + nextChunk.queueBytes > TERMINAL_WRITE_BATCH_TARGET_BYTES
      ) {
        break;
      }
      pane.writeQueue.shift();
      dataParts.push(nextChunk.data);
      queueBytes += nextChunk.queueBytes;
      logBytes += nextChunk.logBytes;
      if (!sessionId && nextChunk.sessionId) {
        sessionId = nextChunk.sessionId;
      }
    }

    return {
      data: dataParts.length === 1 ? dataParts[0] : dataParts.join(''),
      queueBytes,
      logBytes,
      sessionId
    };
  }

  function drainPaneOutput(pane) {
    if (!pane.terminal || pane.writeInProgress) {
      return;
    }
    const chunk = takePaneOutputBatch(pane);
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
      schedulePaneRefresh(pane);
      if (chunk.sessionId && chunk.logBytes > 0) {
        addSessionOffset(chunk.sessionId, chunk.logBytes);
      }
      if (pane.writeBackpressured && pane.writeQueuedBytes <= TERMINAL_WRITE_LOW_WATER_BYTES) {
        pane.writeBackpressured = false;
      }
      if (pane.writeQueue.length === 0) {
        return;
      }
      if (pane.writeBackpressured) {
        schedulePaneOutputDrain(pane);
        return;
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
    if (pane.writeBackpressured) {
      schedulePaneOutputDrain(pane);
      return;
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

  function clearPaneTerminal(pane) {
    if (!pane || !pane.terminal) {
      return;
    }
    pane.terminal.write(TERMINAL_CLEAR_SCREEN_SEQUENCE);
    if (typeof pane.terminal.scrollToBottom === 'function') {
      pane.terminal.scrollToBottom();
    }
    schedulePaneRefresh(pane);
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
    pane.awaitingAuth = false;

    pane.sessionId = sessionId;
    if (typeof cwd === 'string' && cwd) {
      pane.cwd = cwd;
    }
    updatePaneTitle(pane);
    setPaneConnectionState(pane, 'connecting');

    if (clearTerminal) {
      clearPaneTerminal(pane);
    }
    if (!keepReconnectDelay) {
      pane.reconnectDelayMs = 1000;
    }
    pane.initialAttachSanitizeUntil = Date.now() + INITIAL_ATTACH_SANITIZE_WINDOW_MS;

    const hasExplicitReplayFrom = Number.isFinite(replayFrom) && replayFrom >= 0;
    let effectiveReplayFrom = hasExplicitReplayFrom ? Math.floor(replayFrom) : getSessionOffset(sessionId);
    if (!Number.isFinite(effectiveReplayFrom) || effectiveReplayFrom < 0) {
      effectiveReplayFrom = 0;
    }
    setSessionOffset(sessionId, effectiveReplayFrom);

    if (connectSeq !== pane.connectSeq || pane.sessionId !== sessionId || !panes.has(pane.id)) {
      return;
    }

    const supportsBinaryCodec =
      Array.isArray(State.serverCapabilities) &&
      State.serverCapabilities.includes(CAPABILITY_TERMINAL_BINARY_V1);
    pane.binaryEnabled = supportsBinaryCodec;
    pane.awaitingAuth = true;

    const extraParams = {
      session: sessionId,
      replayFrom: effectiveReplayFrom
    };
    extraParams.cols = pane.terminal.cols;
    extraParams.rows = pane.terminal.rows;
    if (supportsBinaryCodec) {
      extraParams.codec = TERMINAL_BINARY_CODEC;
    }
    const socket = new WebSocket(wsUrl('/ws/terminal', extraParams));
    socket.binaryType = 'arraybuffer';
    pane.socket = socket;

    if (pane.id === activePaneId) {
      statusBar.setTerminal('warn');
      statusBar.setText('正在连接终端...');
      syncLegacyStateFromActivePane();
    }

    socket.onopen = () => {
      if (pane.socket !== socket || connectSeq !== pane.connectSeq) {
        return;
      }
      pane.connected = false;
      pane.reconnectDelayMs = 1000;
      pane.reconnectDelayActive = 0;
      pane.reconnectStartedAt = 0;
      setPaneConnectionState(pane, 'connecting');
      if (pane.id === activePaneId) {
        statusBar.setTerminal('warn');
        statusBar.setText('正在验证终端连接...');
        syncLegacyStateFromActivePane();
      }
      socket.send(createWsAuthMessage());
    };

    socket.onmessage = (event) => {
      if (pane.socket !== socket) {
        return;
      }
      if (pane.awaitingAuth) {
        if (typeof event.data !== 'string') {
          return;
        }
        let authPayload = null;
        try {
          authPayload = JSON.parse(event.data);
        } catch {
          authPayload = null;
        }
        if (!authPayload || authPayload.type !== 'auth.ok') {
          socket.close();
          return;
        }
        pane.awaitingAuth = false;
        pane.connected = true;
        setPaneConnectionState(pane, 'online');
        if (pane.id === activePaneId) {
          statusBar.setTerminal('online');
          statusBar.setText('终端已连接');
          syncLegacyStateFromActivePane();
        }
        sendResizeForPane(pane);
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
        const sanitizedData = sanitizeInitialAttachData(data, pane.initialAttachSanitizeUntil);
        if (sanitizedData) {
          queuePaneOutput(pane, sanitizedData, { sessionId, logBytes });
        } else if (logBytes > 0) {
          addSessionOffset(sessionId, logBytes);
        }
      }
    };

    socket.onclose = (event) => {
      if (pane.socket !== socket) {
        return;
      }
      pane.socket = null;
      pane.connected = false;
      pane.binaryEnabled = false;
      pane.awaitingAuth = false;
      pane.initialAttachSanitizeUntil = 0;
      resetPaneIoBuffers(pane);
      if (event.code === 4401) {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        State.token = '';
        setPaneConnectionState(pane, 'offline');
        if (pane.id === activePaneId) {
          statusBar.setTerminal('offline');
          statusBar.setText('终端鉴权失败，请重新登录');
          syncLegacyStateFromActivePane();
        }
        return;
      }
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
    await connectPane(pane, pane.sessionId, {
      clearTerminal: false,
      replayFrom: getSessionOffset(pane.sessionId),
      keepReconnectDelay: true,
      cwd: pane.cwd
    });
  }

  function schedulePaneReconnect(pane) {
    if (!pane.sessionId) {
      return;
    }
    clearPaneReconnectTimer(pane);
    const baseDelay = Math.max(1000, pane.reconnectDelayMs);
    const delay = withReconnectJitter(baseDelay);
    pane.reconnectDelayActive = delay;
    pane.reconnectStartedAt = Date.now();
    pane.reconnectTimer = window.setTimeout(() => {
      pane.reconnectTimer = 0;
      pane.reconnectDelayActive = 0;
      pane.reconnectStartedAt = 0;
      if (!pane.sessionId || !panes.has(pane.id)) {
        return;
      }
      pane.reconnectDelayMs = Math.min(baseDelay * 2, 30000);
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
    pane.awaitingAuth = false;
    pane.initialAttachSanitizeUntil = 0;
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

    const actionsEl = document.createElement('div');
    actionsEl.className = 'terminal-pane-actions';
    headerEl.appendChild(actionsEl);

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
      scrollback: resolveTerminalScrollback(),
      rightClickSelectsWord: true,
      macOptionClickForcesSelection: true,
      fontFamily: 'IBM Plex Mono, Menlo, Consolas, monospace',
      fontSize: clampFontSize(State.terminalFontSize || DEFAULT_FONT_SIZE),
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: 'rgba(148, 226, 213, 0.2)',
        selectionForeground: '#cdd6f4',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8'
      }
    });
    const fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostEl);

    const parserGuardDisposables = [];
    if (
      terminal &&
      terminal.parser &&
      typeof terminal.parser.registerCsiHandler === 'function'
    ) {
      const registerCsiGuard = (identifier, handler) => {
        try {
          const disposable = terminal.parser.registerCsiHandler(identifier, handler);
          if (disposable && typeof disposable.dispose === 'function') {
            parserGuardDisposables.push(disposable);
          }
        } catch {
          // Ignore parser registration failures and keep terminal functional.
        }
      };
      registerCsiGuard({ prefix: '?', final: 'h' }, (params) => shouldBlockPrivateModeParams(params));
      registerCsiGuard({ prefix: '?', final: 'l' }, (params) => shouldBlockPrivateModeParams(params));
      if (typeof terminal.parser.registerEscHandler === 'function') {
        try {
          const disposable = terminal.parser.registerEscHandler({ final: 'c' }, () => true);
          if (disposable && typeof disposable.dispose === 'function') {
            parserGuardDisposables.push(disposable);
          }
        } catch {
          // Ignore parser registration failures and keep terminal functional.
        }
      }
    }

    let webglAddon = null;
    if (ENABLE_WEBGL_RENDERER && WebglAddonCtor) {
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
      terminalHostEl,
      terminal,
      fitAddon,
      webglAddon,
      parserGuardDisposables,
      socket: null,
      inputDisposable: null,
      inputQueue: '',
      inputRafId: 0,
      writeQueue: [],
      writeQueuedBytes: 0,
      writeInProgress: false,
      writeDrainRafId: 0,
      renderRefreshRafId: 0,
      writeBackpressured: false,
      connected: false,
      binaryEnabled: false,
      awaitingAuth: false,
      reconnectDelayMs: 1000,
      reconnectDelayActive: 0,
      reconnectStartedAt: 0,
      reconnectTimer: 0,
      initialAttachSanitizeUntil: 0,
      connectSeq: 0,
      sessionId: '',
      cwd: '',
      lastResizeSessionId: '',
      lastResizeCols: 0,
      lastResizeRows: 0
    };

    if (typeof terminal.attachCustomKeyEventHandler === 'function') {
      terminal.attachCustomKeyEventHandler((event) => {
        const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
        const hasPrimaryModifier = event.ctrlKey || event.metaKey;
        const selectionText =
          hasPrimaryModifier && !event.altKey && key === 'c' && typeof terminal.getSelection === 'function'
            ? terminal.getSelection() || ''
            : '';

        if (selectionText) {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(selectionText).catch(() => {});
            return false;
          }
          return true;
        }

        const shouldPasteFromPrimaryModifier = hasPrimaryModifier && key === 'v' && !event.altKey;
        const shouldPasteFromShiftInsert =
          key === 'insert' && event.shiftKey && !hasPrimaryModifier && !event.altKey;
        if (!shouldPasteFromPrimaryModifier && !shouldPasteFromShiftInsert) {
          return true;
        }
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
          return true;
        }
        navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) {
              return;
            }
            sendDataOnPane(pane, text);
          })
          .catch(() => {});
        return false;
      });
    }

    pane.inputDisposable = terminal.onData((data) => {
      if (activePaneId !== pane.id) {
        setActivePane(pane.id, { focus: false });
      }
      sendDataOnPane(pane, data);
    });

    rootEl.addEventListener('click', (event) => {
      const target = event.target;
      const shouldFocus =
        target instanceof Element &&
        !!target.closest('.terminal-pane-terminal, .xterm, .xterm-helper-textarea');
      setActivePane(pane.id, { focus: shouldFocus });
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
    if (Array.isArray(pane.parserGuardDisposables) && pane.parserGuardDisposables.length > 0) {
      pane.parserGuardDisposables.forEach((disposable) => {
        if (disposable && typeof disposable.dispose === 'function') {
          disposable.dispose();
        }
      });
      pane.parserGuardDisposables.length = 0;
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

  function getPaneViewportElement(pane) {
    if (!pane || !pane.rootEl) {
      return null;
    }
    const viewport = pane.rootEl.querySelector('.xterm-viewport');
    return viewport instanceof HTMLElement ? viewport : null;
  }

  function findPaneByViewportElement(viewportEl) {
    if (!(viewportEl instanceof HTMLElement)) {
      return null;
    }
    let matchedPane = null;
    panes.forEach((pane) => {
      if (matchedPane) {
        return;
      }
      const paneViewport = getPaneViewportElement(pane);
      if (paneViewport && paneViewport === viewportEl) {
        matchedPane = pane;
      }
    });
    return matchedPane;
  }

  function readPaneViewportY(pane) {
    if (!pane || !pane.terminal || !pane.terminal.buffer || !pane.terminal.buffer.active) {
      return Number.NaN;
    }
    const viewportY = Number(pane.terminal.buffer.active.viewportY);
    return Number.isFinite(viewportY) ? viewportY : Number.NaN;
  }

  function scrollPaneByLines(pane, deltaLines) {
    if (!pane || !pane.terminal || typeof pane.terminal.scrollLines !== 'function') {
      return false;
    }
    const safeDelta = Number.isFinite(deltaLines) ? Math.trunc(deltaLines) : 0;
    if (!safeDelta) {
      return false;
    }

    const beforeViewportY = readPaneViewportY(pane);
    const viewportEl = getPaneViewportElement(pane);
    const beforeScrollTop = viewportEl ? viewportEl.scrollTop : Number.NaN;

    pane.terminal.scrollLines(safeDelta);

    const afterViewportY = readPaneViewportY(pane);
    if (Number.isFinite(beforeViewportY) && Number.isFinite(afterViewportY) && beforeViewportY !== afterViewportY) {
      return true;
    }
    if (viewportEl) {
      const terminalRows = Number.isFinite(pane.terminal.rows) ? pane.terminal.rows : 0;
      const estimatedLineHeight = terminalRows > 0 ? viewportEl.clientHeight / terminalRows : 0;
      const fallbackLineHeight = estimatedLineHeight > 0 ? estimatedLineHeight : 18;
      const fallbackDeltaPx = Math.max(20, Math.round(Math.abs(safeDelta) * fallbackLineHeight));
      viewportEl.scrollTop += safeDelta > 0 ? fallbackDeltaPx : -fallbackDeltaPx;
      if (!Number.isFinite(beforeScrollTop) || viewportEl.scrollTop !== beforeScrollTop) {
        return true;
      }
    }
    if (!Number.isFinite(beforeViewportY) || !Number.isFinite(afterViewportY)) {
      return true;
    }
    return false;
  }

  function clampIndex(value, maxInclusive) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(maxInclusive, Math.floor(value)));
  }

  function resolveActiveCellFromPoint(clientX, clientY) {
    const pane = getActivePane();
    if (!pane || !pane.terminal || !pane.rootEl) {
      return null;
    }
    const screenEl = pane.rootEl.querySelector('.xterm-screen');
    if (!(screenEl instanceof HTMLElement)) {
      return null;
    }
    const rect = screenEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || pane.terminal.cols <= 0 || pane.terminal.rows <= 0) {
      return null;
    }
    const safeX = Number(clientX);
    const safeY = Number(clientY);
    if (!Number.isFinite(safeX) || !Number.isFinite(safeY)) {
      return null;
    }
    const relX = Math.max(0, Math.min(rect.width - 0.001, safeX - rect.left));
    const relY = Math.max(0, Math.min(rect.height - 0.001, safeY - rect.top));
    const col = clampIndex((relX / rect.width) * pane.terminal.cols, pane.terminal.cols - 1);
    const viewportRow = clampIndex((relY / rect.height) * pane.terminal.rows, pane.terminal.rows - 1);
    const viewportY = Number(
      pane.terminal.buffer &&
        pane.terminal.buffer.active &&
        Number.isFinite(pane.terminal.buffer.active.viewportY)
        ? pane.terminal.buffer.active.viewportY
        : 0
    );
    const maxBufferRow = Number(
      pane.terminal.buffer &&
        pane.terminal.buffer.active &&
        Number.isFinite(pane.terminal.buffer.active.length)
        ? Math.max(0, pane.terminal.buffer.active.length - 1)
        : pane.terminal.rows - 1
    );
    const row = clampIndex(viewportY + viewportRow, maxBufferRow);
    return {
      col,
      row
    };
  }

  function resolveClientPointFromActiveCell(cell, options = {}) {
    const pane = getActivePane();
    if (!pane || !pane.terminal || !pane.rootEl || !cell) {
      return null;
    }
    const screenEl = pane.rootEl.querySelector('.xterm-screen');
    if (!(screenEl instanceof HTMLElement)) {
      return null;
    }
    const rect = screenEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || pane.terminal.cols <= 0 || pane.terminal.rows <= 0) {
      return null;
    }
    const cols = Math.max(1, pane.terminal.cols);
    const rows = Math.max(1, pane.terminal.rows);
    const viewportY = Number(
      pane.terminal.buffer &&
        pane.terminal.buffer.active &&
        Number.isFinite(pane.terminal.buffer.active.viewportY)
        ? pane.terminal.buffer.active.viewportY
        : 0
    );
    const maxBufferRow = Number(
      pane.terminal.buffer &&
        pane.terminal.buffer.active &&
        Number.isFinite(pane.terminal.buffer.active.length)
        ? Math.max(0, pane.terminal.buffer.active.length - 1)
        : pane.terminal.rows - 1
    );
    const col = clampIndex(Number(cell.col), cols - 1);
    const row = clampIndex(Number(cell.row), maxBufferRow);
    const viewportRow = row - viewportY;
    if (!Number.isFinite(viewportRow) || viewportRow < 0 || viewportRow >= rows) {
      return null;
    }
    const colWidth = rect.width / cols;
    const rowHeight = rect.height / rows;
    if (!Number.isFinite(colWidth) || !Number.isFinite(rowHeight) || colWidth <= 0 || rowHeight <= 0) {
      return null;
    }
    const edge = options && options.edge === 'end' ? 'end' : 'start';
    const edgeCol = edge === 'end' ? col + 1 : col;
    const safeEdgeCol = Math.max(0, Math.min(cols, edgeCol));
    return {
      x: rect.left + safeEdgeCol * colWidth,
      y: rect.top + (viewportRow + 1) * rowHeight
    };
  }

  function compareCells(a, b) {
    if (a.row === b.row) {
      return a.col - b.col;
    }
    return a.row - b.row;
  }

  function selectActiveRange(anchorCell, focusCell) {
    const pane = getActivePane();
    if (!pane || !pane.terminal || typeof pane.terminal.select !== 'function') {
      return false;
    }
    if (!anchorCell || !focusCell) {
      return false;
    }
    const cols = Math.max(1, pane.terminal.cols);
    const maxBufferRow = Number(
      pane.terminal.buffer &&
        pane.terminal.buffer.active &&
        Number.isFinite(pane.terminal.buffer.active.length)
        ? Math.max(0, pane.terminal.buffer.active.length - 1)
        : pane.terminal.rows - 1
    );
    const anchor = {
      col: clampIndex(anchorCell.col, cols - 1),
      row: clampIndex(anchorCell.row, maxBufferRow)
    };
    const focus = {
      col: clampIndex(focusCell.col, cols - 1),
      row: clampIndex(focusCell.row, maxBufferRow)
    };
    const start = compareCells(anchor, focus) <= 0 ? anchor : focus;
    const end = compareCells(anchor, focus) <= 0 ? focus : anchor;
    const length = Math.max(1, (end.row - start.row) * cols + (end.col - start.col) + 1);
    pane.terminal.select(start.col, start.row, length);
    return true;
  }

  return {
    init() {
      if (!TerminalCtor || !FitAddonCtor || !DOM.terminalWrap || !DOM.terminalGrid) {
        statusBar.setText('xterm.js 本地资源加载失败');
        toast.show('xterm.js 本地资源加载失败', 'danger');
        return;
      }
      const persistedFontSize = readPersistedTerminalFontSize();
      if (persistedFontSize > 0) {
        State.terminalFontSize = persistedFontSize;
      }
      State.terminalFontSize = clampFontSize(State.terminalFontSize || DEFAULT_FONT_SIZE);
      persistTerminalFontSize(State.terminalFontSize);
      if (panes.size === 0) {
        const firstPane = createPane();
        if (!firstPane) {
          statusBar.setText('终端初始化失败');
          return;
        }
        setActivePane(firstPane.id, { focus: false });
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
        setActivePane(pane.id, { focus: false });
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
        await connectPane(pane, sessionId, {
          clearTerminal: true,
          replayFrom: getSessionOffset(sessionId),
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
      setActivePane(pane.id, { focus: false });
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
        schedulePaneRefresh(pane);
      });
      persistTerminalFontSize(nextSize);
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
    },

    suppressActivePaneFocus(durationMs = 0) {
      suppressActivePaneFocusFor(durationMs);
      return true;
    },

    blurActivePane() {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.classList.contains('xterm-helper-textarea')) {
        return false;
      }
      active.blur();
      return true;
    },

    setActivePaneById(paneId, options = {}) {
      if (!paneId || !getPane(paneId)) {
        return false;
      }
      setActivePane(paneId, options);
      return true;
    },

    removePaneById(paneId, options = {}) {
      if (!paneId) {
        return false;
      }
      return removePane(paneId, {
        allowEmpty: !!options.allowEmpty
      });
    },

    isActivePaneTouchScrollModeEnabled() {
      return !!getActivePane();
    },

    setActivePaneTouchScrollMode() {
      return !!getActivePane();
    },

    toggleActivePaneTouchScrollMode() {
      return !!getActivePane();
    },

    getActivePaneViewportElement() {
      return getPaneViewportElement(getActivePane());
    },

    resolveActiveCellFromClientPoint(clientX, clientY) {
      return resolveActiveCellFromPoint(clientX, clientY);
    },

    resolveActiveClientPointFromCell(cell, options = {}) {
      return resolveClientPointFromActiveCell(cell, options);
    },

    selectActiveRange(anchorCell, focusCell) {
      return selectActiveRange(anchorCell, focusCell);
    },

    scrollActivePaneByLines(deltaLines) {
      const pane = getActivePane();
      return scrollPaneByLines(pane, deltaLines);
    },

    scrollPaneByViewportElement(viewportEl, deltaLines) {
      const pane = findPaneByViewportElement(viewportEl);
      return scrollPaneByLines(pane, deltaLines);
    },

    scrollActivePaneNearBottom(contextLines = 0) {
      const pane = getActivePane();
      if (!pane || !pane.terminal || typeof pane.terminal.scrollToBottom !== 'function') {
        return false;
      }
      pane.terminal.scrollToBottom();
      if (typeof pane.terminal.scrollLines === 'function') {
        const safeContextLines = Number.isFinite(contextLines) ? Math.max(0, Math.floor(contextLines)) : 0;
        if (safeContextLines > 0) {
          pane.terminal.scrollLines(-safeContextLines);
        }
      }
      return true;
    }
  };
}
