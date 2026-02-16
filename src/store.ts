import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type CliKind = 'shell';
export type TaskStatus = 'running' | 'done' | 'error' | 'killed';
export type SessionStatus = 'running' | 'detached' | 'killed';

export interface TaskRecord {
  id: string;
  cli: CliKind;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  exitCode?: number;
}

export interface IssuedTokenRecord {
  jti: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
  actor: string;
}

export interface SessionRecord {
  id: string;
  cli: CliKind;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
  updatedAt: string;
  status: SessionStatus;
}

export interface TelemetryEventInput {
  deviceId: string;
  eventName: string;
  sessionId?: string;
  happenedAt: string;
  payload: Record<string, unknown>;
}

export interface TelemetryEventRecord extends TelemetryEventInput {
  id: number;
}

export interface TelemetryListOptions {
  limit?: number;
  since?: string;
  eventName?: string;
}

export interface TelemetrySummary {
  totalEvents: number;
  uniqueDevices: number;
  eventCounts: Array<{ eventName: string; count: number }>;
}

interface LegacyStoreData {
  tasks?: unknown;
}

function toInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function toStringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  if (value === 'running' || value === 'done' || value === 'error' || value === 'killed') {
    return value;
  }
  return 'running';
}

function normalizeCliKind(value: unknown): CliKind {
  if (value === 'shell') {
    return value;
  }
  return 'shell';
}

function normalizeSessionStatus(value: unknown): SessionStatus {
  if (value === 'running' || value === 'detached' || value === 'killed') {
    return value;
  }
  return 'running';
}

