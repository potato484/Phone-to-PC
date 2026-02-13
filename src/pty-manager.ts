import fs from 'node:fs';
import { spawn, type IPty } from 'node-pty';
import type { CliKind } from './store.js';

const BUFFER_LIMIT_BYTES = 50 * 1024;

export interface SpawnOptions {
  id: string;
  cli: CliKind;
  cwd?: string;
  cols: number;
  rows: number;
  prompt?: string;
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
  buffer: Buffer[];
  bufferedBytes: number;
}

type DataListener = (sessionId: string, data: string) => void;
type ExitListener = (sessionId: string, exitCode: number) => void;

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeCwd(rawCwd: string | undefined): string {
  if (!rawCwd || rawCwd.trim().length === 0) {
    return process.cwd();
  }
  const candidate = rawCwd.trim();
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return process.cwd();
}

function buildCliCommand(cli: CliKind, prompt?: string): string {
  let base = '';
  if (cli === 'claude') {
    base = 'claude --dangerously-skip-permissions';
  } else if (cli === 'codex') {
    base = 'codex --full-auto';
  } else {
    base = 'gemini';
  }

  if (prompt && prompt.trim().length > 0 && cli === 'claude') {
    base += ` -p ${quoteForShell(prompt.trim())}`;
  }
  return base;
}

export class PtyManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

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

    const cwd = normalizeCwd(options.cwd);
    const command = buildCliCommand(options.cli, options.prompt);

    const pty = spawn('/bin/bash', ['-lc', command], {
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
      buffer: [],
      bufferedBytes: 0
    };

    pty.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      record.buffer.push(chunk);
      record.bufferedBytes += chunk.byteLength;

      while (record.bufferedBytes > BUFFER_LIMIT_BYTES && record.buffer.length > 0) {
        const removed = record.buffer.shift();
        if (removed) {
          record.bufferedBytes -= removed.byteLength;
        }
      }

      for (const listener of this.dataListeners) {
        listener(options.id, data);
      }
    });

    pty.onExit(({ exitCode }) => {
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
    return Buffer.concat(session.buffer).toString('utf8');
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session.info }));
  }
}
