import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import qrcode from 'qrcode-terminal';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createAuthMiddleware, ensureAuthToken, validateUpgradeToken } from './auth.js';
import { PtyManager } from './pty-manager.js';
import { PushService } from './push.js';
import {
  C2PStore,
  type CliKind,
  type PushSubscriptionRecord,
  type TaskRecord,
  type TaskStatus
} from './store.js';

interface ControlSpawnMessage {
  type: 'spawn';
  cli: CliKind;
  cwd?: string;
  cols?: number;
  rows?: number;
  prompt?: string;
}

interface ControlResizeMessage {
  type: 'resize';
  sessionId: string;
  cols?: number;
  rows?: number;
}

interface ControlKillMessage {
  type: 'kill';
  sessionId: string;
}

type ControlMessage = ControlSpawnMessage | ControlResizeMessage | ControlKillMessage;

type ControlOutbound =
  | { type: 'spawned'; sessionId: string; cli: CliKind; cwd: string }
  | { type: 'exited'; sessionId: string; exitCode: number }
  | { type: 'sessions'; list: unknown[] }
  | { type: 'error'; message: string };

interface ServerCliOptions {
  cwd?: string;
}

const TERMINAL_SEND_BATCH_MS = 16;
const TERMINAL_SEND_HIGH_WATER_BYTES = 64 * 1024;
const TERMINAL_SEND_LOW_WATER_BYTES = 32 * 1024;

function isCliKind(value: unknown): value is CliKind {
  return value === 'claude' || value === 'codex' || value === 'gemini' || value === 'shell';
}

function normalizeDimension(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const rounded = Math.floor(num);
  if (rounded < 10 || rounded > 500) {
    return fallback;
  }
  return rounded;
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
  if (!rawCwd || rawCwd.trim().length === 0) {
    return process.cwd();
  }
  const candidate = path.resolve(rawCwd.trim());
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // fall through to default
  }
  console.log(`[c2p] cli: invalid --cwd=${rawCwd}, fallback to ${process.cwd()}`);
  return process.cwd();
}

function parseControlMessage(raw: RawData): ControlMessage | undefined {
  const text = Array.isArray(raw)
    ? Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))).toString('utf8')
    : Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : typeof raw === 'string'
        ? raw
        : Buffer.from(raw).toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.type === 'spawn' && isCliKind(candidate.cli)) {
    return {
      type: 'spawn',
      cli: candidate.cli,
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
      cols: typeof candidate.cols === 'number' ? candidate.cols : undefined,
      rows: typeof candidate.rows === 'number' ? candidate.rows : undefined,
      prompt: typeof candidate.prompt === 'string' ? candidate.prompt : undefined
    };
  }

  if (candidate.type === 'resize' && typeof candidate.sessionId === 'string') {
    return {
      type: 'resize',
      sessionId: candidate.sessionId,
      cols: typeof candidate.cols === 'number' ? candidate.cols : undefined,
      rows: typeof candidate.rows === 'number' ? candidate.rows : undefined
    };
  }

  if (candidate.type === 'kill' && typeof candidate.sessionId === 'string') {
    return {
      type: 'kill',
      sessionId: candidate.sessionId
    };
  }

  return undefined;
}

function sendControlMessage(ws: WebSocket, payload: ControlOutbound): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isPushSubscriptionRecord(value: unknown): value is PushSubscriptionRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== 'string' || v.endpoint.length === 0) {
    return false;
  }
  if (v.expirationTime !== null && typeof v.expirationTime !== 'number') {
    return false;
  }
  if (!v.keys || typeof v.keys !== 'object') {
    return false;
  }
  const keys = v.keys as Record<string, unknown>;
  return typeof keys.p256dh === 'string' && typeof keys.auth === 'string';
}

function getLanAddress(): string | undefined {
  const nets = os.networkInterfaces();
  for (const net of Object.values(nets)) {
    if (!net) {
      continue;
    }
    for (const info of net) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return undefined;
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
  return Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))).toString('utf8');
}

type TunnelMode = 'auto' | 'cloudflare' | 'off';

const TUNNEL_INSTALL_DOC =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
const TUNNEL_URL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;
const TUNNEL_START_TIMEOUT_MS = 15_000;

