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
  dock: document.getElementById('dock'),
  dockHandle: document.getElementById('dock-handle'),
  sessionTabs: document.getElementById('session-tabs'),
  quickKeys: document.getElementById('quick-keys'),
  splitToggleBtn: document.getElementById('split-toggle-btn'),
  detachBtn: document.getElementById('detach-btn'),
  filesPath: document.getElementById('files-path'),
  filesList: document.getElementById('files-list'),
  filesRefreshBtn: document.getElementById('files-refresh-btn'),
  filesUpBtn: document.getElementById('files-up-btn'),
  filesMkdirBtn: document.getElementById('files-mkdir-btn'),
  filesUploadBtn: document.getElementById('files-upload-btn'),
  filesUploadInput: document.getElementById('files-upload-input'),
  filesEditorWrap: document.getElementById('files-editor-wrap'),
  filesEditorPath: document.getElementById('files-editor-path'),
  filesEditor: document.getElementById('files-editor'),
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
  monitorVncText: document.getElementById('monitor-vnc-text'),
  toastRoot: document.getElementById('toast-root')
};

export const TOKEN_STORAGE_KEY = 'c2p_token';
export const QUICK_KEY_STORAGE_KEY = 'c2p_quick_keys_v1';
export const QUICK_KEY_LONG_PRESS_MS = 520;
export const TERMINAL_SPLIT_MODE_STORAGE_KEY = 'c2p_split_mode_v1';
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
  esc: '\x1b',
  enter: '\r'
};
export const KEYBOARD_VISIBLE_THRESHOLD_PX = 80;
export const ZOOM_SCALE_EPSILON = 0.02;
export const ZOOM_SETTLE_MS = 260;
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 28;
export const TERMINAL_MAX_PANES = 4;
export const TERMINAL_WRITE_HIGH_WATER_BYTES = 256 * 1024;
export const TERMINAL_WRITE_LOW_WATER_BYTES = 96 * 1024;
export const TERMINAL_INPUT_DIRECT_CHARS = 8;
export const TERMINAL_INPUT_BATCH_CHARS = 4096;
export const RESIZE_DEBOUNCE_MS = 90;
export const KILL_REQUEST_TIMEOUT_MS = 6000;
export const TERMINAL_REPLAY_TAIL_BYTES = 64 * 1024;
export const CONTROL_PROTOCOL_VERSION = 1;
export const CAPABILITY_TERMINAL_BINARY_V1 = 'terminal.binary.v1';
export const CONTROL_CLIENT_CAPABILITIES = ['shell', CAPABILITY_TERMINAL_BINARY_V1];
export const TERMINAL_BINARY_CODEC = 'binary-v1';
export const TERMINAL_FRAME_HEADER_BYTES = 5;
export const TERMINAL_FRAME_TYPE_OUTPUT = 1;
export const TERMINAL_FRAME_TYPE_INPUT = 2;

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
    DOM.detachBtn.disabled = !nextEnabled || State.killInFlight;
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
