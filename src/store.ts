import fs from 'node:fs';
import path from 'node:path';

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

  constructor(filePath = path.resolve(process.cwd(), '.c2p-store.json')) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.persist();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      this.data.subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
    } catch {
      this.data = { tasks: [], subscriptions: [] };
      this.persist();
    }
  }

  private persist(): void {
    const next = JSON.stringify(this.data, null, 2);
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
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
    this.persist();
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): void {
    const task = this.data.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();
    this.persist();
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
    this.persist();
  }

  removeSubscription(endpoint: string): void {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((item) => item.endpoint !== endpoint);
    if (this.data.subscriptions.length !== before) {
      this.persist();
    }
  }
}
