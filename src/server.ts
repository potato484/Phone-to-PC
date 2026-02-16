import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import qrcode from 'qrcode-terminal';
import {
  AccessTokenService,
  createAccessAuthMiddleware,
  ensureAccessSigningSecret,
  ensureAuthToken,
  readBootstrapTokenFromRequest,
  validateBootstrapToken
} from './auth.js';
import { AuditLogger } from './audit-log.js';
import { MetricsRegistry } from './metrics.js';
import { PtyManager } from './pty-manager.js';
import { registerApiRoutes } from './routes/api.js';
import {
  checkOriginAndHost,
  createOriginHostMiddleware,
  createOriginHostPolicyFromEnv,
  createRateLimitMiddleware,
  getClientIp,
  MemoryRateLimiter
} from './security.js';
import { C2PStore } from './store.js';
import { getLanAddress, isEnabledEnvFlag, resolveTunnelMode, startTunnel } from './tunnel.js';
import { createControlChannel } from './ws/control.js';
import type { WsChannel } from './ws/channel.js';
import { createTerminalChannel } from './ws/terminal.js';

interface ServerCliOptions {
  cwd?: string;
}

function parseServerCliOptions(args: string[]): ServerCliOptions {
  const options: ServerCliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cwd') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        console.log('[c2p] cli: missing value for --cwd');
        continue;
      }
      options.cwd = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      options.cwd = arg.slice('--cwd='.length);
    }
  }
  return options;
}

function resolveDefaultWorkingDirectory(rawCwd: string | undefined): string {
  const fallbackCwd = (() => {
    const homeDir = os.homedir();
    try {
      if (homeDir && fs.statSync(homeDir).isDirectory()) {
        return homeDir;
      }
    } catch {
      // ignore and fall back to process cwd
    }
    return process.cwd();
  })();

  if (!rawCwd || rawCwd.trim().length === 0) {
    return fallbackCwd;
  }
  const candidate = path.resolve(rawCwd.trim());
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // fall through to default
  }
  console.log(`[c2p] cli: invalid --cwd=${rawCwd}, fallback to ${fallbackCwd}`);
  return fallbackCwd;
}

function parseIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

const cliOptions = parseServerCliOptions(process.argv.slice(2));
const defaultWorkingDirectory = resolveDefaultWorkingDirectory(cliOptions.cwd);
const port = Number(process.env.PORT ?? 3000);

const store = new C2PStore();
const bootstrapToken = ensureAuthToken();
const signingSecret = ensureAccessSigningSecret();
const accessTokenService = new AccessTokenService({
  store,
  signingSecret,
  ttlSeconds: parseIntEnv('C2P_ACCESS_TOKEN_TTL_SECONDS', 24 * 60 * 60)
});

const auditLogger = new AuditLogger({
  dir: process.env.C2P_AUDIT_DIR,
  retentionDays: parseIntEnv('C2P_AUDIT_RETENTION_DAYS', 90)
});
const metrics = new MetricsRegistry();

const ptyManager = new PtyManager(defaultWorkingDirectory);

if (!ptyManager.isReady()) {
  console.warn('[c2p] warn: tmux not available, terminal sessions will not be ready');
} else {
  const persistedSessions = store.listSessions().filter((session) => session.status !== 'killed');
  const recovery = ptyManager.recoverSessions(persistedSessions);
  const now = new Date().toISOString();

  for (const session of [...recovery.recovered, ...recovery.discovered]) {
    store.upsertSession({
      id: session.id,
      cli: session.cli,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      updatedAt: now,
      status: 'detached'
    });
  }

  for (const missingId of recovery.missing) {
    store.updateSession(missingId, {
      status: 'killed',
      updatedAt: now
    });

    const task = store.getTask(missingId);
    if (task && task.status === 'running') {
      store.updateTask(missingId, {
        status: 'error',
        finishedAt: now,
        exitCode: 1
      });
    }
  }

  console.log(
    `[c2p] tmux recovery: recovered=${recovery.recovered.length} discovered=${recovery.discovered.length} missing=${recovery.missing.length}`
  );
}
metrics.setTerminalSessionsActive(ptyManager.listSessions().length);

const originPolicy = createOriginHostPolicyFromEnv();
const generalApiLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 100 });
const uploadApiLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 10 });
const exchangeFailureLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 5, lockMs: 15 * 60_000 });
const wsUpgradeLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 60 });
const wsAuthFailureLimiter = new MemoryRateLimiter({ windowMs: 60_000, max: 5, lockMs: 15 * 60_000 });

const app = express();
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.resolve(runtimeRoot, 'public');

if (!fs.existsSync(publicDir)) {
  console.log(`[c2p] warn: public assets directory missing: ${publicDir}`);
}

app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    ...metrics.getHealthSnapshot()
  });
});

app.get('/readyz', async (_req, res) => {
  const checks = {
    sqlitePing: store.ping(),
    sqliteWritable: store.isWritable(),
    ptyReady: ptyManager.isReady()
  };

  if (checks.ptyReady) {
    try {
      checks.ptyReady = Array.isArray(ptyManager.listSessions());
    } catch {
      checks.ptyReady = false;
    }
  }

  const ready = checks.sqlitePing && checks.sqliteWritable && checks.ptyReady;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString()
  });
});

app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(metrics.renderPrometheus());
});

