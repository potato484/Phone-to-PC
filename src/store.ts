import fs from 'node:fs';
import path from 'node:path';

const PERSIST_DEBOUNCE_MS = 500;

export type CliKind = 'claude' | 'codex' | 'gemini';
export type TaskStatus = 'running' | 'done' | 'error' | 'killed';

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

export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoreData {
  tasks: TaskRecord[];
  subscriptions: PushSubscriptionRecord[];
}

export class C2PStore {
  private readonly filePath: string;
  private data: StoreData = { tasks: [], subscriptions: [] };
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private persistDirty = false;

  constructor(filePath = path.resolve(process.cwd(), '.c2p-store.json')) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.schedulePersist(true);
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      this.data.subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
    } catch {
      this.data = { tasks: [], subscriptions: [] };
      this.schedulePersist(true);
    }
  }

  private schedulePersist(forceNow = false): void {
    this.persistDirty = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (forceNow) {
      void this.flushPersist();
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flushPersist(): Promise<void> {
    if (this.persistInFlight || !this.persistDirty) {
      return;
    }
    this.persistInFlight = true;
    this.persistDirty = false;

    const next = JSON.stringify(this.data, null, 2);
    const tempPath = `${this.filePath}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tempPath, this.filePath);
    } catch (error) {
      this.persistDirty = true;
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`[c2p] store persist failed: ${text}`);
    } finally {
      this.persistInFlight = false;
      if (this.persistDirty && !this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          void this.flushPersist();
        }, PERSIST_DEBOUNCE_MS);
      }
    }
  }

  listTasks(): TaskRecord[] {
    return [...this.data.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.data.tasks.find((task) => task.id === taskId);
  }

  addTask(task: TaskRecord): void {
    this.data.tasks.push(task);
    if (this.data.tasks.length > 100) {
      this.data.tasks.splice(0, this.data.tasks.length - 100);
    }
    this.schedulePersist();
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): void {
    const task = this.data.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  listSubscriptions(): PushSubscriptionRecord[] {
    return [...this.data.subscriptions];
  }

  upsertSubscription(subscription: PushSubscriptionRecord): void {
    const index = this.data.subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    if (index >= 0) {
      this.data.subscriptions[index] = subscription;
    } else {
      this.data.subscriptions.push(subscription);
    }
    this.schedulePersist();
  }

  removeSubscription(endpoint: string): void {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((item) => item.endpoint !== endpoint);
    if (this.data.subscriptions.length !== before) {
      this.schedulePersist();
    }
  }
}
