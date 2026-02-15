(function () {
  const DOM = {
    terminalRoot: document.getElementById('terminal'),
    terminalWrap: document.getElementById('terminal-wrap'),
    statusText: document.getElementById('status-text'),
    cwdText: document.getElementById('cwd-text'),
    controlSignal: document.getElementById('control-signal'),
    terminalSignal: document.getElementById('terminal-signal'),
    sessionPill: document.getElementById('session-pill'),
    dock: document.getElementById('dock'),
    dockHandle: document.getElementById('dock-handle'),
    sessionTabs: document.getElementById('session-tabs'),
    quickKeys: document.getElementById('quick-keys'),
    detachBtn: document.getElementById('detach-btn'),
    killBtn: document.getElementById('kill-btn'),
    toastRoot: document.getElementById('toast-root')
  };

  const TOKEN_STORAGE_KEY = 'c2p_token';
  const SIGNAL_STATES = ['is-online', 'is-warn', 'is-offline'];
  const QUICK_KEY_SEQUENCES = {
    'ctrl-c': '\x03',
    tab: '\t',
    'shift-tab': '\x1b[Z',
    '/': '/',
    up: '\x1b[A',
    down: '\x1b[B',
    esc: '\x1b',
    enter: '\r'
  };
  const KEYBOARD_VISIBLE_THRESHOLD_PX = 80;
  const ZOOM_SCALE_EPSILON = 0.02;
  const ZOOM_SETTLE_MS = 260;
  const TERMINAL_WRITE_HIGH_WATER_BYTES = 256 * 1024;
  const TERMINAL_WRITE_LOW_WATER_BYTES = 96 * 1024;
  const TERMINAL_INPUT_DIRECT_CHARS = 8;
  const TERMINAL_INPUT_BATCH_CHARS = 4096;
  const RESIZE_DEBOUNCE_MS = 90;
  const KILL_REQUEST_TIMEOUT_MS = 6000;
  const TERMINAL_REPLAY_TAIL_BYTES = 64 * 1024;
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
  const WebglAddonCtor =
    (window.WebglAddon && window.WebglAddon.WebglAddon) ||
    (window.WebglAddon && window.WebglAddon.default) ||
    window.WebglAddon;

  const State = {
    token: '',
    controlSocket: null,
    terminalSocket: null,
    terminal: null,
    fitAddon: null,
    webglAddon: null,
    terminalInputDisposable: null,
    terminalInputQueue: '',
    terminalInputRafId: 0,
    terminalWriteQueue: [],
    terminalWriteQueuedBytes: 0,
    terminalWriteInProgress: false,
    terminalBackpressured: false,
    resizeObserver: null,
    resizeRafId: 0,
    resizeDebounceTimer: 0,
    keyboardVisible: false,
    pendingResizeAfterKeyboard: false,
    zoomActive: false,
    zoomNoticeShown: false,
    zoomSettleTimer: 0,
    lastResizeSessionId: '',
    lastResizeCols: 0,
    lastResizeRows: 0,
    dockMeasureRafId: 0,
    controlConnected: false,
    terminalConnected: false,
    terminalReconnectDelayMs: 1000,
    terminalReconnectTimer: 0,
    terminalConnectSeq: 0,
    reconnectDelayMs: 1000,
    reconnectTimer: 0,
    initialSessionsReceived: false,
    currentSessionId: '',
    cwd: '',
    pushRegistered: false,
    pushAutoRequested: false,
    serviceWorkerRegistration: null,
    sessionOffsets: {},
    killConfirmTimer: 0,
    killRequestTimer: 0,
    killConfirmArmed: false,
    killInFlight: false,
    killRequested: false
  };

  function setSignalState(signalEl, stateClass) {
    if (!signalEl) {
      return;
    }
    signalEl.classList.remove(...SIGNAL_STATES);
    signalEl.classList.add(stateClass);
  }

  function shortenSessionId(sessionId) {
    if (sessionId.length <= 12) {
      return sessionId;
    }
    return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`;
  }

  function normalizeSessionEntry(entry) {
    if (!entry) {
      return null;
    }
    if (typeof entry === 'string') {
      return {
        id: entry,
        cli: '',
        cwd: ''
      };
    }
    if (typeof entry !== 'object') {
      return null;
    }
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) {
      return null;
    }
    return {
      id,
      cli: typeof entry.cli === 'string' ? entry.cli : '',
      cwd: typeof entry.cwd === 'string' ? entry.cwd : ''
    };
  }

  function readTokenFromHash() {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (!hash) {
      return '';
    }
    const params = new URLSearchParams(hash.includes('=') ? hash : `token=${hash}`);
    return params.get('token') || '';
  }

  function apiUrl(path) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set('token', State.token);
    return url.toString();
  }

  function wsUrl(path, extraParams) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(path, `${protocol}//${window.location.host}`);
    url.searchParams.set('token', State.token);
    if (extraParams) {
      Object.keys(extraParams).forEach((key) => {
        const value = extraParams[key];
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.toString();
  }

  function getSessionOffset(sessionId) {
    if (!sessionId) {
      return 0;
    }
    const value = State.sessionOffsets[sessionId];
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  function setSessionOffset(sessionId, offset) {
    if (!sessionId) {
      return;
    }
    const nextOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    State.sessionOffsets[sessionId] = nextOffset;
  }

  function addSessionOffset(sessionId, delta) {
    if (!sessionId || !Number.isFinite(delta) || delta <= 0) {
      return;
    }
    const next = getSessionOffset(sessionId) + Math.floor(delta);
    State.sessionOffsets[sessionId] = next;
  }

  function pruneSessionOffsets(sessionIds) {
    const keep = new Set(sessionIds);
    Object.keys(State.sessionOffsets).forEach((sessionId) => {
      if (!keep.has(sessionId)) {
        delete State.sessionOffsets[sessionId];
      }
    });
  }

  async function fetchSessionLogBytes(sessionId) {
    if (!sessionId) {
      return 0;
    }
    try {
      const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/log`), { method: 'HEAD' });
      if (!response.ok) {
        return 0;
      }
      const headerValue = response.headers.get('x-log-bytes') || response.headers.get('content-length') || '0';
      const parsed = Number.parseInt(headerValue, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
      }
      return parsed;
    } catch {
      return 0;
    }
  }

  function setActionButtonsEnabled(enabled) {
    const nextEnabled = !!enabled;
    if (DOM.detachBtn) {
      DOM.detachBtn.disabled = !nextEnabled;
    }
    if (DOM.killBtn) {
      DOM.killBtn.disabled = !nextEnabled || State.killInFlight;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(normalized);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      output[i] = raw.charCodeAt(i);
    }
    return output;
  }

  const Toast = {
    show(message, type = 'info') {
      if (!DOM.toastRoot || !message) {
        return;
      }
      const toast = document.createElement('div');
      toast.className = `toast is-${type}`;
      toast.textContent = message;
      DOM.toastRoot.appendChild(toast);

      window.setTimeout(() => {
        toast.classList.add('is-leaving');
      }, 1800);

      window.setTimeout(() => {
        toast.remove();
      }, 2100);
    }
  };

  const StatusBar = {
    setControl(state) {
      const cls = state === 'online' ? 'is-online' : state === 'warn' ? 'is-warn' : 'is-offline';
      setSignalState(DOM.controlSignal, cls);
    },
    setTerminal(state) {
      const cls = state === 'online' ? 'is-online' : state === 'warn' ? 'is-warn' : 'is-offline';
      setSignalState(DOM.terminalSignal, cls);
    },
    setText(text) {
      if (DOM.statusText) {
        DOM.statusText.textContent = text;
      }
    },
    setCwd(cwd) {
      if (DOM.cwdText) {
        DOM.cwdText.textContent = cwd || '-';
      }
    },
    setSession(sessionId) {
      if (!DOM.sessionPill) {
        return;
      }
      if (!sessionId) {
        DOM.sessionPill.hidden = true;
        DOM.sessionPill.dataset.sessionId = '';
        return;
      }
      DOM.sessionPill.hidden = false;
      DOM.sessionPill.dataset.sessionId = sessionId;
      DOM.sessionPill.textContent = `会话 ${shortenSessionId(sessionId)}`;
    }
  };

  const Dock = {
    updateHeight() {
      if (!DOM.dock) {
        return;
      }
      const height = Math.ceil(DOM.dock.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--dock-height', `${height}px`);
    },
    scheduleMeasure() {
      if (State.dockMeasureRafId) {
        return;
      }
      State.dockMeasureRafId = window.requestAnimationFrame(() => {
        State.dockMeasureRafId = 0;
        this.updateHeight();
        Term.scheduleResize();
      });
    },
    expand() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      DOM.dock.classList.add('is-expanded');
      DOM.dockHandle.setAttribute('aria-expanded', 'true');
      this.scheduleMeasure();
    },
    collapse() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      DOM.dock.classList.remove('is-expanded');
      DOM.dockHandle.setAttribute('aria-expanded', 'false');
      this.scheduleMeasure();
    },
    toggle() {
      if (!DOM.dock) {
        return;
      }
      if (DOM.dock.classList.contains('is-expanded')) {
        this.collapse();
      } else {
        this.expand();
      }
    },
    bind() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      DOM.dockHandle.addEventListener('click', () => this.toggle());

      let touchStartY = 0;
      DOM.dockHandle.addEventListener(
        'touchstart',
        (event) => {
          touchStartY = event.changedTouches[0].clientY;
        },
        { passive: true }
      );
      DOM.dockHandle.addEventListener(
        'touchend',
        (event) => {
          const touchEndY = event.changedTouches[0].clientY;
          const delta = touchEndY - touchStartY;
          if (delta < -18) {
            this.expand();
          }
          if (delta > 18) {
            this.collapse();
          }
        },
        { passive: true }
      );
      DOM.dock.addEventListener('transitionend', () => this.scheduleMeasure());
      window.addEventListener(
        'resize',
        () => {
          this.scheduleMeasure();
        },
        { passive: true }
      );
      this.scheduleMeasure();
    }
  };

  const SessionTabs = {
    bind() {
      if (!DOM.sessionTabs) {
        return;
      }
      DOM.sessionTabs.addEventListener('click', (event) => {
        const addButton = event.target.closest('.session-tab-add');
        if (addButton) {
          Actions.spawn();
          return;
        }
        const tab = event.target.closest('.session-tab[data-session-id]');
        if (!tab) {
          return;
        }
        const sessionId = tab.dataset.sessionId;
        if (!sessionId || sessionId === State.currentSessionId) {
          return;
        }
        State.currentSessionId = sessionId;
        State.killRequested = false;
        StatusBar.setSession(sessionId);
        if (tab.dataset.cwd) {
          State.cwd = tab.dataset.cwd;
          StatusBar.setCwd(tab.dataset.cwd);
        }
        Actions.resetKillRequest();
        setActionButtonsEnabled(true);
        Actions.resetKillConfirm();
        this.renderActiveState();
        void Term.connect(sessionId);
        Term.scheduleResize();
        StatusBar.setText(`已切换到会话 ${shortenSessionId(sessionId)}`);
      });
    },
    renderActiveState() {
      if (!DOM.sessionTabs) {
        return;
      }
      DOM.sessionTabs.querySelectorAll('.session-tab[data-session-id]').forEach((button) => {
        const active = button.dataset.sessionId === State.currentSessionId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    },
    update(list) {
      if (!DOM.sessionTabs) {
        return [];
      }
      const sessions = Array.isArray(list) ? list.map((item) => normalizeSessionEntry(item)).filter(Boolean) : [];
      pruneSessionOffsets(sessions.map((session) => session.id));
      DOM.sessionTabs.textContent = '';

      const fragment = document.createDocumentFragment();
      sessions.forEach((session) => {
        const button = document.createElement('button');
        const active = session.id === State.currentSessionId;
        button.type = 'button';
        button.className = active ? 'session-tab is-active' : 'session-tab';
        button.dataset.sessionId = session.id;
        if (session.cwd) {
          button.dataset.cwd = session.cwd;
          button.title = session.cwd;
        }
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        const cliLabel = session.cli || 'session';
        button.textContent = `${cliLabel} ${shortenSessionId(session.id)}`;
        fragment.appendChild(button);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'session-tab session-tab-add';
      add.setAttribute('aria-label', '添加新终端');
      add.title = '添加新终端';
      add.textContent = '+';
      fragment.appendChild(add);

      DOM.sessionTabs.appendChild(fragment);
      DOM.sessionTabs.hidden = false;
      return sessions;
    }
  };

  const Term = {
    init() {
      if (!TerminalCtor || !FitAddonCtor || !DOM.terminalRoot) {
        StatusBar.setText('xterm.js 本地资源加载失败');
        Toast.show('xterm.js 本地资源加载失败', 'danger');
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
              Toast.show('WebGL 上下文丢失，已回退默认渲染', 'warn');
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
      const sent = Control.send({
        type: 'resize',
        sessionId: State.currentSessionId,
        cols,
        rows
      });
      if (!sent) {
        return;
      }
      State.lastResizeSessionId = State.currentSessionId;
      State.lastResizeCols = cols;
      State.lastResizeRows = rows;
    },
    flushQueuedInput(socket) {
      if (!State.terminalInputQueue) {
        return;
      }
      socket.send(State.terminalInputQueue);
      State.terminalInputQueue = '';
    },
    sendData(data) {
      const socket = State.terminalSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (!data) {
        return true;
      }

      if (data.length <= TERMINAL_INPUT_DIRECT_CHARS && !State.terminalInputQueue) {
        socket.send(data);
        return true;
      }

      if (data.length >= TERMINAL_INPUT_BATCH_CHARS) {
        if (State.terminalInputRafId) {
          window.cancelAnimationFrame(State.terminalInputRafId);
          State.terminalInputRafId = 0;
        }
        this.flushQueuedInput(socket);
        socket.send(data);
        return true;
      }

      State.terminalInputQueue += data;
      if (State.terminalInputQueue.length >= TERMINAL_INPUT_BATCH_CHARS) {
        if (State.terminalInputRafId) {
          window.cancelAnimationFrame(State.terminalInputRafId);
          State.terminalInputRafId = 0;
        }
        this.flushQueuedInput(socket);
        return true;
      }

      if (!State.terminalInputRafId) {
        State.terminalInputRafId = window.requestAnimationFrame(() => {
          State.terminalInputRafId = 0;
          const activeSocket = State.terminalSocket;
          if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !State.terminalInputQueue) {
            return;
          }
          this.flushQueuedInput(activeSocket);
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
      StatusBar.setTerminal('offline');
    },
    scheduleTerminalReconnect(sessionId) {
      if (!sessionId || sessionId !== State.currentSessionId) {
        return;
      }
      this.cancelTerminalReconnect();
      const delay = State.terminalReconnectDelayMs;
      StatusBar.setTerminal('warn');
      StatusBar.setText(`终端连接断开，${Math.ceil(delay / 1000)}s 后重连...`);
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

      const extraParams = { session: sessionId };
      if (effectiveReplayFrom > 0) {
        extraParams.replayFrom = effectiveReplayFrom;
      }
      const socket = new WebSocket(wsUrl('/ws/terminal', extraParams));
      socket.binaryType = 'arraybuffer';
      State.terminalSocket = socket;
      StatusBar.setTerminal('warn');

      socket.onopen = () => {
        if (State.terminalSocket !== socket) {
          return;
        }
        State.terminalConnected = true;
        State.terminalReconnectDelayMs = 1000;
        StatusBar.setTerminal('online');
        StatusBar.setText(`会话 ${shortenSessionId(sessionId)} 已附加`);
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
          logBytes = event.data.byteLength;
          data = textDecoder.decode(event.data);
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

  const Control = {
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
        StatusBar.setText('控制消息解析失败');
        Toast.show('控制消息解析失败', 'danger');
        return;
      }

      if (payload.type === 'spawned' && payload.sessionId) {
        State.currentSessionId = payload.sessionId;
        State.killRequested = false;
        Actions.resetKillRequest();
        setSessionOffset(payload.sessionId, 0);
        if (typeof payload.cwd === 'string' && payload.cwd) {
          State.cwd = payload.cwd;
          StatusBar.setCwd(payload.cwd);
        }
        StatusBar.setSession(payload.sessionId);
        StatusBar.setTerminal('warn');
        setActionButtonsEnabled(true);
        Actions.resetKillConfirm();
        void Term.connect(payload.sessionId, { replayFrom: 0 });
        Term.scheduleResize();
        const cli = payload.cli || 'shell';
        StatusBar.setText(`已启动 ${cli}`);
        Toast.show(`已启动 ${cli}，会话已附加`, 'success');
        if (!State.pushAutoRequested && !State.pushRegistered && 'Notification' in window) {
          State.pushAutoRequested = true;
          void Actions
            .requestPush({
              silentPermissionDenied: true,
              silentFailure: true,
              showSuccessToast: false
            })
            .catch(() => {});
        }
        return;
      }

      if (payload.type === 'exited' && payload.sessionId === State.currentSessionId) {
        const code = Number.isFinite(payload.exitCode) ? payload.exitCode : Number(payload.exitCode) || 0;
        StatusBar.setText(`会话已退出 (code=${code})`);
        if (State.killRequested) {
          Toast.show('会话已终止', 'warn');
        } else {
          Toast.show(`会话已退出 (code=${code})`, code === 0 ? 'info' : 'danger');
        }
        delete State.sessionOffsets[payload.sessionId];
        State.currentSessionId = '';
        State.killRequested = false;
        Actions.resetKillRequest();
        StatusBar.setSession('');
        setActionButtonsEnabled(false);
        Actions.resetKillConfirm();
        Term.disconnect();
        return;
      }

      if (payload.type === 'sessions' && Array.isArray(payload.list)) {
        const isFirstSessionsMessage = !State.initialSessionsReceived;
        State.initialSessionsReceived = true;
        const sessions = SessionTabs.update(payload.list);

        if (State.currentSessionId) {
          const activeSession = sessions.find((item) => item.id === State.currentSessionId);
          if (!activeSession) {
            State.currentSessionId = '';
            State.killRequested = false;
            Actions.resetKillRequest();
            StatusBar.setSession('');
            setActionButtonsEnabled(false);
            Actions.resetKillConfirm();
            Term.disconnect();
          } else {
            if (activeSession.cwd) {
              State.cwd = activeSession.cwd;
              StatusBar.setCwd(activeSession.cwd);
            }
            const canReconnect =
              !State.terminalConnected &&
              (!State.terminalSocket || State.terminalSocket.readyState === WebSocket.CLOSED) &&
              !State.terminalReconnectTimer;
            if (canReconnect) {
              void Term.reconnect(activeSession.id);
              Term.scheduleResize();
            }
          }
        } else if (sessions.length > 0 && isFirstSessionsMessage) {
          const latest = sessions[sessions.length - 1];
          State.currentSessionId = latest.id;
          State.killRequested = false;
          Actions.resetKillRequest();
          StatusBar.setSession(latest.id);
          if (latest.cwd) {
            State.cwd = latest.cwd;
            StatusBar.setCwd(latest.cwd);
          }
          setActionButtonsEnabled(true);
          Actions.resetKillConfirm();
          void Term.reconnect(latest.id);
          Term.scheduleResize();
        } else if (sessions.length > 0) {
          setActionButtonsEnabled(false);
        } else if (isFirstSessionsMessage) {
          Actions.spawn();
        } else {
          setActionButtonsEnabled(false);
        }

        SessionTabs.renderActiveState();
        return;
      }

      if (payload.type === 'error') {
        const message = payload.message || '控制通道错误';
        StatusBar.setText(message);
        Toast.show(message, 'danger');
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
    connect() {
      if (!State.token) {
        StatusBar.setText('缺少 token，请使用 #token=... 打开');
        return;
      }
      if (
        State.controlSocket &&
        (State.controlSocket.readyState === WebSocket.OPEN ||
          State.controlSocket.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      StatusBar.setControl('warn');
      StatusBar.setText('正在连接控制通道...');
      const socket = new WebSocket(wsUrl('/ws/control'));
      State.controlSocket = socket;

      socket.onopen = () => {
        if (State.controlSocket !== socket) {
          return;
        }
        State.reconnectDelayMs = 1000;
        State.controlConnected = true;
        StatusBar.setControl('online');
        StatusBar.setText('控制通道已连接');
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
        StatusBar.setControl('warn');
        StatusBar.setText('连接断开，正在重连...');
        Toast.show('连接断开，正在重连...', 'warn');
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    }
  };

  const Actions = {
    bind() {
      if (DOM.detachBtn) {
        DOM.detachBtn.addEventListener('click', () => this.detach());
      }
      if (DOM.killBtn) {
        DOM.killBtn.addEventListener('click', () => this.kill());
      }
    },
    resetKillRequest() {
      if (State.killRequestTimer) {
        window.clearTimeout(State.killRequestTimer);
        State.killRequestTimer = 0;
      }
      State.killInFlight = false;
    },
    spawn() {
      if (!State.terminal) {
        Toast.show('终端尚未就绪', 'warn');
        return;
      }
      this.resetKillRequest();
      State.killRequested = false;
      this.resetKillConfirm();
      const ok = Control.send({
        type: 'spawn',
        cli: 'shell',
        cwd: State.cwd || undefined,
        cols: State.terminal.cols,
        rows: State.terminal.rows
      });
      if (!ok) {
        StatusBar.setText('控制通道未就绪');
        Toast.show('控制通道未就绪', 'warn');
        return;
      }
      StatusBar.setText('启动请求已发送');
      Dock.collapse();
    },
    detach() {
      if (!State.currentSessionId) {
        return;
      }
      const detachedSession = State.currentSessionId;
      State.currentSessionId = '';
      State.killRequested = false;
      this.resetKillRequest();
      this.resetKillConfirm();
      StatusBar.setSession('');
      setActionButtonsEnabled(false);
      SessionTabs.renderActiveState();
      Term.disconnect();
      if (State.terminal) {
        State.terminal.write('\x1bc');
      }
      StatusBar.setText(`已关闭会话 ${shortenSessionId(detachedSession)} 的终端连接`);
      Toast.show('终端已关闭，可点击会话标签重新附加', 'info');
    },
    resetKillConfirm() {
      if (State.killConfirmTimer) {
        window.clearTimeout(State.killConfirmTimer);
        State.killConfirmTimer = 0;
      }
      State.killConfirmArmed = false;
      if (DOM.killBtn) {
        DOM.killBtn.textContent = '终止会话';
        DOM.killBtn.classList.remove('is-confirm');
      }
    },
    kill() {
      if (!State.currentSessionId) {
        return;
      }
      if (State.killInFlight) {
        return;
      }
      if (!State.killConfirmArmed) {
        State.killConfirmArmed = true;
        if (DOM.killBtn) {
          DOM.killBtn.textContent = '确认终止';
          DOM.killBtn.classList.add('is-confirm');
        }
        StatusBar.setText('再次点击以确认终止');
        State.killConfirmTimer = window.setTimeout(() => {
          this.resetKillConfirm();
        }, 3000);
        return;
      }

      const ok = Control.send({
        type: 'kill',
        sessionId: State.currentSessionId
      });
      this.resetKillConfirm();
      if (!ok) {
        Toast.show('终止请求发送失败', 'danger');
        return;
      }
      State.killRequested = true;
      State.killInFlight = true;
      setActionButtonsEnabled(false);
      StatusBar.setText('终止请求已发送，等待会话退出...');
      Toast.show('终止请求已发送', 'warn');
      State.killRequestTimer = window.setTimeout(() => {
        State.killRequestTimer = 0;
        if (!State.killInFlight || !State.currentSessionId) {
          return;
        }
        State.killInFlight = false;
        State.killRequested = false;
        setActionButtonsEnabled(true);
        StatusBar.setText('终止超时，可重试');
        Toast.show('终止超时，可再次尝试', 'warn');
      }, KILL_REQUEST_TIMEOUT_MS);
    },
    async initServiceWorker() {
      if (!('serviceWorker' in navigator)) {
        return;
      }
      try {
        State.serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
      } catch {
        StatusBar.setText('Service Worker 注册失败');
      }
    },
    async requestPush(options = {}) {
      const {
        silentPermissionDenied = false,
        silentFailure = false,
        showSuccessToast = true
      } = options;
      if (State.pushRegistered) {
        if (!silentFailure && showSuccessToast) {
          Toast.show('通知已启用', 'info');
        }
        return;
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (!silentFailure) {
          Toast.show('当前浏览器不支持推送通知', 'warn');
        }
        return;
      }
      const keyResp = await fetch(apiUrl('/api/vapid-public-key'));
      if (!keyResp.ok) {
        if (!silentFailure) {
          Toast.show('通知订阅失败', 'danger');
        }
        throw new Error('vapid key fetch failed');
      }
      const keyData = await keyResp.json();
      if (!keyData.publicKey) {
        if (!silentFailure) {
          Toast.show('通知订阅失败', 'danger');
        }
        throw new Error('missing public key');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (!silentPermissionDenied && !silentFailure) {
          Toast.show('通知权限未授予', 'warn');
        }
        return;
      }

      let registration = State.serviceWorkerRegistration;
      if (!registration) {
        registration = await navigator.serviceWorker.register('/sw.js');
        State.serviceWorkerRegistration = registration;
      }

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        }));

      const saveResp = await fetch(apiUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(subscription)
      });

      if (!saveResp.ok) {
        if (!silentFailure) {
          Toast.show('通知订阅失败', 'danger');
        }
        throw new Error('subscribe save failed');
      }
      State.pushRegistered = true;
      if (showSuccessToast && !silentFailure) {
        Toast.show('通知订阅完成', 'success');
      }
    }
  };

  const QuickKeys = {
    bind() {
      if (!DOM.quickKeys) {
        return;
      }
      DOM.quickKeys.addEventListener('click', (event) => {
        const button = event.target.closest('[data-key]');
        if (!button) {
          return;
        }
        const sequence = QUICK_KEY_SEQUENCES[button.dataset.key];
        if (!sequence) {
          return;
        }
        const sent = Term.sendData(sequence);
        if (!sent) {
          Toast.show('终端未连接', 'warn');
          return;
        }
        if (navigator.vibrate) {
          navigator.vibrate(10);
        }
      });
    }
  };

  const Viewport = {
    clearZoomSettleTimer() {
      if (!State.zoomSettleTimer) {
        return;
      }
      window.clearTimeout(State.zoomSettleTimer);
      State.zoomSettleTimer = 0;
    },
    scheduleZoomSettleCheck() {
      this.clearZoomSettleTimer();
      State.zoomSettleTimer = window.setTimeout(() => {
        State.zoomSettleTimer = 0;
        if (!window.visualViewport) {
          State.zoomActive = false;
          State.zoomNoticeShown = false;
          return;
        }
        const scale = Number(window.visualViewport.scale) || 1;
        if (Math.abs(scale - 1) > ZOOM_SCALE_EPSILON) {
          return;
        }
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        this.applyInset();
        Term.scheduleResize(true);
      }, ZOOM_SETTLE_MS);
    },
    applyInset() {
      if (!window.visualViewport) {
        this.clearZoomSettleTimer();
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        if (State.keyboardVisible) {
          State.keyboardVisible = false;
          if (State.pendingResizeAfterKeyboard) {
            State.pendingResizeAfterKeyboard = false;
            Term.scheduleResize(true);
          }
        }
        return;
      }
      const viewport = window.visualViewport;
      const scale = Number(viewport.scale) || 1;
      const zoomed = Math.abs(scale - 1) > ZOOM_SCALE_EPSILON;
      if (zoomed) {
        State.zoomActive = true;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        if (State.keyboardVisible) {
          State.keyboardVisible = false;
          State.pendingResizeAfterKeyboard = false;
        }
        if (!State.zoomNoticeShown) {
          State.zoomNoticeShown = true;
          Toast.show('检测到页面缩放，已暂停终端重排', 'warn');
        }
        this.scheduleZoomSettleCheck();
        return;
      }
      this.clearZoomSettleTimer();
      State.zoomActive = false;
      const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--dock-bottom-offset', `${Math.round(keyboardOffset)}px`);

      const nextKeyboardVisible = keyboardOffset > KEYBOARD_VISIBLE_THRESHOLD_PX;
      if (nextKeyboardVisible !== State.keyboardVisible) {
        State.keyboardVisible = nextKeyboardVisible;
        if (!nextKeyboardVisible && State.pendingResizeAfterKeyboard) {
          State.pendingResizeAfterKeyboard = false;
          Term.scheduleResize(true);
        }
      }
      if (!nextKeyboardVisible) {
        Term.scheduleResize();
      }
    },
    bind() {
      this.applyInset();
      if (!window.visualViewport) {
        return;
      }
      window.visualViewport.addEventListener(
        'resize',
        () => {
          this.applyInset();
        },
        { passive: true }
      );
      window.visualViewport.addEventListener(
        'scroll',
        () => {
          this.applyInset();
        },
        { passive: true }
      );
    }
  };

  const Auth = {
    init() {
      const hashToken = readTokenFromHash();
      if (hashToken) {
        localStorage.setItem(TOKEN_STORAGE_KEY, hashToken);
        State.token = hashToken;
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        return;
      }
      State.token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }
  };

  const Runtime = {
    async load() {
      if (!State.token) {
        StatusBar.setCwd('-');
        return;
      }
      try {
        const response = await fetch(apiUrl('/api/runtime'));
        if (!response.ok) {
          throw new Error('runtime fetch failed');
        }
        const payload = await response.json();
        if (payload && typeof payload.cwd === 'string' && payload.cwd) {
          State.cwd = payload.cwd;
          StatusBar.setCwd(payload.cwd);
          return;
        }
      } catch {
        // keep existing cwd fallback
      }
      StatusBar.setCwd(State.cwd || '-');
    }
  };

  function bindSessionCopy() {
    if (!DOM.sessionPill) {
      return;
    }
    DOM.sessionPill.addEventListener('click', async () => {
      const sessionId = DOM.sessionPill.dataset.sessionId;
      if (!sessionId) {
        return;
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        Toast.show('当前环境不支持复制', 'warn');
        return;
      }
      try {
        await navigator.clipboard.writeText(sessionId);
        Toast.show('会话 ID 已复制', 'success');
      } catch {
        Toast.show('复制会话 ID 失败', 'danger');
      }
    });
  }

  function bootstrap() {
    StatusBar.setControl('offline');
    StatusBar.setTerminal('offline');
    StatusBar.setSession('');
    StatusBar.setText('初始化中...');
    StatusBar.setCwd('读取中...');
    setActionButtonsEnabled(false);

    SessionTabs.bind();
    Dock.bind();
    Dock.updateHeight();
    QuickKeys.bind();
    bindSessionCopy();
    Actions.bind();
    Auth.init();
    Term.init();
    Viewport.bind();
    Actions.initServiceWorker().catch(() => {});
    Runtime.load().finally(() => {
      Control.connect();
    });
    window.setTimeout(() => {
      Dock.updateHeight();
      Term.scheduleResize(true);
    }, 300);
  }

  bootstrap();
})();
