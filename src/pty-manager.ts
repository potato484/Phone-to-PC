import fs from 'node:fs';
import path from 'node:path';
import { spawn, type IPty } from 'node-pty';
import type { CliKind } from './store.js';

const BUFFER_LIMIT_BYTES = 50 * 1024;
const BUFFER_FLUSH_INTERVAL_MS = 4;
const RING_INITIAL_CAPACITY = 16;
const SESSION_LOG_DIR = path.join(process.cwd(), '.c2p-sessions');
const SESSION_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FLOW_CONTROL_PAUSE = '\u0013';
const FLOW_CONTROL_RESUME = '\u0011';
const KILL_ESCALATION_DELAY_MS = 1500;
const OSC52_START = '\u001b]52;';
const OSC52_BEL = '\u0007';
const OSC52_ST = '\u001b\\';
const OSC52_MAX_CARRY_CHARS = 8192;
const OSC52_MAX_TEXT_BYTES = 128 * 1024;

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
  pendingData: PendingChunk[];
  flushTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  logStream: fs.WriteStream | null;
  logPath: string;
  logBytes: number;
  outputPaused: boolean;
  osc52Carry: string;
}

type DataListener = (sessionId: string, data: string) => void;
export interface DataChunk {
  data: string;
  startOffset: number;
  endOffset: number;
  byteLength: number;
}
type DataChunkListener = (sessionId: string, chunk: DataChunk) => void;
type ExitListener = (sessionId: string, exitCode: number) => void;
type ClipboardListener = (sessionId: string, text: string) => void;

interface PendingChunk {
  data: string;
  startOffset: number;
  endOffset: number;
  byteLength: number;
}

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

function parseOsc52Clipboard(data: string, carry: string): { clipboardTexts: string[]; carry: string } {
  const combined = `${carry}${data}`;
  const clipboardTexts: string[] = [];
  let searchFrom = 0;
  let incompleteStart = -1;

  while (searchFrom < combined.length) {
    const start = combined.indexOf(OSC52_START, searchFrom);
    if (start === -1) {
      break;
    }

    const targetDelimiter = combined.indexOf(';', start + OSC52_START.length);
    if (targetDelimiter === -1) {
      incompleteStart = start;
      break;
    }

    const belIndex = combined.indexOf(OSC52_BEL, targetDelimiter + 1);
    const stIndex = combined.indexOf(OSC52_ST, targetDelimiter + 1);
    let endIndex = -1;
    let terminatorLength = 0;
    if (belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)) {
      endIndex = belIndex;
      terminatorLength = 1;
    } else if (stIndex !== -1) {
      endIndex = stIndex;
      terminatorLength = 2;
    }

    if (endIndex === -1) {
      incompleteStart = start;
      break;
    }

    const encoded = combined.slice(targetDelimiter + 1, endIndex).trim();
    if (encoded.length > 0 && /^[A-Za-z0-9+/=]+$/.test(encoded)) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (decoded.length > 0 && Buffer.byteLength(decoded, 'utf8') <= OSC52_MAX_TEXT_BYTES) {
        clipboardTexts.push(decoded);
      }
    }
    searchFrom = endIndex + terminatorLength;
  }

  let nextCarry = '';
  if (incompleteStart >= 0) {
    nextCarry = combined.slice(incompleteStart);
  }
  if (nextCarry.length > OSC52_MAX_CARRY_CHARS) {
    nextCarry = nextCarry.slice(-OSC52_MAX_CARRY_CHARS);
  }

  return {
    clipboardTexts,
    carry: nextCarry
  };
}

export class PtyManager {
  private readonly defaultCwd: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dataListeners = new Set<DataListener>();
  private readonly dataChunkListeners = new Set<DataChunkListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly clipboardListeners = new Set<ClipboardListener>();

  constructor(defaultCwd = process.cwd()) {
    this.defaultCwd = normalizeCwd(defaultCwd, process.cwd());
    fs.mkdirSync(SESSION_LOG_DIR, { recursive: true });
    this.cleanStaleLogFiles();
  }

  private resolveSessionLogPath(sessionId: string): string | null {
    const normalized = sessionId.trim();
    if (!normalized || !/^[a-zA-Z0-9-]+$/.test(normalized)) {
      return null;
    }
    return path.join(SESSION_LOG_DIR, `${normalized}.log`);
  }

