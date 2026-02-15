import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Application, Request, Response } from 'express';
import type { PtyManager } from '../pty-manager.js';
import type { PushService } from '../push.js';
import type { C2PStore, PushSubscriptionRecord } from '../store.js';
import type { VncManager } from '../vnc-manager.js';

const FS_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const FS_READ_LIMIT_BYTES = 2 * 1024 * 1024;

interface CpuSnapshot {
  idle: number;
  total: number;
  at: number;
}

interface NetworkSnapshot {
  rxBytes: number;
  txBytes: number;
  at: number;
}

let previousCpuSnapshot: CpuSnapshot | null = null;
let previousNetworkSnapshot: NetworkSnapshot | null = null;

interface ApiRouteDeps {
  store: C2PStore;
  ptyManager: PtyManager;
  pushService: PushService;
  defaultWorkingDirectory: string;
  vncManager: VncManager;
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

function readStringQuery(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return undefined;
}

function readStringBodyField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const candidate = (body as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function readBooleanBodyField(body: unknown, key: string, fallback: boolean): boolean {
  if (!body || typeof body !== 'object') {
    return fallback;
  }
  const candidate = (body as Record<string, unknown>)[key];
  return typeof candidate === 'boolean' ? candidate : fallback;
}

function normalizeRelativeInput(rawPath: string | undefined): string {
  if (!rawPath) {
    return '.';
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/') {
    return '.';
  }
  return trimmed;
}

function isWithinBase(baseDir: string, absolutePath: string): boolean {
  const relative = path.relative(baseDir, absolutePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePathWithinBase(baseDir: string, rawPath: string | undefined): string | null {
  const normalized = normalizeRelativeInput(rawPath);
  const absolutePath = path.resolve(baseDir, normalized);
  if (!isWithinBase(baseDir, absolutePath)) {
    return null;
  }
  return absolutePath;
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function toRelativePath(baseDir: string, absolutePath: string): string {
  const relative = path.relative(baseDir, absolutePath);
  if (!relative) {
    return '.';
  }
  return toPortablePath(relative);
}

function toSessionSafeFilename(filename: string): string {
  return filename.replace(/[^\w.\-]/g, '_');
}

function respondFsError(res: Response, error: unknown): void {
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === 'ENOENT') {
    res.status(404).json({ error: 'path not found' });
    return;
  }
  if (code === 'EEXIST') {
    res.status(409).json({ error: 'target already exists' });
    return;
  }
  if (code === 'ENOTDIR' || code === 'EISDIR' || code === 'EINVAL') {
    res.status(400).json({ error: 'invalid path or operation' });
    return;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    res.status(403).json({ error: 'permission denied' });
    return;
  }
  if (code === 'EFBIG') {
    res.status(413).json({ error: `upload too large (limit=${FS_UPLOAD_LIMIT_BYTES} bytes)` });
    return;
  }
  res.status(500).json({ error: 'filesystem operation failed' });
}

function readCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return {
    idle,
    total,
    at: Date.now()
  };
}

function collectCpuStats(): {
  usagePercent: number;
  loadAverage: number[];
  coreCount: number;
} {
  const sample = readCpuSnapshot();
  let usagePercent = 0;
  if (previousCpuSnapshot) {
    const idleDelta = sample.idle - previousCpuSnapshot.idle;
    const totalDelta = sample.total - previousCpuSnapshot.total;
    if (totalDelta > 0) {
      usagePercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    }
  }
  previousCpuSnapshot = sample;
  return {
    usagePercent: Number(usagePercent.toFixed(2)),
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(3))),
    coreCount: os.cpus().length
  };
}

function collectMemoryStats(): {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
} {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: Number(usagePercent.toFixed(2))
  };
}

function collectDiskStats(baseDir: string): {
  mountPath: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
} | null {
  try {
    const stats = fs.statfsSync(baseDir);
    const blockSize = Number(stats.bsize);
    const blocks = Number(stats.blocks);
    const availableBlocks = Number(stats.bavail);
    const totalBytes = blockSize * blocks;
    const freeBytes = blockSize * availableBlocks;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) {
      return null;
    }
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = (usedBytes / totalBytes) * 100;
    return {
      mountPath: baseDir,
      totalBytes: Math.round(totalBytes),
      usedBytes: Math.round(usedBytes),
      freeBytes: Math.round(freeBytes),
      usagePercent: Number(usagePercent.toFixed(2))
    };
  } catch {
    return null;
  }
}

