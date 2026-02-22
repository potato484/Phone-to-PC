export const DOM = {
  terminalRoot: document.getElementById('terminal'),
  terminalWrap: document.getElementById('terminal-wrap'),
  terminalGrid: document.getElementById('terminal-grid'),
  terminalReconnect: document.getElementById('terminal-reconnect'),
  terminalReconnectText: document.getElementById('terminal-reconnect-text'),
  terminalReconnectFill: document.getElementById('terminal-reconnect-fill'),
  statusText: document.getElementById('status-text'),
  cwdText: document.getElementById('cwd-text'),
  controlSignal: document.getElementById('control-signal'),
  terminalSignal: document.getElementById('terminal-signal'),
  sessionPill: document.getElementById('session-pill'),
  sideActions: document.getElementById('side-actions'),
  sideActionsToggle: document.getElementById('side-actions-toggle'),
  sideActionsMenu: document.getElementById('side-actions-menu'),
  spawnSessionBtn: document.getElementById('spawn-session-btn'),
  dock: document.getElementById('dock'),
  dockHandle: document.getElementById('dock-handle'),
  quickKeysToggle: document.getElementById('quick-keys-toggle'),
  sessionTabs: document.getElementById('session-tabs'),
  quickKeys: document.getElementById('quick-keys'),
  filesPath: document.getElementById('files-path'),
  filesScopePill: document.getElementById('files-scope-pill'),
  filesList: document.getElementById('files-list'),
  filesRootBtn: document.getElementById('files-root-btn'),
  filesRefreshBtn: document.getElementById('files-refresh-btn'),
  filesHiddenBtn: document.getElementById('files-hidden-btn'),
  filesUpBtn: document.getElementById('files-up-btn'),
  filesNewfileBtn: document.getElementById('files-newfile-btn'),
  filesMkdirBtn: document.getElementById('files-mkdir-btn'),
  filesUploadBtn: document.getElementById('files-upload-btn'),
  filesUploadInput: document.getElementById('files-upload-input'),
  filesEditorDialog: document.getElementById('files-editor-dialog'),
  filesSearchInput: document.getElementById('files-search-input'),
  filesEditorPath: document.getElementById('files-editor-path'),
  filesEditor: document.getElementById('files-editor'),
  filesMdToggleBtn: document.getElementById('files-md-toggle-btn'),
  filesMdPreview: document.getElementById('files-md-preview'),
  filesImgPreview: document.getElementById('files-img-preview'),
  filesEditorSaveBtn: document.getElementById('files-editor-save-btn'),
  filesEditorCancelBtn: document.getElementById('files-editor-cancel-btn'),
  monitorPanel: document.getElementById('monitor-panel'),
  monitorUpdatedAt: document.getElementById('monitor-updated-at'),
  monitorCpuFill: document.getElementById('monitor-cpu-fill'),
  monitorCpuText: document.getElementById('monitor-cpu-text'),
  monitorMemoryFill: document.getElementById('monitor-memory-fill'),
  monitorMemoryText: document.getElementById('monitor-memory-text'),
  monitorDiskFill: document.getElementById('monitor-disk-fill'),
  monitorDiskText: document.getElementById('monitor-disk-text'),
  monitorNetRxText: document.getElementById('monitor-net-rx-text'),
  monitorNetTxText: document.getElementById('monitor-net-tx-text'),
  monitorUptimeText: document.getElementById('monitor-uptime-text'),
  monitorCqsText: document.getElementById('monitor-cqs-text'),
  monitorRttText: document.getElementById('monitor-rtt-text'),
  monitorJitterText: document.getElementById('monitor-jitter-text'),
  monitorLossText: document.getElementById('monitor-loss-text'),
  monitorProfileText: document.getElementById('monitor-profile-text'),
  prefThemeSelect: document.getElementById('pref-theme'),
  prefContrastSelect: document.getElementById('pref-contrast'),
  prefMotionSelect: document.getElementById('pref-motion'),
  prefTransparencySelect: document.getElementById('pref-transparency'),
  toastRoot: document.getElementById('toast-root')
};

export const TOKEN_STORAGE_KEY = 'c2p_token';
export const TOKEN_EXPIRES_AT_STORAGE_KEY = 'c2p_token_expires_at';
export const TERMINAL_FONT_SIZE_STORAGE_KEY = 'c2p_terminal_font_size';

function safeStorageGet(storage, key) {
  if (!storage) {
    return '';
  }
  try {
    return storage.getItem(key) || '';
  } catch {
    return '';
  }
}

