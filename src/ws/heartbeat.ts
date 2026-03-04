import { WebSocketServer, type WebSocket } from 'ws';

interface HeartbeatSocket extends WebSocket {
  _c2pAlive?: boolean;
  _c2pPingTimer?: NodeJS.Timeout;
  _c2pPongTimer?: NodeJS.Timeout;
  _c2pHeartbeatOptions?: Required<WsHeartbeatOptions>;
  _c2pApplyHeartbeatOptions?: (options: WsHeartbeatOptions) => void;
}

export interface WsHeartbeatOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export type WsHeartbeatGrade = 'excellent' | 'good' | 'fair' | 'poor';

const DEFAULT_HEARTBEAT_OPTIONS: Required<WsHeartbeatOptions> = {
  pingIntervalMs: 30_000,
  pongTimeoutMs: 10_000
};

const HEARTBEAT_OPTIONS_BY_GRADE: Record<WsHeartbeatGrade, Required<WsHeartbeatOptions>> = {
  excellent: { pingIntervalMs: 30_000, pongTimeoutMs: 10_000 },
  good: { pingIntervalMs: 15_000, pongTimeoutMs: 5_000 },
  fair: { pingIntervalMs: 5_000, pongTimeoutMs: 3_000 },
  poor: { pingIntervalMs: 3_000, pongTimeoutMs: 5_000 }
};

function normalizeHeartbeatOptions(
  options: WsHeartbeatOptions = {},
  fallback: Required<WsHeartbeatOptions> = DEFAULT_HEARTBEAT_OPTIONS
): Required<WsHeartbeatOptions> {
  const pingIntervalMs = Number.isFinite(options.pingIntervalMs)
    ? Math.max(1_000, Math.floor(Number(options.pingIntervalMs)))
    : fallback.pingIntervalMs;
  const pongTimeoutMs = Number.isFinite(options.pongTimeoutMs)
    ? Math.max(1_000, Math.floor(Number(options.pongTimeoutMs)))
    : fallback.pongTimeoutMs;
  return {
    pingIntervalMs,
    pongTimeoutMs
  };
}

function clearPongTimer(socket: HeartbeatSocket): void {
  if (!socket._c2pPongTimer) {
    return;
  }
  clearTimeout(socket._c2pPongTimer);
  socket._c2pPongTimer = undefined;
}

function clearPingTimer(socket: HeartbeatSocket): void {
  if (!socket._c2pPingTimer) {
    return;
  }
  clearTimeout(socket._c2pPingTimer);
  socket._c2pPingTimer = undefined;
}

function schedulePing(socket: HeartbeatSocket): void {
  clearPingTimer(socket);
  const options = socket._c2pHeartbeatOptions || DEFAULT_HEARTBEAT_OPTIONS;
  socket._c2pPingTimer = setTimeout(() => {
    socket._c2pPingTimer = undefined;
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    if (!socket._c2pAlive) {
      socket.terminate();
      return;
    }

    socket._c2pAlive = false;
    clearPongTimer(socket);
    socket._c2pPongTimer = setTimeout(() => {
      socket.terminate();
    }, options.pongTimeoutMs);
    socket._c2pPongTimer.unref?.();

    try {
      socket.ping();
    } catch {
      socket.terminate();
      return;
    }

    schedulePing(socket);
  }, options.pingIntervalMs);
  socket._c2pPingTimer.unref?.();
}

export function updateWsHeartbeatOptions(ws: WebSocket, options: WsHeartbeatOptions = {}): void {
  const socket = ws as HeartbeatSocket;
  if (!socket || typeof socket._c2pApplyHeartbeatOptions !== 'function') {
    return;
  }
  socket._c2pApplyHeartbeatOptions(options);
}

export function resolveWsHeartbeatOptionsByGrade(grade: unknown): WsHeartbeatOptions | null {
  const normalized = typeof grade === 'string' ? grade.trim().toLowerCase() : '';
  if (!normalized) {
    return null;
  }
  if (normalized === 'excellent') {
    return HEARTBEAT_OPTIONS_BY_GRADE.excellent;
  }
  if (normalized === 'good') {
    return HEARTBEAT_OPTIONS_BY_GRADE.good;
  }
  if (normalized === 'fair') {
    return HEARTBEAT_OPTIONS_BY_GRADE.fair;
  }
  if (normalized === 'poor') {
    return HEARTBEAT_OPTIONS_BY_GRADE.poor;
  }
  return null;
}

export function attachWsHeartbeat(wss: WebSocketServer, options: WsHeartbeatOptions = {}): () => void {
  const defaultOptions = normalizeHeartbeatOptions(options, DEFAULT_HEARTBEAT_OPTIONS);

  wss.on('connection', (ws) => {
    const socket = ws as HeartbeatSocket;
    socket._c2pAlive = true;
    socket._c2pHeartbeatOptions = defaultOptions;
    socket._c2pApplyHeartbeatOptions = (nextOptions: WsHeartbeatOptions) => {
      const current = socket._c2pHeartbeatOptions || defaultOptions;
      socket._c2pHeartbeatOptions = normalizeHeartbeatOptions(nextOptions, current);
      schedulePing(socket);
    };

    socket.on('pong', () => {
      socket._c2pAlive = true;
      clearPongTimer(socket);
    });

    socket.on('close', () => {
      clearPingTimer(socket);
      clearPongTimer(socket);
      socket._c2pApplyHeartbeatOptions = undefined;
    });
    schedulePing(socket);
  });

  return () => {
    for (const ws of wss.clients) {
      const socket = ws as HeartbeatSocket;
      clearPingTimer(socket);
      clearPongTimer(socket);
      socket._c2pApplyHeartbeatOptions = undefined;
    }
  };
}
