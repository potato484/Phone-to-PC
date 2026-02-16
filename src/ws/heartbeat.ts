import { WebSocketServer, type WebSocket } from 'ws';

interface HeartbeatSocket extends WebSocket {
  _c2pAlive?: boolean;
  _c2pPongTimer?: NodeJS.Timeout;
}

export interface WsHeartbeatOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

function clearPongTimer(socket: HeartbeatSocket): void {
  if (!socket._c2pPongTimer) {
    return;
  }
  clearTimeout(socket._c2pPongTimer);
  socket._c2pPongTimer = undefined;
}

export function attachWsHeartbeat(wss: WebSocketServer, options: WsHeartbeatOptions = {}): () => void {
  const pingIntervalMs = Number.isFinite(options.pingIntervalMs) ? Number(options.pingIntervalMs) : 30_000;
  const pongTimeoutMs = Number.isFinite(options.pongTimeoutMs) ? Number(options.pongTimeoutMs) : 10_000;

  wss.on('connection', (ws) => {
    const socket = ws as HeartbeatSocket;
    socket._c2pAlive = true;

    socket.on('pong', () => {
      socket._c2pAlive = true;
      clearPongTimer(socket);
    });

    socket.on('close', () => {
      clearPongTimer(socket);
    });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const socket = ws as HeartbeatSocket;
      if (socket.readyState !== socket.OPEN) {
        continue;
      }
      if (!socket._c2pAlive) {
        socket.terminate();
        continue;
      }

      socket._c2pAlive = false;
      clearPongTimer(socket);
      socket._c2pPongTimer = setTimeout(() => {
        socket.terminate();
      }, pongTimeoutMs);
      socket.ping();
    }
  }, pingIntervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
    for (const ws of wss.clients) {
      clearPongTimer(ws as HeartbeatSocket);
    }
  };
}