  private cleanStaleLogFiles(): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(SESSION_LOG_DIR, { withFileTypes: true });
    } catch {
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) {
        continue;
      }
      const target = path.join(SESSION_LOG_DIR, entry.name);
      try {
        const stat = fs.statSync(target);
        if (now - stat.mtimeMs > SESSION_LOG_MAX_AGE_MS) {
          fs.unlinkSync(target);
        }
      } catch {
        // ignore cleanup failures for stale files
      }
    }
  }

  private flushData(sessionId: string, record: SessionRecord): void {
    record.flushTimer = null;
    if (record.pendingData.length === 0) {
      return;
    }
    const chunks = record.pendingData.slice();
    const merged = chunks.map((chunk) => chunk.data).join('');
    record.pendingData.length = 0;
    for (const listener of this.dataListeners) {
      listener(sessionId, merged);
    }
    if (this.dataChunkListeners.size > 0) {
      for (const chunk of chunks) {
        const payload: DataChunk = {
          data: chunk.data,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          byteLength: chunk.byteLength
        };
        for (const listener of this.dataChunkListeners) {
          listener(sessionId, payload);
        }
      }
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

  onDataChunk(listener: DataChunkListener): () => void {
    this.dataChunkListeners.add(listener);
    return () => this.dataChunkListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onClipboard(listener: ClipboardListener): () => void {
    this.clipboardListeners.add(listener);
    return () => this.clipboardListeners.delete(listener);
  }

  spawn(options: SpawnOptions): SessionInfo {
    if (this.sessions.has(options.id)) {
      throw new Error(`Session already exists: ${options.id}`);
    }
    const logPath = this.resolveSessionLogPath(options.id);
    if (!logPath) {
      throw new Error(`Invalid session id: ${options.id}`);
    }

    const cwd = normalizeCwd(options.cwd, this.defaultCwd);
    const command = buildCliCommand(options.cli);

    const pty = command
      ? spawn('/bin/bash', ['-lc', command], {
          name: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          handleFlowControl: true,
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
          handleFlowControl: true,
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

    let existingLogBytes = 0;
    try {
      existingLogBytes = fs.statSync(logPath).size;
    } catch {
      existingLogBytes = 0;
    }

    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (error) => {
      console.warn(`[c2p] session log write failed (${options.id}): ${error.message}`);
    });

    const record: SessionRecord = {
      info,
      pty,
      buffer: createBufferRing(),
      pendingData: [],
      flushTimer: null,
      killTimer: null,
      logStream,
      logPath,
      logBytes: existingLogBytes,
      outputPaused: false,
      osc52Carry: ''
    };

    pty.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      pushRingChunk(record.buffer, chunk);

      while (record.buffer.totalBytes > BUFFER_LIMIT_BYTES && record.buffer.length > 0) {
        shiftRingChunk(record.buffer);
      }
      if (record.logStream && !record.logStream.destroyed) {
        record.logStream.write(chunk);
      }
      const startOffset = record.logBytes;
      record.logBytes += chunk.byteLength;
      record.pendingData.push({
        data,
        startOffset,
        endOffset: record.logBytes,
        byteLength: chunk.byteLength
      });
      const osc52 = parseOsc52Clipboard(data, record.osc52Carry);
      record.osc52Carry = osc52.carry;
      if (osc52.clipboardTexts.length > 0 && this.clipboardListeners.size > 0) {
        for (const text of osc52.clipboardTexts) {
          for (const listener of this.clipboardListeners) {
            listener(options.id, text);
          }
        }
      }
      this.scheduleDataFlush(options.id, record);
    });

    pty.onExit(({ exitCode }) => {
      if (record.flushTimer) {
        clearTimeout(record.flushTimer);
        record.flushTimer = null;
      }
      if (record.killTimer) {
        clearTimeout(record.killTimer);
        record.killTimer = null;
      }
      this.flushData(options.id, record);
      if (record.logStream) {
        record.logStream.end();
        record.logStream = null;
      }
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

  pauseOutput(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.outputPaused) {
      return;
    }
    session.outputPaused = true;
    session.pty.write(FLOW_CONTROL_PAUSE);
  }

  resumeOutput(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.outputPaused) {
      return;
    }
    session.outputPaused = false;
    session.pty.write(FLOW_CONTROL_RESUME);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = null;
    }
    session.pty.kill('SIGTERM');
    session.killTimer = setTimeout(() => {
      const active = this.sessions.get(sessionId);
      if (!active) {
        return;
      }
      active.killTimer = null;
      active.pty.kill('SIGKILL');
    }, KILL_ESCALATION_DELAY_MS);
  }

  getBuffer(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.buffer.length === 0) {
      return '';
    }
    return Buffer.concat(ringToBufferArray(session.buffer)).toString('utf8');
  }

  getLogPath(sessionId: string): string | null {
    const active = this.sessions.get(sessionId);
    if (active) {
      return active.logPath;
    }
    const logPath = this.resolveSessionLogPath(sessionId);
    if (!logPath) {
      return null;
    }
    try {
      if (fs.statSync(logPath).isFile()) {
        return logPath;
      }
    } catch {
      return null;
    }
    return null;
  }

  getLogBytes(sessionId: string): number {
    const active = this.sessions.get(sessionId);
    const logPath = active ? active.logPath : this.getLogPath(sessionId);
    if (!logPath) {
      return 0;
    }
    try {
      return fs.statSync(logPath).size;
    } catch {
      return active ? active.logBytes : 0;
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session.info }));
  }
}
