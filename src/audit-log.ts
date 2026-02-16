import fs from 'node:fs';
import path from 'node:path';

export interface AuditLogEntry {
  timestamp?: string;
  event: string;
  actor: string;
  resource?: string;
  outcome: 'success' | 'failure';
  metadata?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  dir?: string;
  retentionDays?: number;
}

function resolveAuditDir(rawDir: string | undefined): string {
  if (typeof rawDir === 'string' && rawDir.trim().length > 0) {
    return path.resolve(rawDir.trim());
  }
  return path.resolve(process.cwd(), '.c2p-audit');
}

function toSafeDate(input: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : new Date().toISOString().slice(0, 10);
}

export class AuditLogger {
  private readonly dir: string;
  private readonly retentionDays: number;
  private lastCleanupAt = 0;

  constructor(options: AuditLoggerOptions = {}) {
    this.dir = resolveAuditDir(options.dir);
    this.retentionDays = Math.max(1, Math.min(3650, options.retentionDays ?? 90));
    fs.mkdirSync(this.dir, { recursive: true });
    this.cleanupOldFiles();
  }

  getDir(): string {
    return this.dir;
  }

  log(entry: AuditLogEntry): void {
    const timestamp = entry.timestamp ?? new Date().toISOString();
    const day = toSafeDate(timestamp.slice(0, 10));
    const payload = {
      timestamp,
      event: entry.event,
      actor: entry.actor,
      resource: entry.resource ?? '',
      outcome: entry.outcome,
      metadata: entry.metadata ?? {}
    };

    const filePath = path.join(this.dir, `${day}.jsonl`);
    fs.promises
      .appendFile(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`[c2p] audit: write failed (${text})`);
      });

    if (Date.now() - this.lastCleanupAt > 12 * 60 * 60 * 1000) {
      this.cleanupOldFiles();
    }
  }

  private cleanupOldFiles(): void {
    this.lastCleanupAt = Date.now();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) {
        continue;
      }
      const filePath = path.join(this.dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore retention cleanup failures.
      }
    }
  }
}
