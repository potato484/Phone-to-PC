import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type IPty } from 'node-pty';
import type { CliKind, SessionRecord as StoreSessionRecord } from './store.js';

const SESSION_LOG_DIR = path.join(process.cwd(), '.c2p-sessions');
const SESSION_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TMUX_SESSION_PREFIX = 'c2p-';
const TMUX_POLL_INTERVAL_MS = 1500;
const ATTACH_KILL_ESCALATION_DELAY_MS = 1200;
const FLOW_CONTROL_PAUSE = '\u0013';
const FLOW_CONTROL_RESUME = '\u0011';
const OSC52_START = '\u001b]52;';
const OSC52_BEL = '\u0007';
const OSC52_ST = '\u001b\\';
const OSC52_MAX_CARRY_CHARS = 8192;
const OSC52_MAX_TEXT_BYTES = 128 * 1024;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

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

export interface RecoverSessionsResult {
  recovered: SessionInfo[];
  discovered: SessionInfo[];
  missing: string[];
}

export interface AttachmentChunk {
  data: string;
  startOffset: number;
  endOffset: number;
  byteLength: number;
}

export interface TerminalAttachment {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pauseOutput(): void;
  resumeOutput(): void;
  close(): void;
  onData(listener: (chunk: AttachmentChunk) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
}

interface SessionRuntime {
  info: SessionInfo;
  logPath: string;
}

interface TmuxSessionSnapshot {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
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

function normalizeDimension(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  if (rounded < 10 || rounded > 500) {
    return fallback;
  }
  return rounded;
}

function normalizeStartedAt(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return fallback;
}

function toIsoFromEpochSeconds(value: unknown, fallback: string): string {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return new Date(parsed * 1000).toISOString();
}

function toSessionId(tmuxSessionName: string): string | null {
  if (!tmuxSessionName.startsWith(TMUX_SESSION_PREFIX)) {
    return null;
  }
  const sessionId = tmuxSessionName.slice(TMUX_SESSION_PREFIX.length).trim();
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  return sessionId;
}

function toTmuxSessionName(sessionId: string): string {
  return `${TMUX_SESSION_PREFIX}${sessionId}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCliCommand(_cli: CliKind): string | null {
  return null;
}

function buildTmuxShellCommand(cli: CliKind): string {
  const command = buildCliCommand(cli);
  if (!command) {
    return '/bin/bash -l';
  }
  return `/bin/bash -lc ${shellQuote(command)}`;
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

function readExecErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  const err = error as NodeJS.ErrnoException & {
    stderr?: Buffer | string;
    output?: Array<Buffer | string | null>;
  };

  if (typeof err.stderr === 'string' && err.stderr.trim().length > 0) {
    return err.stderr.trim();
  }
  if (Buffer.isBuffer(err.stderr) && err.stderr.length > 0) {
    return err.stderr.toString('utf8').trim();
  }
  if (Array.isArray(err.output)) {
    for (const item of err.output) {
      if (!item) {
        continue;
      }
      if (typeof item === 'string' && item.trim().length > 0) {
        return item.trim();
      }
      if (Buffer.isBuffer(item) && item.length > 0) {
        return item.toString('utf8').trim();
      }
    }
  }
  return err.message || 'unknown error';
}

function isTmuxNoServerError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('failed to connect to server') ||
    lower.includes('no server running on') ||
    lower.includes('no such file or directory')
  );
}

export class PtyManager {
  private readonly defaultCwd: string;
  private readonly tmuxBin: string;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly exitListeners = new Set<(sessionId: string, exitCode: number) => void>();
  private readonly clipboardListeners = new Set<(sessionId: string, text: string) => void>();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly tmuxReady: boolean;

  constructor(defaultCwd = process.cwd()) {
    this.defaultCwd = normalizeCwd(defaultCwd, process.cwd());
    this.tmuxBin = (process.env.C2P_TMUX_BIN ?? 'tmux').trim() || 'tmux';

    fs.mkdirSync(SESSION_LOG_DIR, { recursive: true });
    this.cleanStaleLogFiles();

    this.tmuxReady = this.detectTmuxAvailability();
    if (this.tmuxReady) {
      this.startSessionPoll();
    }
  }

  isReady(): boolean {
    return this.tmuxReady;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private detectTmuxAvailability(): boolean {
    try {
      execFileSync(this.tmuxBin, ['-V'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return true;
    } catch {
      return false;
    }
  }

  private ensureTmuxAvailable(): void {
    if (!this.tmuxReady) {
      throw new Error('tmux is required but not available; install tmux or set C2P_TMUX_BIN');
    }
  }

  private runTmux(
    args: string[],
    options: {
      allowNoServer?: boolean;
      allowFailure?: boolean;
    } = {}
  ): string {
    this.ensureTmuxAvailable();
    try {
      const output = execFileSync(this.tmuxBin, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return typeof output === 'string' ? output : String(output);
    } catch (error) {
      const message = readExecErrorMessage(error);
      if (options.allowNoServer && isTmuxNoServerError(message)) {
        return '';
      }
      if (options.allowFailure) {
        return '';
      }
      throw new Error(`tmux ${args.join(' ')} failed: ${message}`);
    }
  }

  private startSessionPoll(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.syncWithTmux();
    }, TMUX_POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private resolveSessionLogPath(sessionId: string): string | null {
    const normalized = sessionId.trim();
    if (!normalized || !SESSION_ID_PATTERN.test(normalized)) {
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

  private listTmuxSessionSnapshots(): Map<string, TmuxSessionSnapshot> {
    const output = this.runTmux(
      ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}\t#{window_width}\t#{window_height}\t#{session_created}'],
      {
        allowNoServer: true
      }
    );

    const snapshots = new Map<string, TmuxSessionSnapshot>();
    const nowIso = new Date().toISOString();

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [rawSessionName, rawCwd, rawCols, rawRows, rawCreated] = trimmed.split('\t');
      if (!rawSessionName) {
        continue;
      }
      const sessionId = toSessionId(rawSessionName);
      if (!sessionId || snapshots.has(sessionId)) {
        continue;
      }

      snapshots.set(sessionId, {
        id: sessionId,
        cwd: normalizeCwd(rawCwd, this.defaultCwd),
        cols: normalizeDimension(rawCols, 100),
        rows: normalizeDimension(rawRows, 30),
        startedAt: toIsoFromEpochSeconds(rawCreated, nowIso)
      });
    }

    return snapshots;
  }

  private resolvePrimaryPaneTarget(sessionId: string): string | null {
    const output = this.runTmux(['list-panes', '-t', toTmuxSessionName(sessionId), '-F', '#{pane_id}'], {
      allowFailure: true,
      allowNoServer: true
    });
    const paneId = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return paneId ?? null;
  }

  private ensureSessionLogPipe(sessionId: string, logPath: string): void {
    const paneTarget = this.resolvePrimaryPaneTarget(sessionId);
    if (!paneTarget) {
      return;
    }

    try {
      fs.closeSync(fs.openSync(logPath, 'a', 0o600));
    } catch {
      // ignore log pre-create errors and rely on pipe command.
    }

    const pipeCommand = `cat >> ${shellQuote(logPath)}`;
    this.runTmux(['pipe-pane', '-o', '-t', paneTarget, pipeCommand], {
      allowFailure: true,
      allowNoServer: true
    });
  }

  private addOrUpdateSession(info: SessionInfo): void {
    const logPath = this.resolveSessionLogPath(info.id);
    if (!logPath) {
      return;
    }
    this.sessions.set(info.id, {
      info: {
        ...info
      },
      logPath
    });
    this.ensureSessionLogPipe(info.id, logPath);
  }

  private removeSession(sessionId: string, exitCode: number): void {
    const removed = this.sessions.delete(sessionId);
    if (!removed) {
      return;
    }
    for (const listener of this.exitListeners) {
      listener(sessionId, exitCode);
    }
  }

  private syncWithTmux(): void {
    if (!this.tmuxReady) {
      return;
    }

    const snapshots = this.listTmuxSessionSnapshots();
    const nowIso = new Date().toISOString();

    for (const existing of this.sessions.values()) {
      const snapshot = snapshots.get(existing.info.id);
      if (!snapshot) {
        continue;
      }
      existing.info.cwd = snapshot.cwd;
      existing.info.cols = snapshot.cols;
      existing.info.rows = snapshot.rows;
    }

    for (const sessionId of Array.from(this.sessions.keys())) {
      if (!snapshots.has(sessionId)) {
        this.removeSession(sessionId, 0);
      }
    }

    for (const snapshot of snapshots.values()) {
      if (this.sessions.has(snapshot.id)) {
        continue;
      }
      this.addOrUpdateSession({
        id: snapshot.id,
        cli: 'shell',
        cwd: normalizeCwd(snapshot.cwd, this.defaultCwd),
        cols: normalizeDimension(snapshot.cols, 100),
        rows: normalizeDimension(snapshot.rows, 30),
        startedAt: normalizeStartedAt(snapshot.startedAt, nowIso)
      });
    }
  }

  onExit(listener: (sessionId: string, exitCode: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onClipboard(listener: (sessionId: string, text: string) => void): () => void {
    this.clipboardListeners.add(listener);
    return () => this.clipboardListeners.delete(listener);
  }

  recoverSessions(records: StoreSessionRecord[]): RecoverSessionsResult {
    if (!this.tmuxReady) {
      return {
        recovered: [],
        discovered: [],
        missing: records.map((record) => record.id)
      };
    }

    const snapshots = this.listTmuxSessionSnapshots();
    const nowIso = new Date().toISOString();
    const recovered: SessionInfo[] = [];
    const discovered: SessionInfo[] = [];
    const missing: string[] = [];

    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !SESSION_ID_PATTERN.test(record.id)) {
        continue;
      }

      const snapshot = snapshots.get(record.id);
      if (!snapshot) {
        missing.push(record.id);
        continue;
      }

      const info: SessionInfo = {
        id: record.id,
        cli: record.cli === 'shell' ? 'shell' : 'shell',
        cwd: normalizeCwd(snapshot.cwd || record.cwd, this.defaultCwd),
        cols: normalizeDimension(snapshot.cols, normalizeDimension(record.cols, 100)),
        rows: normalizeDimension(snapshot.rows, normalizeDimension(record.rows, 30)),
        startedAt: normalizeStartedAt(record.startedAt, snapshot.startedAt || nowIso)
      };

      this.addOrUpdateSession(info);
      recovered.push({ ...info });
      snapshots.delete(record.id);
    }

    for (const snapshot of snapshots.values()) {
      const info: SessionInfo = {
        id: snapshot.id,
        cli: 'shell',
        cwd: normalizeCwd(snapshot.cwd, this.defaultCwd),
        cols: normalizeDimension(snapshot.cols, 100),
        rows: normalizeDimension(snapshot.rows, 30),
        startedAt: normalizeStartedAt(snapshot.startedAt, nowIso)
      };
      this.addOrUpdateSession(info);
      discovered.push({ ...info });
    }

    return {
      recovered,
      discovered,
      missing
    };
  }

  spawn(options: SpawnOptions): SessionInfo {
    this.ensureTmuxAvailable();

    const sessionId = options.id.trim();
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session id: ${options.id}`);
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }

