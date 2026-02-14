import fs from 'node:fs';
import { spawn, type IPty } from 'node-pty';
import type { CliKind } from './store.js';

const BUFFER_LIMIT_BYTES = 50 * 1024;
const BUFFER_FLUSH_INTERVAL_MS = 4;
const RING_INITIAL_CAPACITY = 16;

export interface SpawnOptions {
  id: string;
  cli: CliKind;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface SessionInfo {
  id: string;
  cli: CliKind;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
}

interface SessionRecord {
  info: SessionInfo;
  pty: IPty;
  buffer: BufferRing;
  pendingData: string[];
  flushTimer: NodeJS.Timeout | null;
}

type DataListener = (sessionId: string, data: string) => void;
type ExitListener = (sessionId: string, exitCode: number) => void;

interface BufferRing {
  chunks: Array<Buffer | undefined>;
  head: number;
  length: number;
  totalBytes: number;
}

function resolveDirectory(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }
  const candidate = rawPath.trim();
  if (candidate.length === 0) {
    return undefined;
  }
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeCwd(rawCwd: string | undefined, fallbackCwd: string): string {
  return resolveDirectory(rawCwd) ?? resolveDirectory(fallbackCwd) ?? process.cwd();
}

function createBufferRing(capacity = RING_INITIAL_CAPACITY): BufferRing {
  return {
    chunks: new Array<Buffer | undefined>(capacity),
    head: 0,
    length: 0,
    totalBytes: 0
  };
}

function ensureRingCapacity(ring: BufferRing): void {
  if (ring.length < ring.chunks.length) {
    return;
  }
  const nextChunks = new Array<Buffer | undefined>(ring.chunks.length * 2);
  for (let i = 0; i < ring.length; i += 1) {
    const sourceIndex = (ring.head + i) % ring.chunks.length;
    nextChunks[i] = ring.chunks[sourceIndex];
  }
  ring.chunks = nextChunks;
  ring.head = 0;
}

function pushRingChunk(ring: BufferRing, chunk: Buffer): void {
  ensureRingCapacity(ring);
  const tail = (ring.head + ring.length) % ring.chunks.length;
  ring.chunks[tail] = chunk;
  ring.length += 1;
  ring.totalBytes += chunk.byteLength;
}

function shiftRingChunk(ring: BufferRing): Buffer | undefined {
  if (ring.length === 0) {
    return undefined;
  }
  const chunk = ring.chunks[ring.head];
  ring.chunks[ring.head] = undefined;
  ring.head = (ring.head + 1) % ring.chunks.length;
  ring.length -= 1;
  if (chunk) {
    ring.totalBytes -= chunk.byteLength;
  }
  return chunk;
}

function ringToBufferArray(ring: BufferRing): Buffer[] {
  const result: Buffer[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const chunk = ring.chunks[(ring.head + i) % ring.chunks.length];
    if (chunk) {
      result.push(chunk);
    }
  }
  return result;
}

function buildCliCommand(_cli: CliKind): string | null {
  return null;
}

export class PtyManager {
  private readonly defaultCwd: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  constructor(defaultCwd = process.cwd()) {
    this.defaultCwd = normalizeCwd(defaultCwd, process.cwd());
  }

  private flushData(sessionId: string, record: SessionRecord): void {
    record.flushTimer = null;
    if (record.pendingData.length === 0) {
      return;
    }
    const merged = record.pendingData.join('');
    record.pendingData.length = 0;
    for (const listener of this.dataListeners) {
      listener(sessionId, merged);
    }
  }

  private scheduleDataFlush(sessionId: string, record: SessionRecord): void {
    if (record.flushTimer) {
      return;
    }
    record.flushTimer = setTimeout(() => {
      this.flushData(sessionId, record);
    }, BUFFER_FLUSH_INTERVAL_MS);
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  spawn(options: SpawnOptions): SessionInfo {
    if (this.sessions.has(options.id)) {
      throw new Error(`Session already exists: ${options.id}`);
    }

    const cwd = normalizeCwd(options.cwd, this.defaultCwd);
    const command = buildCliCommand(options.cli);

    const pty = command
      ? spawn('/bin/bash', ['-lc', command], {
          name: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color'
          }
        })
      : spawn('/bin/bash', ['-l'], {
          name: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color'
          }
        });

    const info: SessionInfo = {
      id: options.id,
      cli: options.cli,
      cwd,
      cols: options.cols,
      rows: options.rows,
      startedAt: new Date().toISOString()
    };

    const record: SessionRecord = {
      info,
      pty,
      buffer: createBufferRing(),
      pendingData: [],
      flushTimer: null
    };

    pty.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      pushRingChunk(record.buffer, chunk);

      while (record.buffer.totalBytes > BUFFER_LIMIT_BYTES && record.buffer.length > 0) {
        shiftRingChunk(record.buffer);
      }
      record.pendingData.push(data);
      this.scheduleDataFlush(options.id, record);
    });

    pty.onExit(({ exitCode }) => {
      if (record.flushTimer) {
        clearTimeout(record.flushTimer);
        record.flushTimer = null;
      }
      this.flushData(options.id, record);
      this.sessions.delete(options.id);
      for (const listener of this.exitListeners) {
        listener(options.id, exitCode);
      }
    });

    this.sessions.set(options.id, record);
    return info;
  }

  write(sessionId: string, data: string | Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.info.cols = cols;
    session.info.rows = rows;
    session.pty.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pty.kill();
  }

  getBuffer(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.buffer.length === 0) {
      return '';
    }
    return Buffer.concat(ringToBufferArray(session.buffer)).toString('utf8');
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session.info }));
  }
}