function safeStorageSet(storage, key, value) {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage write failures (quota/privacy mode).
  }
}

function safeStorageRemove(storage, key) {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage write failures (quota/privacy mode).
  }
}

export function persistTokenExpiry(expiresAt) {
  const value = typeof expiresAt === 'string' ? expiresAt : '';
  if (value) {
    safeStorageSet(window.sessionStorage, TOKEN_EXPIRES_AT_STORAGE_KEY, value);
    safeStorageSet(window.localStorage, TOKEN_EXPIRES_AT_STORAGE_KEY, value);
    return;
  }
  safeStorageRemove(window.sessionStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
  safeStorageRemove(window.localStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
}

export function persistAccessToken(accessToken, expiresAt = '') {
  const token = typeof accessToken === 'string' ? accessToken : '';
  if (token) {
    safeStorageSet(window.sessionStorage, TOKEN_STORAGE_KEY, token);
    safeStorageSet(window.localStorage, TOKEN_STORAGE_KEY, token);
  } else {
    safeStorageRemove(window.sessionStorage, TOKEN_STORAGE_KEY);
    safeStorageRemove(window.localStorage, TOKEN_STORAGE_KEY);
  }
  persistTokenExpiry(expiresAt);
}

export function clearPersistedAccessToken() {
  safeStorageRemove(window.sessionStorage, TOKEN_STORAGE_KEY);
  safeStorageRemove(window.sessionStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
  safeStorageRemove(window.localStorage, TOKEN_STORAGE_KEY);
  safeStorageRemove(window.localStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
}

export function readPersistedAccessToken() {
  const sessionToken = safeStorageGet(window.sessionStorage, TOKEN_STORAGE_KEY);
  const sessionExpiresAt = safeStorageGet(window.sessionStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
  if (sessionToken) {
    return {
      token: sessionToken,
      expiresAt: sessionExpiresAt
    };
  }

  const fallbackToken = safeStorageGet(window.localStorage, TOKEN_STORAGE_KEY);
  const fallbackExpiresAt = safeStorageGet(window.localStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
  if (!fallbackToken) {
    return {
      token: '',
      expiresAt: ''
    };
  }

  // Rehydrate sessionStorage so same-tab reload behavior stays unchanged afterwards.
  safeStorageSet(window.sessionStorage, TOKEN_STORAGE_KEY, fallbackToken);
  if (fallbackExpiresAt) {
    safeStorageSet(window.sessionStorage, TOKEN_EXPIRES_AT_STORAGE_KEY, fallbackExpiresAt);
  } else {
    safeStorageRemove(window.sessionStorage, TOKEN_EXPIRES_AT_STORAGE_KEY);
  }
  return {
    token: fallbackToken,
    expiresAt: fallbackExpiresAt
  };
}

export const SIGNAL_STATES = ['is-online', 'is-warn', 'is-offline'];
export const QUICK_KEY_SEQUENCES = {
  'ctrl-c': '\x03',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  '/': '/',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r'
};
export const KEYBOARD_VISIBLE_THRESHOLD_PX = 80;
export const ZOOM_SCALE_EPSILON = 0.02;
export const ZOOM_SETTLE_MS = 260;
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 28;
export const TERMINAL_MAX_PANES = 4;
export const TERMINAL_WRITE_HIGH_WATER_BYTES = 160 * 1024;
export const TERMINAL_WRITE_LOW_WATER_BYTES = 64 * 1024;
export const TERMINAL_INPUT_DIRECT_CHARS = 8;
export const TERMINAL_INPUT_BATCH_CHARS = 4096;
export const RESIZE_DEBOUNCE_MS = 90;
export const KILL_REQUEST_TIMEOUT_MS = 1500;
export const TERMINAL_REPLAY_TAIL_BYTES = 64 * 1024;
export const CONTROL_PROTOCOL_VERSION = 1;
export const CAPABILITY_TERMINAL_BINARY_V1 = 'terminal.binary.v1';
export const CONTROL_CLIENT_CAPABILITIES = ['shell', CAPABILITY_TERMINAL_BINARY_V1];
export const TERMINAL_BINARY_CODEC = 'binary-v1';
export const TERMINAL_FRAME_HEADER_BYTES = 5;
export const TERMINAL_FRAME_TYPE_OUTPUT = 1;
export const TERMINAL_FRAME_TYPE_INPUT = 2;

function normalizePersistedTerminalFontSize(rawValue) {
  const parsed = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const clamped = Math.max(TERMINAL_FONT_SIZE_MIN, Math.min(TERMINAL_FONT_SIZE_MAX, Math.round(parsed)));
  return Number.isFinite(clamped) ? clamped : 0;
}

export function persistTerminalFontSize(fontSize) {
  const normalized = normalizePersistedTerminalFontSize(fontSize);
  if (!normalized) {
    safeStorageRemove(window.sessionStorage, TERMINAL_FONT_SIZE_STORAGE_KEY);
    safeStorageRemove(window.localStorage, TERMINAL_FONT_SIZE_STORAGE_KEY);
    return;
  }
  const value = String(normalized);
  safeStorageSet(window.sessionStorage, TERMINAL_FONT_SIZE_STORAGE_KEY, value);
  safeStorageSet(window.localStorage, TERMINAL_FONT_SIZE_STORAGE_KEY, value);
}

export function readPersistedTerminalFontSize() {
  const sessionValue = normalizePersistedTerminalFontSize(
    safeStorageGet(window.sessionStorage, TERMINAL_FONT_SIZE_STORAGE_KEY)
  );
  if (sessionValue > 0) {
    return sessionValue;
  }

  const fallbackValue = normalizePersistedTerminalFontSize(
    safeStorageGet(window.localStorage, TERMINAL_FONT_SIZE_STORAGE_KEY)
  );
  if (fallbackValue <= 0) {
    return 0;
  }

  safeStorageSet(window.sessionStorage, TERMINAL_FONT_SIZE_STORAGE_KEY, String(fallbackValue));
  return fallbackValue;
}

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
  tokenExpiresAt: '',
  tokenRefreshTimer: 0,
  tokenWarningTimer: 0,
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
  viewportStableHeight: 0,
  pendingResizeAfterKeyboard: false,
  zoomActive: false,
  zoomNoticeShown: false,
  zoomSettleTimer: 0,
  lastResizeSessionId: '',
  lastResizeCols: 0,
  lastResizeRows: 0,
  dockMeasureRafId: 0,
  controlConnected: false,
  serverCapabilities: [],
  terminalConnected: false,
  terminalBinaryEnabled: false,
  terminalReconnectDelayMs: 1000,
  terminalReconnectTimer: 0,
  terminalConnectSeq: 0,
  reconnectDelayMs: 1000,
  reconnectTimer: 0,
  initialSessionsReceived: false,
  currentSessionId: '',
  cwd: '',
  terminalFontSize: 14,
  sessionOffsets: {},
  killRequestTimer: 0,
  killInFlight: false,
  killRequested: false,
  killTargetSessionId: '',
  desktopQualityProfile: 'balanced',
  connectionQualitySnapshot: null
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
  return new URL(path, window.location.origin).toString();
}

export function wsUrl(path, extraParams) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(path, `${protocol}//${window.location.host}`);
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

export function buildAuthHeaders(baseHeaders = {}) {
  const headers = {
    ...baseHeaders
  };
  if (State.token) {
    headers.Authorization = `Bearer ${State.token}`;
  }
  return headers;
}

export async function authedFetch(input, init = {}) {
  const requestInit = {
    ...init,
    headers: buildAuthHeaders(init.headers || {})
  };
  return fetch(input, requestInit);
}

export function createWsAuthMessage() {
  return JSON.stringify({
    type: 'auth',
    token: State.token,
    client: {
      ua: navigator.userAgent,
      version: 1
    }
  });
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

export function hashSessionId(sessionId) {
  if (!sessionId) {
    return 0;
  }
  const source = textEncoder.encode(sessionId);
  let hash = 0x811c9dc5;
  for (const byte of source) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function encodeTerminalFrame(frameType, sessionId, text) {
  const payload = textEncoder.encode(text || '');
  const frame = new Uint8Array(TERMINAL_FRAME_HEADER_BYTES + payload.byteLength);
  frame[0] = frameType & 0xff;
  const view = new DataView(frame.buffer);
  view.setUint32(1, hashSessionId(sessionId));
  frame.set(payload, TERMINAL_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeTerminalFrame(buffer, sessionId) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < TERMINAL_FRAME_HEADER_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const sessionHash = view.getUint32(1);
  if (sessionHash !== hashSessionId(sessionId)) {
    return null;
  }
  const payload = bytes.subarray(TERMINAL_FRAME_HEADER_BYTES);
  return {
    frameType: bytes[0],
    payloadText: textDecoder.decode(payload),
    payloadBytes: payload.byteLength
  };
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
    const response = await authedFetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/log`), { method: 'HEAD' });
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
  void enabled;
}