app.use('/api', createOriginHostMiddleware(originPolicy));

app.post('/api/auth/exchange', (req, res) => {
  const remoteIp = getClientIp(req);
  const lockState = exchangeFailureLimiter.peek(remoteIp);
  if (!lockState.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(lockState.retryAfterMs / 1000))));
    res.status(429).json({
      error: 'too many auth failures',
      retryAfterSec: Math.max(1, Math.ceil(lockState.retryAfterMs / 1000))
    });
    return;
  }

  const candidate = readBootstrapTokenFromRequest(req);
  if (!validateBootstrapToken(candidate, bootstrapToken)) {
    exchangeFailureLimiter.hit(remoteIp);
    auditLogger.log({
      event: 'auth.failed',
      actor: remoteIp,
      resource: 'bootstrap',
      outcome: 'failure',
      metadata: {
        reason: 'invalid bootstrap token'
      }
    });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const issued = accessTokenService.issueAccessToken(remoteIp);
  auditLogger.log({
    event: 'auth.token_issued',
    actor: remoteIp,
    resource: issued.claims.jti,
    outcome: 'success',
    metadata: {
      expiresAt: issued.expiresAt,
      ttlSeconds: accessTokenService.getAccessTokenTtlSeconds()
    }
  });

  res.status(200).json({
    tokenType: 'Bearer',
    accessToken: issued.token,
    expiresAt: issued.expiresAt,
    ttlSeconds: accessTokenService.getAccessTokenTtlSeconds()
  });
});

app.use(
  '/api/fs/upload',
  createRateLimitMiddleware(uploadApiLimiter, {
    message: 'too many upload requests'
  })
);
app.use(
  '/api',
  createRateLimitMiddleware(generalApiLimiter, {
    message: 'too many requests'
  })
);

const accessAuthMiddleware = createAccessAuthMiddleware(accessTokenService, {
  onFailure: (req, reason) => {
    auditLogger.log({
      event: 'auth.failed',
      actor: getClientIp(req),
      resource: 'access-token',
      outcome: 'failure',
      metadata: {
        reason
      }
    });
  }
});
app.use('/api', accessAuthMiddleware);

app.post('/api/auth/revoke', (req, res) => {
  const auth = res.locals.auth as { token: string; claims: { jti: string } } | undefined;
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const revoked = accessTokenService.revokeAccessToken(auth.token, 'self-revoke');
  if (!revoked.ok) {
    res.status(400).json({ error: 'revoke failed', reason: revoked.code });
    return;
  }

  auditLogger.log({
    event: 'auth.token_revoked',
    actor: getClientIp(req),
    resource: revoked.claims.jti,
    outcome: 'success',
    metadata: {
      reason: 'self-revoke'
    }
  });

  res.status(200).json({ ok: true, jti: revoked.claims.jti });
});

registerApiRoutes(app, {
  store,
  ptyManager,
  defaultWorkingDirectory,
  auditLogger
});

const server = http.createServer(app);
const channels: WsChannel[] = [
  createControlChannel({
    ptyManager,
    store,
    accessTokenService,
    auditLogger,
    metrics,
    wsAuthFailureLimiter
  }),
  createTerminalChannel({
    ptyManager,
    accessTokenService,
    auditLogger,
    metrics,
    wsAuthFailureLimiter
  })
];
const channelMap = new Map(channels.map((channel) => [channel.pathname, channel]));

server.on('upgrade', (request, socket, head) => {
  const originCheck = checkOriginAndHost(request, originPolicy);
  if (!originCheck.ok) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const remoteIp = getClientIp(request);
  const upgradeLimit = wsUpgradeLimiter.hit(remoteIp);
  if (!upgradeLimit.allowed) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  const host = request.headers.host ?? 'localhost';
  const parsed = new URL(request.url ?? '/', `http://${host}`);
  const channel = channelMap.get(parsed.pathname);
  if (!channel) {
    socket.destroy();
    return;
  }

  channel.handleUpgrade(request, socket, head);
});

server.on('close', () => {
  ptyManager.dispose();
  metrics.dispose();
  store.close();
});

server.listen(port, async () => {
  const localUrl = `http://localhost:${port}/#token=${bootstrapToken}`;
  const lan = getLanAddress();

  console.log(`[c2p] listening on ${port}`);
  console.log(`[c2p] default cwd: ${defaultWorkingDirectory}`);
  console.log(`[c2p] sqlite: ${store.getDbPath()}`);
  console.log(`[c2p] audit dir: ${auditLogger.getDir()}`);
  console.log(`[c2p] local bootstrap: ${localUrl}`);
  if (lan) {
    console.log(`[c2p] lan bootstrap: http://${lan}:${port}/#token=${bootstrapToken}`);
  }

  const tunnelUrl = await startTunnel(port, bootstrapToken);
  if (tunnelUrl) {
    if (resolveTunnelMode() === 'tailscale') {
      const tunnelCommand = isEnabledEnvFlag(process.env.TAILSCALE_FUNNEL) ? 'funnel' : 'serve';
      console.log(`[c2p] tunnel: tailscale ${tunnelCommand} -> ${tunnelUrl}`);
    } else {
      console.log(`[c2p] tunnel: ${tunnelUrl}`);
    }
    console.log('[c2p] scan to connect:');
    qrcode.generate(tunnelUrl, { small: true });
  }
});