function resolveTunnelMode(): TunnelMode {
  const raw = (process.env.TUNNEL ?? 'auto').trim().toLowerCase();
  if (raw === '' || raw === 'auto') {
    return 'auto';
  }
  if (raw === 'cloudflare') {
    return 'cloudflare';
  }
  if (raw === 'off') {
    return 'off';
  }
  console.log(`[c2p] tunnel: unsupported TUNNEL=${raw}, fallback to auto`);
  return 'auto';
}

function appendToken(baseUrl: string, tokenValue: string): string {
  const url = new URL(baseUrl);
  url.hash = `token=${tokenValue}`;
  return url.toString();
}

function registerTunnelCleanup(child: ChildProcess): void {
  const cleanup = (): void => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  };

  const onSigint = (): void => {
    cleanup();
    process.exit(0);
  };
  const onSigterm = (): void => {
    cleanup();
    process.exit(0);
  };

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', cleanup);
  child.once('exit', () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('exit', cleanup);
  });
}

async function startTunnel(port: number, tokenValue: string): Promise<string | null> {
  const mode = resolveTunnelMode();
  if (mode === 'off') {
    return null;
  }

  const tunnelHostname = process.env.TUNNEL_HOSTNAME?.trim();
  if (tunnelHostname) {
    const child = spawn('cloudflared', ['tunnel', 'run'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let logBuffer = '';

    const ready = await new Promise<boolean>((resolve) => {
      let done = false;

      const settle = (value: boolean): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        resolve(value);
      };

      const onData = (chunk: Buffer): void => {
        logBuffer += chunk.toString('utf8');
        if (/Registered tunnel connection/i.test(logBuffer)) {
          settle(true);
          return;
        }
        if (logBuffer.length > 8_192) {
          logBuffer = logBuffer.slice(-2_048);
        }
      };

      const onError = (error: Error): void => {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          console.log('[c2p] tunnel: cloudflared not found, LAN-only mode');
          console.log(`[c2p] install: ${TUNNEL_INSTALL_DOC}`);
        } else {
          console.log(`[c2p] tunnel: failed to start named tunnel (${error.message})`);
        }
        settle(false);
      };

      const onExit = (): void => {
        settle(false);
      };

      const timer = setTimeout(() => {
        console.log('[c2p] tunnel: timeout waiting for named tunnel readiness');
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
        }
        settle(false);
      }, TUNNEL_START_TIMEOUT_MS);

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });

    if (!ready) {
      return null;
    }

    registerTunnelCleanup(child);
    return appendToken(`https://${tunnelHostname}`, tokenValue);
  }

  const child = spawn(
    'cloudflared',
    ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let logBuffer = '';

  const publicUrl = await new Promise<string | null>((resolve) => {
    let done = false;

    const settle = (value: string | null): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(value);
    };

    const tryMatchUrl = (chunk: Buffer): void => {
      logBuffer += chunk.toString('utf8');
      const match = logBuffer.match(TUNNEL_URL_RE);
      if (match) {
        settle(match[0]);
        return;
      }
      if (logBuffer.length > 8_192) {
        logBuffer = logBuffer.slice(-2_048);
      }
    };

    const onData = (chunk: Buffer): void => {
      tryMatchUrl(chunk);
    };

    const onError = (error: Error): void => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        console.log('[c2p] tunnel: cloudflared not found, LAN-only mode');
        console.log(`[c2p] install: ${TUNNEL_INSTALL_DOC}`);
      } else {
        console.log(`[c2p] tunnel: failed to start cloudflared (${error.message})`);
      }
      settle(null);
    };

    const onExit = (): void => {
      settle(null);
    };

    const timer = setTimeout(() => {
      console.log('[c2p] tunnel: timeout waiting for trycloudflare URL');
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      settle(null);
    }, TUNNEL_START_TIMEOUT_MS);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  if (!publicUrl) {
    return null;
  }
  registerTunnelCleanup(child);

  return appendToken(publicUrl, tokenValue);
}