function normalizeIsoDate(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function ensureDirectoryFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveStorePath(rawPath: string | undefined): string {
  if (typeof rawPath === 'string' && rawPath.trim().length > 0) {
    return path.resolve(rawPath.trim());
  }
  return path.resolve(process.cwd(), '.c2p-store.sqlite');
}

function resolveLegacyJsonPath(dbPath: string): string {
  const dbDir = path.dirname(dbPath);
  return path.resolve(dbDir, '.c2p-store.json');
}

export class C2PStore {
  private readonly filePath: string;
  private readonly db: DatabaseSync;

  constructor(filePath = resolveStorePath(process.env.C2P_DB_PATH)) {
    this.filePath = resolveStorePath(filePath);
    const dbExisted = fs.existsSync(this.filePath);

    ensureDirectoryFor(this.filePath);
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');

    this.initSchema();
    if (!dbExisted) {
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Non-fatal on platforms that do not support chmod.
      }
    }

    if (!dbExisted) {
      const legacyPath = resolveLegacyJsonPath(this.filePath);
      if (fs.existsSync(legacyPath)) {
        this.migrateFromLegacyJson(legacyPath);
      }
    }
  }

  getDbPath(): string {
    return this.filePath;
  }

  ping(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  isWritable(): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE; ROLLBACK;');
      return true;
    } catch {
      return false;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        cli TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        exit_code INTEGER
      );

      CREATE TABLE IF NOT EXISTS tokens (
        jti TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        actor TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        revoked_at TEXT NOT NULL,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cli TEXT NOT NULL,
        cwd TEXT NOT NULL,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        session_id TEXT,
        happened_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      DROP TABLE IF EXISTS push_subscriptions;

      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_happened_at ON telemetry_events(happened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_name ON telemetry_events(event_name);
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_device_id ON telemetry_events(device_id);
    `);
  }

  private migrateFromLegacyJson(legacyPath: string): void {
    let raw = '';
    try {
      raw = fs.readFileSync(legacyPath, 'utf8');
    } catch {
      return;
    }

    let parsed: LegacyStoreData;
    try {
      parsed = JSON.parse(raw) as LegacyStoreData;
    } catch {
      return;
    }

    const backupPath = `${legacyPath}.bak.${Date.now()}`;
    try {
      fs.copyFileSync(legacyPath, backupPath);
    } catch {
      // Backup failure should not block migration.
    }

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const insertTask = this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, cli, prompt, cwd, status, created_at, started_at, finished_at, updated_at, exit_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');

      for (const task of tasks) {
        if (!task || typeof task !== 'object') {
          continue;
        }
        const row = task as Record<string, unknown>;
        const id = toStringValue(row.id).trim();
        if (!id) {
          continue;
        }
        const createdAt = normalizeIsoDate(row.createdAt, now);
        const startedAt = normalizeIsoDate(row.startedAt, createdAt);
        const updatedAt = normalizeIsoDate(row.updatedAt, startedAt);
        insertTask.run(
          id,
          normalizeCliKind(row.cli),
          toStringValue(row.prompt),
          toStringValue(row.cwd, process.cwd()),
          normalizeTaskStatus(row.status),
          createdAt,
          startedAt,
          optionalString(row.finishedAt) ?? null,
          updatedAt,
          Number.isFinite(Number(row.exitCode)) ? Number(row.exitCode) : null
        );
      }

      this.db.exec('COMMIT');
      console.log(`[c2p] store: migrated legacy JSON -> SQLite (${legacyPath})`);
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`[c2p] store: migrate legacy JSON failed (${text})`);
    }
  }

  listTasks(): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, cli, prompt, cwd, status, created_at, started_at, finished_at, updated_at, exit_code
         FROM tasks
         ORDER BY created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: toStringValue(row.id),
      cli: normalizeCliKind(row.cli),
      prompt: toStringValue(row.prompt),
      cwd: toStringValue(row.cwd),
      status: normalizeTaskStatus(row.status),
      createdAt: toStringValue(row.created_at),
      startedAt: toStringValue(row.started_at),
      finishedAt: optionalString(row.finished_at),
      updatedAt: toStringValue(row.updated_at),
      exitCode: Number.isFinite(Number(row.exit_code)) ? Number(row.exit_code) : undefined
    }));
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, cli, prompt, cwd, status, created_at, started_at, finished_at, updated_at, exit_code
         FROM tasks WHERE id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: toStringValue(row.id),
      cli: normalizeCliKind(row.cli),
      prompt: toStringValue(row.prompt),
      cwd: toStringValue(row.cwd),
      status: normalizeTaskStatus(row.status),
      createdAt: toStringValue(row.created_at),
      startedAt: toStringValue(row.started_at),
      finishedAt: optionalString(row.finished_at),
      updatedAt: toStringValue(row.updated_at),
      exitCode: Number.isFinite(Number(row.exit_code)) ? Number(row.exit_code) : undefined
    };
  }

  addTask(task: TaskRecord): void {
    const exitCode =
      typeof task.exitCode === 'number' && Number.isFinite(task.exitCode) ? Math.trunc(task.exitCode) : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (
          id, cli, prompt, cwd, status, created_at, started_at, finished_at, updated_at, exit_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.cli,
        task.prompt,
        task.cwd,
        task.status,
        task.createdAt,
        task.startedAt,
        task.finishedAt ?? null,
        task.updatedAt,
        exitCode
      );

    this.db
      .prepare(
        `DELETE FROM tasks WHERE id NOT IN (
           SELECT id FROM tasks ORDER BY created_at DESC LIMIT 100
         )`
      )
      .run();
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): void {
    const current = this.getTask(taskId);
    if (!current) {
      return;
    }

    const next: TaskRecord = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: new Date().toISOString()
    };

    this.addTask(next);
  }

  recordIssuedToken(record: IssuedTokenRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO tokens (jti, scope, issued_at, expires_at, actor) VALUES (?, ?, ?, ?, ?)')
      .run(record.jti, record.scope, record.issuedAt, record.expiresAt, record.actor);
  }

  isTokenRevoked(jti: string): boolean {
    const row = this.db.prepare('SELECT jti FROM revoked_tokens WHERE jti = ?').get(jti) as
      | Record<string, unknown>
      | undefined;
    return !!row;
  }

  revokeToken(jti: string, reason = ''): void {
    this.db
      .prepare('INSERT OR REPLACE INTO revoked_tokens (jti, revoked_at, reason) VALUES (?, ?, ?)')
      .run(jti, new Date().toISOString(), reason || null);
  }

  upsertSession(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (
          id, cli, cwd, cols, rows, started_at, updated_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.cli,
        session.cwd,
        session.cols,
        session.rows,
        session.startedAt,
        session.updatedAt,
        session.status
      );
  }

  updateSession(sessionId: string, patch: Partial<SessionRecord>): void {
    const current = this.getSession(sessionId);
    if (!current) {
      return;
    }

    const next: SessionRecord = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: new Date().toISOString()
    };
    this.upsertSession(next);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, cli, cwd, cols, rows, started_at, updated_at, status
         FROM sessions WHERE id = ?`
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: toStringValue(row.id),
      cli: normalizeCliKind(row.cli),
      cwd: toStringValue(row.cwd, process.cwd()),
      cols: toInt(row.cols, 100),
      rows: toInt(row.rows, 30),
      startedAt: toStringValue(row.started_at),
      updatedAt: toStringValue(row.updated_at),
      status: normalizeSessionStatus(row.status)
    };
  }

  listSessions(): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, cli, cwd, cols, rows, started_at, updated_at, status
         FROM sessions
         ORDER BY updated_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: toStringValue(row.id),
      cli: normalizeCliKind(row.cli),
      cwd: toStringValue(row.cwd, process.cwd()),
      cols: toInt(row.cols, 100),
      rows: toInt(row.rows, 30),
      startedAt: toStringValue(row.started_at),
      updatedAt: toStringValue(row.updated_at),
      status: normalizeSessionStatus(row.status)
    }));
  }

  addTelemetryEvent(event: TelemetryEventInput): void {
    const payloadJson = JSON.stringify(event.payload || {});
    this.db
      .prepare(
        `INSERT INTO telemetry_events (
          device_id, event_name, session_id, happened_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(event.deviceId, event.eventName, event.sessionId ?? null, event.happenedAt, payloadJson);
  }

  listTelemetryEvents(options: TelemetryListOptions = {}): TelemetryEventRecord[] {
    const rawLimit = Number(options.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 100;
    const since = typeof options.since === 'string' && options.since.length > 0 ? options.since : '';
    const eventName = typeof options.eventName === 'string' && options.eventName.length > 0 ? options.eventName : '';

    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (since) {
      whereClauses.push('happened_at >= ?');
      params.push(since);
    }
    if (eventName) {
      whereClauses.push('event_name = ?');
      params.push(eventName);
    }

    let sql =
      'SELECT id, device_id, event_name, session_id, happened_at, payload_json FROM telemetry_events';
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    sql += ' ORDER BY happened_at DESC, id DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: toInt(row.id, 0),
      deviceId: toStringValue(row.device_id),
      eventName: toStringValue(row.event_name),
      sessionId: optionalString(row.session_id),
      happenedAt: toStringValue(row.happened_at),
      payload: parseJsonObject(row.payload_json)
    }));
  }

  getTelemetrySummary(options: Omit<TelemetryListOptions, 'limit'> = {}): TelemetrySummary {
    const since = typeof options.since === 'string' && options.since.length > 0 ? options.since : '';
    const eventName = typeof options.eventName === 'string' && options.eventName.length > 0 ? options.eventName : '';

    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (since) {
      whereClauses.push('happened_at >= ?');
      params.push(since);
    }
    if (eventName) {
      whereClauses.push('event_name = ?');
      params.push(eventName);
    }

    const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
    const countSql = `SELECT COUNT(*) AS total, COUNT(DISTINCT device_id) AS devices FROM telemetry_events${whereSql}`;
    const countRow = this.db.prepare(countSql).get(...params) as Record<string, unknown> | undefined;

    const groupSql =
      `SELECT event_name, COUNT(*) AS count FROM telemetry_events${whereSql}` +
      ' GROUP BY event_name ORDER BY count DESC, event_name ASC';
    const eventRows = this.db.prepare(groupSql).all(...params) as Array<Record<string, unknown>>;

    return {
      totalEvents: toInt(countRow?.total, 0),
      uniqueDevices: toInt(countRow?.devices, 0),
      eventCounts: eventRows.map((row) => ({
        eventName: toStringValue(row.event_name),
        count: toInt(row.count, 0)
      }))
    };
  }

  close(): void {
    this.db.close();
  }
}