function readNetworkTotals(): { rxBytes: number; txBytes: number } {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = raw.split('\n').slice(2);
    let rxBytes = 0;
    let txBytes = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [ifacePart, statsPart] = trimmed.split(':');
      if (!ifacePart || !statsPart) {
        continue;
      }
      const iface = ifacePart.trim();
      if (!iface || iface === 'lo') {
        continue;
      }
      const fields = statsPart.trim().split(/\s+/);
      if (fields.length < 9) {
        continue;
      }
      const rx = Number.parseInt(fields[0], 10);
      const tx = Number.parseInt(fields[8], 10);
      if (Number.isFinite(rx)) {
        rxBytes += rx;
      }
      if (Number.isFinite(tx)) {
        txBytes += tx;
      }
    }
    return { rxBytes, txBytes };
  } catch {
    return { rxBytes: 0, txBytes: 0 };
  }
}

function collectNetworkStats(): {
  rxBytes: number;
  txBytes: number;
  rxRateBytesPerSec: number;
  txRateBytesPerSec: number;
} {
  const totals = readNetworkTotals();
  const now = Date.now();
  let rxRateBytesPerSec = 0;
  let txRateBytesPerSec = 0;
  if (previousNetworkSnapshot) {
    const elapsedSec = Math.max(0.001, (now - previousNetworkSnapshot.at) / 1000);
    rxRateBytesPerSec = Math.max(0, (totals.rxBytes - previousNetworkSnapshot.rxBytes) / elapsedSec);
    txRateBytesPerSec = Math.max(0, (totals.txBytes - previousNetworkSnapshot.txBytes) / elapsedSec);
  }
  previousNetworkSnapshot = {
    ...totals,
    at: now
  };
  return {
    rxBytes: totals.rxBytes,
    txBytes: totals.txBytes,
    rxRateBytesPerSec: Number(rxRateBytesPerSec.toFixed(2)),
    txRateBytesPerSec: Number(txRateBytesPerSec.toFixed(2))
  };
}

