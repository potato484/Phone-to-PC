import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { VncManager } from '../vnc-manager.js';
import type { WsChannel } from './channel.js';
import { WS_PER_MESSAGE_DEFLATE } from './ws-config.js';

interface DesktopChannelDeps {
  vncManager: VncManager;
}

const DESKTOP_UPSTREAM_TIMEOUT_MS = 6_000;

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  return Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
}

function sanitizeCloseReason(input: string): string {
  const text = input.trim();
  if (!text) {
    return 'desktop unavailable';
  }
  return text.slice(0, 120);
}

export function createDesktopChannel(deps: DesktopChannelDeps): WsChannel {
  const { vncManager } = deps;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: WS_PER_MESSAGE_DEFLATE });

  wss.on('connection', (ws) => {
    let upstream: net.Socket | null = null;
    let closed = false;

    const closePair = (code: number, reason: string): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (upstream) {
        upstream.destroy();
        upstream = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, sanitizeCloseReason(reason));
      }
    };

    void (async () => {
      const availability = await vncManager.ensureAvailable();
      if (!availability.available) {
        closePair(1013, availability.message || 'vnc unavailable');
        return;
      }

      const socket = net.createConnection({
        host: availability.endpoint.host,
        port: availability.endpoint.port
      });
      upstream = socket;
      socket.setNoDelay(true);

      const connectTimer = setTimeout(() => {
        closePair(1011, 'desktop upstream connect timeout');
      }, DESKTOP_UPSTREAM_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(connectTimer);
      });

      socket.on('data', (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(chunk, { binary: true }, (error) => {
          if (error) {
            closePair(1011, 'desktop forward failed');
          }
        });
      });

      socket.on('error', () => {
        clearTimeout(connectTimer);
        closePair(1011, 'desktop upstream error');
      });

      socket.on('close', () => {
        clearTimeout(connectTimer);
        closePair(1000, 'desktop upstream closed');
      });
    })().catch(() => {
      closePair(1011, 'desktop init failed');
    });

    ws.on('message', (raw) => {
      if (!upstream || upstream.destroyed) {
        return;
      }
      upstream.write(rawDataToBuffer(raw));
    });

    ws.on('close', () => {
      closePair(1000, 'desktop client closed');
    });

    ws.on('error', () => {
      closePair(1011, 'desktop client error');
    });
  });

  return {
    pathname: '/ws/desktop',
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  };
}
