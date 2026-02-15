export const DOM = {
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

export const TOKEN_STORAGE_KEY = 'c2p_token';
export const SIGNAL_STATES = ['is-online', 'is-warn', 'is-offline'];
export const QUICK_KEY_SEQUENCES = {
  'ctrl-c': '\x03',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  '/': '/',
  up: '\x1b[A',
  down: '\x1b[B',
  esc: '\x1b',
  enter: '\r'
};
export const KEYBOARD_VISIBLE_THRESHOLD_PX = 80;
export const ZOOM_SCALE_EPSILON = 0.02;
export const ZOOM_SETTLE_MS = 260;
export const TERMINAL_WRITE_HIGH_WATER_BYTES = 256 * 1024;
export const TERMINAL_WRITE_LOW_WATER_BYTES = 96 * 1024;
export const TERMINAL_INPUT_DIRECT_CHARS = 8;
export const TERMINAL_INPUT_BATCH_CHARS = 4096;
export const RESIZE_DEBOUNCE_MS = 90;
export const KILL_REQUEST_TIMEOUT_MS = 6000;
export const TERMINAL_REPLAY_TAIL_BYTES = 64 * 1024;

export const textDecoder = new TextDecoder();
export const textEncoder = new TextEncoder();

export const TerminalCtor = window.Terminal;
export const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
export const WebglAddonCtor =
  (window.WebglAddon && window.WebglAddon.WebglAddon) ||
  (window.WebglAddon && window.WebglAddon.default) ||
  window.WebglAddon;

export const State = {
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

export function setSignalState(signalEl, stateClass) {
  if (!signalEl) {
    return;
  }
  signalEl.classList.remove(...SIGNAL_STATES);
  signalEl.classList.add(stateClass);
}

export function shortenSessionId(sessionId) {
  if (sessionId.length <= 12) {
    return sessionId;
  }
  return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`;
}

export function normalizeSessionEntry(entry) {
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

export function readTokenFromHash() {
  const hash = window.location.hash.replace(/^#/, '').trim();
  if (!hash) {
    return '';
  }
  const params = new URLSearchParams(hash.includes('=') ? hash : `token=${hash}`);
  return params.get('token') || '';
}

export function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('token', State.token);
  return url.toString();
}

export function wsUrl(path, extraParams) {
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

export function getSessionOffset(sessionId) {
  if (!sessionId) {
    return 0;
  }
  const value = State.sessionOffsets[sessionId];
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

export function setSessionOffset(sessionId, offset) {
  if (!sessionId) {
    return;
  }
  const nextOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  State.sessionOffsets[sessionId] = nextOffset;
}

export function addSessionOffset(sessionId, delta) {
  if (!sessionId || !Number.isFinite(delta) || delta <= 0) {
    return;
  }
  const next = getSessionOffset(sessionId) + Math.floor(delta);
  State.sessionOffsets[sessionId] = next;
}

export function pruneSessionOffsets(sessionIds) {
  const keep = new Set(sessionIds);
  Object.keys(State.sessionOffsets).forEach((sessionId) => {
    if (!keep.has(sessionId)) {
      delete State.sessionOffsets[sessionId];
    }
  });
}

export async function fetchSessionLogBytes(sessionId) {
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

export function setActionButtonsEnabled(enabled) {
  const nextEnabled = !!enabled;
  if (DOM.detachBtn) {
    DOM.detachBtn.disabled = !nextEnabled;
  }
  if (DOM.killBtn) {
    DOM.killBtn.disabled = !nextEnabled || State.killInFlight;
  }
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