const cliOptions = parseServerCliOptions(process.argv.slice(2));
const defaultWorkingDirectory = resolveDefaultWorkingDirectory(cliOptions.cwd);
const port = Number(process.env.PORT ?? 3000);
const store = new C2PStore();
const token = ensureAuthToken();
const authMiddleware = createAuthMiddleware(token);
const ptyManager = new PtyManager(defaultWorkingDirectory);
const killRequested = new Set<string>();
const pushService = new PushService(store);
pushService.init({
  subject: process.env.VAPID_SUBJECT,
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
});

const app = express();
const publicDir = path.resolve(process.cwd(), 'public');

app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api', authMiddleware);

app.get('/api/tasks', (_req: Request, res: Response) => {
  res.json({ tasks: store.listTasks() });
});

app.get('/api/sessions', (_req: Request, res: Response) => {
  res.json({ sessions: ptyManager.listSessions() });
});

app.get('/api/runtime', (_req: Request, res: Response) => {
  res.json({ cwd: defaultWorkingDirectory });
});

app.get('/api/vapid-public-key', (_req: Request, res: Response) => {
  res.json({ publicKey: pushService.getPublicKey() });
});

app.post('/api/push/subscribe', (req: Request, res: Response) => {
  if (!isPushSubscriptionRecord(req.body)) {
    res.status(400).json({ error: 'invalid subscription payload' });
    return;
  }
  store.upsertSubscription(req.body);
  res.status(201).json({ ok: true });
});

const server = http.createServer(app);
const controlWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
const controlClients = new Set<WebSocket>();

function broadcastControl(payload: ControlOutbound): void {
  const data = JSON.stringify(payload);
  for (const client of controlClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function broadcastSessions(): void {
  broadcastControl({ type: 'sessions', list: ptyManager.listSessions() });
}

ptyManager.onExit((sessionId, exitCode) => {
  const now = new Date().toISOString();
  const task = store.getTask(sessionId);
  const wasKilled = killRequested.delete(sessionId);
  const status: TaskStatus = wasKilled ? 'killed' : exitCode === 0 ? 'done' : 'error';

  store.updateTask(sessionId, {
    status,
    finishedAt: now,
    exitCode
  });

  broadcastControl({ type: 'exited', sessionId, exitCode });
  broadcastSessions();

  if (task) {
    const title = status === 'done' ? 'Task finished' : 'Task exited';
    const body = `${task.cli} session ${sessionId} exited with code ${exitCode}`;
    void pushService.notify(title, body, {
      sessionId,
      cli: task.cli,
      exitCode,
      status
    });
  }
});

controlWss.on('connection', (ws) => {
  controlClients.add(ws);
  sendControlMessage(ws, { type: 'sessions', list: ptyManager.listSessions() });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      sendControlMessage(ws, { type: 'error', message: 'control channel expects JSON text' });
      return;
    }

    const message = parseControlMessage(raw);
    if (!message) {
      sendControlMessage(ws, { type: 'error', message: 'invalid control payload' });
      return;
    }

    if (message.type === 'spawn') {
      const sessionId = randomUUID();
      const cols = normalizeDimension(message.cols, 100);
      const rows = normalizeDimension(message.rows, 30);

      try {
        const info = ptyManager.spawn({
          id: sessionId,
          cli: message.cli,
          cwd: message.cwd,
          cols,
          rows,
          prompt: message.prompt
        });

        const task: TaskRecord = {
          id: sessionId,
          cli: message.cli,
          prompt: message.prompt?.trim() ?? '',
          cwd: info.cwd,
          status: 'running',
          createdAt: info.startedAt,
          startedAt: info.startedAt,
          updatedAt: info.startedAt
        };

        store.addTask(task);
        sendControlMessage(ws, { type: 'spawned', sessionId, cli: message.cli, cwd: info.cwd });
        broadcastSessions();
      } catch (error) {
        const text = error instanceof Error ? error.message : 'spawn failed';
        sendControlMessage(ws, { type: 'error', message: text });
      }
      return;
    }

    if (message.type === 'resize') {
      const cols = normalizeDimension(message.cols, 100);
      const rows = normalizeDimension(message.rows, 30);
      ptyManager.resize(message.sessionId, cols, rows);
      return;
    }

    if (message.type === 'kill') {
      killRequested.add(message.sessionId);
      ptyManager.kill(message.sessionId);
    }
  });

  ws.on('close', () => {
    controlClients.delete(ws);
  });
});

