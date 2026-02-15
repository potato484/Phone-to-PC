import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { PtyManager } from '../pty-manager.js';
import type { PushService } from '../push.js';
import type { C2PStore, CliKind, TaskRecord, TaskStatus } from '../store.js';
import type { WsChannel } from './channel.js';

interface ControlHelloMessage {
  type: 'hello';
  version?: number;
  capabilities?: unknown;
}

interface ControlSpawnMessage {
  type: 'spawn';
  cli: CliKind;
  cwd?: string;
  cols?: number;
  rows?: number;
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

type ControlMessage =
  | ControlHelloMessage
  | ControlSpawnMessage
  | ControlResizeMessage
  | ControlKillMessage;

type ControlOutbound =
  | { type: 'hello'; version: 1; capabilities: string[] }
  | { type: 'spawned'; sessionId: string; cli: CliKind; cwd: string }
  | { type: 'exited'; sessionId: string; exitCode: number }
  | { type: 'sessions'; list: unknown[] }
  | { type: 'error'; message: string };

interface ControlChannelDeps {
  ptyManager: PtyManager;
  store: C2PStore;
  pushService: PushService;
}

const HELLO_PAYLOAD: ControlOutbound = {
  type: 'hello',
  version: 1,
  capabilities: ['shell']
};

function isCliKind(value: unknown): value is CliKind {
  return value === 'shell';
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

function shortenSessionId(sessionId: string): string {
  if (sessionId.length <= 12) {
    return sessionId;
  }
  return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`;
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

  if (candidate.type === 'hello') {
    return {
      type: 'hello',
      version: typeof candidate.version === 'number' ? candidate.version : undefined,
      capabilities: candidate.capabilities
    };
  }

  if (candidate.type === 'spawn' && isCliKind(candidate.cli)) {
    return {
      type: 'spawn',
      cli: candidate.cli,
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
      cols: typeof candidate.cols === 'number' ? candidate.cols : undefined,
      rows: typeof candidate.rows === 'number' ? candidate.rows : undefined
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

export function createControlChannel(deps: ControlChannelDeps): WsChannel {
  const { ptyManager, store, pushService } = deps;
  const wss = new WebSocketServer({ noServer: true });
  const controlClients = new Set<WebSocket>();
  const killRequested = new Set<string>();

  const broadcastControl = (payload: ControlOutbound): void => {
    const data = JSON.stringify(payload);
    for (const client of controlClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

  const broadcastSessions = (): void => {
    broadcastControl({ type: 'sessions', list: ptyManager.listSessions() });
  };

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
      const shortId = shortenSessionId(sessionId);
      const title = status === 'done' ? '任务已完成' : status === 'error' ? '任务异常退出' : '会话已终止';
      const body =
        status === 'done'
          ? `会话 ${shortId} 已结束`
          : status === 'error'
            ? `会话 ${shortId} 退出码 ${exitCode}`
            : `会话 ${shortId} 已被终止`;
      void pushService.notify(title, body, {
        sessionId,
        cli: task.cli,
        exitCode,
        status
      });
    }
  });

  wss.on('connection', (ws) => {
    controlClients.add(ws);
    sendControlMessage(ws, HELLO_PAYLOAD);
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

      if (message.type === 'hello') {
        sendControlMessage(ws, HELLO_PAYLOAD);
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
            rows
          });

          const task: TaskRecord = {
            id: sessionId,
            cli: message.cli,
            prompt: '',
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

  return {
    pathname: '/ws/control',
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  };
}
