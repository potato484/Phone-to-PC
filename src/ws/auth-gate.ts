import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import type { AccessAuthContext, AccessTokenService } from '../auth.js';
import type { AuditLogger } from '../audit-log.js';
import type { MetricsRegistry } from '../metrics.js';
import { getClientIp, type MemoryRateLimiter } from '../security.js';

interface WsAuthMessage {
  type: 'auth';
  token: string;
  client?: {
    ua?: string;
    version?: number;
  };
}

export interface WsAuthGateDeps {
  channel: 'control' | 'terminal';
  request: IncomingMessage;
  accessTokenService: AccessTokenService;
  auditLogger: AuditLogger;
  metrics: MetricsRegistry;
  authFailureLimiter: MemoryRateLimiter;
  timeoutMs?: number;
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }
  return Buffer.concat(raw.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8');
}

function parseAuthMessage(raw: RawData): WsAuthMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDataToString(raw));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (row.type !== 'auth' || typeof row.token !== 'string' || row.token.trim().length === 0) {
    return null;
  }

  const client = row.client && typeof row.client === 'object' ? (row.client as Record<string, unknown>) : null;
  return {
    type: 'auth',
    token: row.token,
    client: client
      ? {
          ua: typeof client.ua === 'string' ? client.ua : undefined,
          version: typeof client.version === 'number' ? client.version : undefined
        }
      : undefined
  };
}

function closeWithReason(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason.slice(0, 120));
  }
}

export function requireWsAuth(ws: WebSocket, deps: WsAuthGateDeps): Promise<AccessAuthContext | null> {
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Number(deps.timeoutMs) : 2000;
  const remoteIp = getClientIp(deps.request);

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result: AccessAuthContext | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off('close', onClose);
      resolve(result);
    };

    const fail = (code: number, reason: string, metadata: Record<string, unknown> = {}): void => {
      deps.metrics.incWsAuthFailTotal();
      deps.auditLogger.log({
        event: 'ws.auth_failed',
        actor: remoteIp,
        resource: deps.channel,
        outcome: 'failure',
        metadata: {
          reason,
          ...metadata
        }
      });
      closeWithReason(ws, code, reason);
      settle(null);
    };

    const onClose = (): void => {
      settle(null);
    };

    ws.on('close', onClose);

    const timer = setTimeout(() => {
      fail(4408, 'auth timeout');
    }, timeoutMs);

    const lockState = deps.authFailureLimiter.peek(remoteIp);
    if (!lockState.allowed) {
      fail(4401, 'auth locked', { retryAfterMs: lockState.retryAfterMs });
      return;
    }

    ws.once('message', (raw, isBinary) => {
      if (isBinary) {
        deps.authFailureLimiter.hit(remoteIp);
        fail(4400, 'auth must be json');
        return;
      }

      const authMessage = parseAuthMessage(raw);
      if (!authMessage) {
        deps.authFailureLimiter.hit(remoteIp);
        fail(4401, 'auth required');
        return;
      }

      const verdict = deps.accessTokenService.verifyAccessToken(authMessage.token);
      if (!verdict.ok) {
        deps.authFailureLimiter.hit(remoteIp);
        fail(4401, 'unauthorized', { reasonCode: verdict.code });
        return;
      }

      deps.auditLogger.log({
        event: 'ws.auth_ok',
        actor: remoteIp,
        resource: deps.channel,
        outcome: 'success',
        metadata: {
          tokenJti: verdict.claims.jti,
          expiresAt: verdict.expiresAt,
          clientUa: authMessage.client?.ua ?? '',
          clientVersion: authMessage.client?.version ?? 0
        }
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'auth.ok',
            expiresAt: verdict.expiresAt
          })
        );
      }

      settle({
        token: authMessage.token,
        claims: verdict.claims,
        expiresAt: verdict.expiresAt
      });
    });
  });
}