terminalWss.on('connection', (ws, request) => {
  const host = request.headers.host ?? 'localhost';
  const parsed = new URL(request.url ?? '/', `http://${host}`);
  const sessionId = parsed.searchParams.get('session');

  if (!sessionId || !ptyManager.hasSession(sessionId)) {
    ws.close(1008, 'invalid session');
    return;
  }

  const sendQueue: string[] = [];
  let queuedBytes = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let drainTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, TERMINAL_SEND_BATCH_MS);
  };

  const waitForDrain = (): void => {
    if (drainTimer || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const checkDrain = (): void => {
      drainTimer = null;
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (ws.bufferedAmount <= TERMINAL_SEND_LOW_WATER_BYTES) {
        if (sendQueue.length > 0) {
          scheduleFlush();
        }
        return;
      }
      drainTimer = setTimeout(checkDrain, TERMINAL_SEND_BATCH_MS);
    };
    drainTimer = setTimeout(checkDrain, TERMINAL_SEND_BATCH_MS);
  };

  const flushQueue = (): void => {
    if (ws.readyState !== WebSocket.OPEN || sendQueue.length === 0) {
      return;
    }
    if (ws.bufferedAmount > TERMINAL_SEND_HIGH_WATER_BYTES) {
      waitForDrain();
      return;
    }

    const payload = sendQueue.join('');
    sendQueue.length = 0;
    queuedBytes = 0;

    ws.send(payload, (error) => {
      if (error && ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'terminal send failed');
        return;
      }
      if (sendQueue.length > 0) {
        scheduleFlush();
      }
    });

    if (ws.bufferedAmount > TERMINAL_SEND_HIGH_WATER_BYTES) {
      waitForDrain();
    }
  };

  const enqueueOutput = (data: string): void => {
    if (!data || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    sendQueue.push(data);
    queuedBytes += Buffer.byteLength(data, 'utf8');
    if (queuedBytes >= TERMINAL_SEND_HIGH_WATER_BYTES) {
      flushQueue();
      return;
    }
    scheduleFlush();
  };

  const replay = ptyManager.getBuffer(sessionId);
  if (replay.length > 0) {
    enqueueOutput(replay);
  }

  const offData = ptyManager.onData((id, data) => {
    if (id === sessionId) {
      enqueueOutput(data);
    }
  });

  const offExit = ptyManager.onExit((id) => {
    if (id === sessionId && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'session exited');
    }
  });

  ws.on('message', (raw) => {
    if (!ptyManager.hasSession(sessionId)) {
      return;
    }
    ptyManager.write(sessionId, rawDataToString(raw));
  });

  ws.on('close', () => {
    clearTimers();
    offData();
    offExit();
  });
});

server.on('upgrade', (request, socket, head) => {
  if (!validateUpgradeToken(request, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const host = request.headers.host ?? 'localhost';
  const parsed = new URL(request.url ?? '/', `http://${host}`);

  if (parsed.pathname === '/ws/control') {
    controlWss.handleUpgrade(request, socket, head, (ws) => {
      controlWss.emit('connection', ws, request);
    });
    return;
  }

  if (parsed.pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
    return;
  }

  socket.destroy();
});

server.listen(port, async () => {
  const localUrl = `http://localhost:${port}/#token=${token}`;
  const lan = getLanAddress();

  console.log(`[c2p] listening on ${port}`);
  console.log(`[c2p] default cwd: ${defaultWorkingDirectory}`);
  console.log(`[c2p] local: ${localUrl}`);
  if (lan) {
    console.log(`[c2p] lan: http://${lan}:${port}/#token=${token}`);
  }

  const tunnelUrl = await startTunnel(port, token);
  if (tunnelUrl) {
    console.log(`[c2p] tunnel: ${tunnelUrl}`);
    console.log('[c2p] scan to connect:');
    qrcode.generate(tunnelUrl, { small: true });
    void pushService.notify('C2P 已启动', '点击连接', {
      type: 'url-update',
      url: tunnelUrl
    });
  }
});