    const cwd = normalizeCwd(options.cwd, this.defaultCwd);
    const cols = normalizeDimension(options.cols, 100);
    const rows = normalizeDimension(options.rows, 30);
    const shellCommand = buildTmuxShellCommand(options.cli);

    this.runTmux([
      'new-session',
      '-d',
      '-s',
      toTmuxSessionName(sessionId),
      '-x',
      String(cols),
      '-y',
      String(rows),
      '-c',
      cwd,
      shellCommand
    ]);

    const info: SessionInfo = {
      id: sessionId,
      cli: options.cli,
      cwd,
      cols,
      rows,
      startedAt: new Date().toISOString()
    };

    this.addOrUpdateSession(info);
    return info;
  }

  attach(sessionId: string, options: { cols: number; rows: number }): TerminalAttachment {
    this.ensureTmuxAvailable();

    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const cols = normalizeDimension(options.cols, runtime.info.cols);
    const rows = normalizeDimension(options.rows, runtime.info.rows);
    const pty = spawn(this.tmuxBin, ['attach-session', '-t', toTmuxSessionName(sessionId)], {
      name: 'xterm-256color',
      cols,
      rows,
      handleFlowControl: true,
      cwd: runtime.info.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      }
    });

    runtime.info.cols = cols;
    runtime.info.rows = rows;

    const dataListeners = new Set<(chunk: AttachmentChunk) => void>();
    const exitListeners = new Set<(exitCode: number) => void>();
    const manager = this;
    let outputPaused = false;
    let killTimer: NodeJS.Timeout | null = null;
    let closed = false;
    let osc52Carry = '';
    let logCursor = this.getLogBytes(sessionId);

    const cleanupKillTimer = (): void => {
      if (!killTimer) {
        return;
      }
      clearTimeout(killTimer);
      killTimer = null;
    };

    const terminate = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      cleanupKillTimer();
      pty.kill('SIGTERM');
      killTimer = setTimeout(() => {
        killTimer = null;
        pty.kill('SIGKILL');
      }, ATTACH_KILL_ESCALATION_DELAY_MS);
    };

    pty.onData((data) => {
      const payload = Buffer.from(data, 'utf8');
      const startOffset = logCursor;
      logCursor += payload.byteLength;

      const osc52 = parseOsc52Clipboard(data, osc52Carry);
      osc52Carry = osc52.carry;
      if (osc52.clipboardTexts.length > 0 && this.clipboardListeners.size > 0) {
        for (const text of osc52.clipboardTexts) {
          for (const listener of this.clipboardListeners) {
            listener(sessionId, text);
          }
        }
      }

      const chunk: AttachmentChunk = {
        data,
        startOffset,
        endOffset: logCursor,
        byteLength: payload.byteLength
      };

      for (const listener of dataListeners) {
        listener(chunk);
      }
    });

    pty.onExit(({ exitCode }) => {
      closed = true;
      cleanupKillTimer();
      for (const listener of exitListeners) {
        listener(typeof exitCode === 'number' ? exitCode : 0);
      }
    });

    return {
      write(data: string | Buffer): void {
        if (closed) {
          return;
        }
        pty.write(data);
      },
      resize(nextCols: number, nextRows: number): void {
        if (closed) {
          return;
        }
        const colsSafe = normalizeDimension(nextCols, runtime.info.cols);
        const rowsSafe = normalizeDimension(nextRows, runtime.info.rows);
        runtime.info.cols = colsSafe;
        runtime.info.rows = rowsSafe;
        pty.resize(colsSafe, rowsSafe);
        manager.resize(sessionId, colsSafe, rowsSafe);
      },
      pauseOutput(): void {
        if (closed || outputPaused) {
          return;
        }
        outputPaused = true;
        pty.write(FLOW_CONTROL_PAUSE);
      },
      resumeOutput(): void {
        if (closed || !outputPaused) {
          return;
        }
        outputPaused = false;
        pty.write(FLOW_CONTROL_RESUME);
      },
      close(): void {
        terminate();
      },
      onData(listener: (chunk: AttachmentChunk) => void): () => void {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit(listener: (exitCode: number) => void): () => void {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      }
    };
  }

  write(_sessionId: string, _data: string | Buffer): void {
    // no-op: tmux input is bound to per-connection attachment clients.
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }

    const nextCols = normalizeDimension(cols, runtime.info.cols);
    const nextRows = normalizeDimension(rows, runtime.info.rows);
    runtime.info.cols = nextCols;
    runtime.info.rows = nextRows;

    this.runTmux(
      ['resize-window', '-t', toTmuxSessionName(sessionId), '-x', String(nextCols), '-y', String(nextRows)],
      {
        allowFailure: true,
        allowNoServer: true
      }
    );
  }

  pauseOutput(_sessionId: string): void {
    // no-op: flow control is handled per attachment.
  }

  resumeOutput(_sessionId: string): void {
    // no-op: flow control is handled per attachment.
  }

  kill(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }

    this.runTmux(['kill-session', '-t', toTmuxSessionName(sessionId)], {
      allowFailure: true,
      allowNoServer: true
    });

    this.removeSession(runtime.info.id, 0);
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
    const logPath = this.getLogPath(sessionId);
    if (!logPath) {
      return 0;
    }
    try {
      return fs.statSync(logPath).size;
    } catch {
      return 0;
    }
  }

  hasSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId) && this.tmuxReady) {
      this.syncWithTmux();
    }
    return this.sessions.has(sessionId);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session.info }));
  }
}
