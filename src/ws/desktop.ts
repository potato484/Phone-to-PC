import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { AccessTokenService } from '../auth.js';
import type { AuditLogger } from '../audit-log.js';
import type { MetricsRegistry } from '../metrics.js';
import { getClientIp, type MemoryRateLimiter } from '../security.js';
import type { VncManager } from '../vnc-manager.js';
import { requireWsAuth } from './auth-gate.js';
import type { WsChannel } from './channel.js';
import { attachWsHeartbeat } from './heartbeat.js';
import { WS_PER_MESSAGE_DEFLATE } from './ws-config.js';

interface DesktopChannelDeps {
  vncManager: VncManager;
  accessTokenService: AccessTokenService;
  auditLogger: AuditLogger;
  metrics: MetricsRegistry;
  wsAuthFailureLimiter: MemoryRateLimiter;
}

const DESKTOP_UPSTREAM_TIMEOUT_MS = 6_000;
const DESKTOP_BACKPRESSURE_HIGH_BYTES = 1024 * 1024;
const DESKTOP_BACKPRESSURE_LOW_BYTES = 256 * 1024;
const DESKTOP_DRAIN_CHECK_MS = 16;

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
  const { vncManager, accessTokenService, auditLogger, metrics, wsAuthFailureLimiter } = deps;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: WS_PER_MESSAGE_DEFLATE });
  attachWsHeartbeat(wss);

  wss.on('connection', (ws, request) => {
    metrics.incWsConnection('desktop');
    const remoteIp = getClientIp(request);

    ws.on('close', () => {
      metrics.decWsConnection('desktop');
      metrics.setDesktopUpstreamBufferedBytes(0);
    });

    void requireWsAuth(ws, {
      channel: 'desktop',
      request,
      accessTokenService,
      auditLogger,
      metrics,
      authFailureLimiter: wsAuthFailureLimiter,
      timeoutMs: 2000
    }).then((authContext) => {
      if (!authContext || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      let upstream: net.Socket | null = null;
      let closed = false;
      let upstreamPaused = false;
      let drainTimer: NodeJS.Timeout | null = null;

      const clearDrainTimer = (): void => {
        if (!drainTimer) {
          return;
        }
        clearTimeout(drainTimer);
        drainTimer = null;
      };

      const closePair = (code: number, reason: string): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearDrainTimer();
        if (upstream) {
          upstream.destroy();
          upstream = null;
        }
        metrics.setDesktopUpstreamBufferedBytes(0);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, sanitizeCloseReason(reason));
        }
      };

      const maybeResumeUpstream = (): void => {
        if (!upstream || upstream.destroyed || !upstreamPaused) {
          return;
        }
        if (ws.bufferedAmount <= DESKTOP_BACKPRESSURE_LOW_BYTES) {
          upstreamPaused = false;
          upstream.resume();
          clearDrainTimer();
          return;
        }
        if (!drainTimer) {
          drainTimer = setTimeout(() => {
            drainTimer = null;
            maybeResumeUpstream();
          }, DESKTOP_DRAIN_CHECK_MS);
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
          auditLogger.log({
            event: 'session.desktop_connect',
            actor: remoteIp,
            resource: `${availability.endpoint.host}:${availability.endpoint.port}`,
            outcome: 'success',
            metadata: {
              tokenJti: authContext.claims.jti
            }
          });
        });

        socket.on('data', (chunk) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }

          if (!upstreamPaused && ws.bufferedAmount > DESKTOP_BACKPRESSURE_HIGH_BYTES) {
            upstreamPaused = true;
            socket.pause();
          }

          ws.send(chunk, { binary: true }, (error) => {
            if (error) {
              closePair(1011, 'desktop forward failed');
              return;
            }
            metrics.setDesktopUpstreamBufferedBytes(ws.bufferedAmount);
            maybeResumeUpstream();
          });

          metrics.setDesktopUpstreamBufferedBytes(ws.bufferedAmount);
          if (upstreamPaused) {
            maybeResumeUpstream();
          }
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
        auditLogger.log({
          event: 'session.desktop_disconnect',
          actor: remoteIp,
          resource: 'desktop',
          outcome: 'success',
          metadata: {
            tokenJti: authContext.claims.jti
          }
        });
        closePair(1000, 'desktop client closed');
      });

      ws.on('error', () => {
        closePair(1011, 'desktop client error');
      });
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