export function registerApiRoutes(app: Application, deps: ApiRouteDeps): void {
  const { store, ptyManager, pushService, defaultWorkingDirectory, vncManager } = deps;
  const fsRoot = path.resolve(defaultWorkingDirectory);

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

  app.get('/api/fs/list', async (req: Request, res: Response) => {
    const requestPath = readStringQuery(req.query.path);
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'path is not a directory' });
        return;
      }

      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const payload = await Promise.all(
        entries.map(async (entry) => {
          const absolutePath = path.join(targetPath, entry.name);
          let size = 0;
          let mtimeMs = 0;
          try {
            const entryStat = await fs.promises.stat(absolutePath);
            size = entryStat.size;
            mtimeMs = entryStat.mtimeMs;
          } catch {
            // keep defaults for entries that disappear during listing
          }

          const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
          return {
            name: entry.name,
            path: toRelativePath(fsRoot, absolutePath),
            type,
            size,
            mtimeMs: Math.round(mtimeMs)
          };
        })
      );

      payload.sort((left, right) => {
        if (left.type !== right.type) {
          if (left.type === 'dir') {
            return -1;
          }
          if (right.type === 'dir') {
            return 1;
          }
        }
        return left.name.localeCompare(right.name, 'zh-CN-u-kn-true');
      });

      const relativePath = toRelativePath(fsRoot, targetPath);
      const parentPath = targetPath === fsRoot ? null : toRelativePath(fsRoot, path.resolve(targetPath, '..'));
      res.json({
        root: '.',
        path: relativePath,
        parent: parentPath,
        entries: payload
      });
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.get('/api/fs/read', async (req: Request, res: Response) => {
    const requestPath = readStringQuery(req.query.path);
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'path is not a file' });
        return;
      }
      if (stat.size > FS_READ_LIMIT_BYTES) {
        res.status(413).json({ error: `file too large to read (limit=${FS_READ_LIMIT_BYTES} bytes)` });
        return;
      }
      const content = await fs.promises.readFile(targetPath, 'utf8');
      res.json({
        path: toRelativePath(fsRoot, targetPath),
        size: stat.size,
        content
      });
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.post('/api/fs/write', async (req: Request, res: Response) => {
    const requestPath = readStringBodyField(req.body, 'path');
    const content = readStringBodyField(req.body, 'content');
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'invalid content' });
      return;
    }

    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, content, 'utf8');
      res.status(201).json({
        ok: true,
        path: toRelativePath(fsRoot, targetPath),
        bytes: Buffer.byteLength(content, 'utf8')
      });
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.post('/api/fs/mkdir', async (req: Request, res: Response) => {
    const requestPath = readStringBodyField(req.body, 'path');
    const recursive = readBooleanBodyField(req.body, 'recursive', true);
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    try {
      await fs.promises.mkdir(targetPath, { recursive });
      res.status(201).json({
        ok: true,
        path: toRelativePath(fsRoot, targetPath)
      });
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.post('/api/fs/rename', async (req: Request, res: Response) => {
    const sourcePathRaw = readStringBodyField(req.body, 'path');
    const targetPathRaw = readStringBodyField(req.body, 'to');
    const sourcePath = resolvePathWithinBase(fsRoot, sourcePathRaw);
    const targetPath = resolvePathWithinBase(fsRoot, targetPathRaw);
    if (!sourcePath || !targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.rename(sourcePath, targetPath);
      res.json({
        ok: true,
        from: toRelativePath(fsRoot, sourcePath),
        to: toRelativePath(fsRoot, targetPath)
      });
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.post('/api/fs/remove', async (req: Request, res: Response) => {
    const requestPath = readStringBodyField(req.body, 'path');
    const recursive = readBooleanBodyField(req.body, 'recursive', false);
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    if (targetPath === fsRoot) {
      res.status(400).json({ error: 'cannot remove workspace root' });
      return;
    }

    try {
      await fs.promises.rm(targetPath, {
        recursive,
        force: false
      });
      res.json({
        ok: true,
        path: toRelativePath(fsRoot, targetPath)
      });
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.get('/api/fs/download', async (req: Request, res: Response) => {
    const requestPath = readStringQuery(req.query.path);
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'path is not a file' });
        return;
      }

      const filename = toSessionSafeFilename(path.basename(targetPath));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

      const stream = fs.createReadStream(targetPath, { highWaterMark: 64 * 1024 });
      stream.on('error', (error) => {
        if (!res.headersSent) {
          respondFsError(res, error);
          return;
        }
        res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      respondFsError(res, error);
    }
  });

  app.post('/api/fs/upload', async (req: Request, res: Response) => {
    const requestPath = readStringQuery(req.query.path);
    const targetPath = resolvePathWithinBase(fsRoot, requestPath);
    if (!targetPath) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    const declaredLength = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > FS_UPLOAD_LIMIT_BYTES) {
      res.status(413).json({ error: `upload too large (limit=${FS_UPLOAD_LIMIT_BYTES} bytes)` });
      return;
    }

    let writtenBytes = 0;
    const limitTransform = new Transform({
      transform(chunk, _encoding, callback) {
        const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        writtenBytes += payload.byteLength;
        if (writtenBytes > FS_UPLOAD_LIMIT_BYTES) {
          const error = new Error('upload too large') as NodeJS.ErrnoException;
          error.code = 'EFBIG';
          callback(error);
          return;
        }
        callback(null, payload);
      }
    });

    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await pipeline(req, limitTransform, fs.createWriteStream(targetPath, { flags: 'w' }));
      res.status(201).json({
        ok: true,
        path: toRelativePath(fsRoot, targetPath),
        bytes: writtenBytes
      });
    } catch (error) {
      await fs.promises.unlink(targetPath).catch(() => {});
      respondFsError(res, error);
    }
  });

  app.get('/api/system/stats', async (_req: Request, res: Response) => {
    try {
      const disk = collectDiskStats(fsRoot);
      const vnc = await vncManager.getStatusSnapshot();
      res.json({
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor(os.uptime()),
        cpu: collectCpuStats(),
        memory: collectMemoryStats(),
        disk,
        network: collectNetworkStats(),
        vnc
      });
    } catch {
      res.status(500).json({ error: 'failed to collect system stats' });
    }
  });
}
