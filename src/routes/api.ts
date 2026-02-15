import fs from 'node:fs';
import type { Application, Request, Response } from 'express';
import type { PtyManager } from '../pty-manager.js';
import type { PushService } from '../push.js';
import type { C2PStore, PushSubscriptionRecord } from '../store.js';

interface ApiRouteDeps {
  store: C2PStore;
  ptyManager: PtyManager;
  pushService: PushService;
  defaultWorkingDirectory: string;
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

function applySessionLogHeaders(res: Response, logBytes: number): number {
  const contentLength = Math.max(0, logBytes);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(contentLength));
  res.setHeader('X-Log-Bytes', String(contentLength));
  res.setHeader('Cache-Control', 'no-store');
  return contentLength;
}

export function registerApiRoutes(app: Application, deps: ApiRouteDeps): void {
  const { store, ptyManager, pushService, defaultWorkingDirectory } = deps;

  app.get('/api/tasks', (_req: Request, res: Response) => {
    res.json({ tasks: store.listTasks() });
  });

  app.get('/api/sessions', (_req: Request, res: Response) => {
    res.json({ sessions: ptyManager.listSessions() });
  });

  app.head('/api/sessions/:id/log', (req: Request, res: Response) => {
    const sessionId = typeof req.params.id === 'string' ? req.params.id : '';
    const logPath = ptyManager.getLogPath(sessionId);
    if (!logPath) {
      res.status(404).end();
      return;
    }

    applySessionLogHeaders(res, ptyManager.getLogBytes(sessionId));
    res.status(200).end();
  });

  app.get('/api/sessions/:id/log', (req: Request, res: Response) => {
    const sessionId = typeof req.params.id === 'string' ? req.params.id : '';
    const logPath = ptyManager.getLogPath(sessionId);
    if (!logPath) {
      res.status(404).json({ error: 'session log not found' });
      return;
    }

    const contentLength = applySessionLogHeaders(res, ptyManager.getLogBytes(sessionId));

    if (contentLength === 0) {
      res.status(200).end();
      return;
    }

    const stream = fs.createReadStream(logPath, {
      highWaterMark: 64 * 1024,
      end: contentLength - 1
    });

    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ error: 'session log not found' });
        return;
      }
      res.destroy();
    });

    stream.pipe(res);
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
}
