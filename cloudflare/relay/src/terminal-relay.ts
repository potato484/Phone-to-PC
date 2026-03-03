interface RelayEnv {
  UPSTREAM_WS_BASE: string;
}

const WS_OPEN = 1;
const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 6000;
const MAX_BUFFERED_MESSAGES = 256;

function isWebSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return !!socket && socket.readyState === WS_OPEN;
}

function toWebSocketUrl(base: string, incomingUrl: string): string {
  const normalizedBase = typeof base === 'string' ? base.trim() : '';
  if (!normalizedBase) {
    return '';
  }
  const upstream = new URL(normalizedBase);
  const incoming = new URL(incomingUrl);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream.toString();
}

export class TerminalRelay {
  state: DurableObjectState;
  env: RelayEnv;
  clients: Set<WebSocket>;
  upstream: WebSocket | null;
  connectingUpstream: boolean;
  reconnectAttempts: number;
  reconnectTimer: number;
  bufferedMessages: Array<string | ArrayBuffer>;
  lastRequestUrl: string;

  constructor(state: DurableObjectState, env: RelayEnv) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.upstream = null;
    this.connectingUpstream = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = 0;
    this.bufferedMessages = [];
    this.lastRequestUrl = '';
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();

    this.lastRequestUrl = request.url;
    this.#attachClientSocket(serverSocket);
    this.clients.add(serverSocket);
    void this.#ensureUpstream();

    return new Response(null, {
      status: 101,
      webSocket: clientSocket
    });
  }

  #attachClientSocket(socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (isWebSocketOpen(this.upstream)) {
        this.upstream.send(data);
        return;
      }
      if (this.bufferedMessages.length >= MAX_BUFFERED_MESSAGES) {
        this.bufferedMessages.shift();
      }
      this.bufferedMessages.push(data);
      void this.#ensureUpstream();
    });

    const cleanup = () => {
      this.clients.delete(socket);
      if (this.clients.size === 0 && isWebSocketOpen(this.upstream)) {
        this.upstream.close(1000, 'no_clients');
      }
    };
    socket.addEventListener('close', cleanup);
    socket.addEventListener('error', cleanup);
  }

  async #ensureUpstream(): Promise<void> {
    if (isWebSocketOpen(this.upstream) || this.connectingUpstream || this.clients.size === 0) {
      return;
    }
    const upstreamUrl = toWebSocketUrl(this.env.UPSTREAM_WS_BASE, this.lastRequestUrl);
    if (!upstreamUrl) {
      this.#broadcastControlError('relay upstream is not configured');
      return;
    }
    this.connectingUpstream = true;
    try {
      const response = await fetch(upstreamUrl, {
        headers: {
          Upgrade: 'websocket'
        }
      });
      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`upstream handshake failed (${response.status})`);
      }
      const upstreamSocket = response.webSocket;
      upstreamSocket.accept();
      this.upstream = upstreamSocket;
      this.connectingUpstream = false;
      this.reconnectAttempts = 0;
      this.#attachUpstreamSocket(upstreamSocket);
      this.#flushBufferedMessages();
    } catch {
      this.connectingUpstream = false;
      this.#scheduleReconnect();
    }
  }

  #attachUpstreamSocket(socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      for (const client of this.clients) {
        if (client.readyState === WS_OPEN) {
          client.send(event.data);
        }
      }
    });

    const handleClosure = () => {
      if (this.upstream === socket) {
        this.upstream = null;
      }
      if (this.clients.size > 0) {
        this.#scheduleReconnect();
      }
    };
    socket.addEventListener('close', handleClosure);
    socket.addEventListener('error', handleClosure);
  }

  #flushBufferedMessages(): void {
    if (!isWebSocketOpen(this.upstream) || this.bufferedMessages.length === 0) {
      return;
    }
    while (this.bufferedMessages.length > 0 && isWebSocketOpen(this.upstream)) {
      const message = this.bufferedMessages.shift();
      this.upstream.send(message);
    }
  }

  #scheduleReconnect(): void {
    if (this.reconnectTimer || this.clients.size === 0) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      void this.#ensureUpstream();
    }, delay);
  }

  #broadcastControlError(message: string): void {
    const payload = JSON.stringify({
      type: 'error',
      message
    });
    for (const client of this.clients) {
      if (client.readyState === WS_OPEN) {
        client.send(payload);
      }
    }
  }
}
