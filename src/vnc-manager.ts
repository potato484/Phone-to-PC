import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

const VNC_CONNECT_TIMEOUT_MS = 900;
const VNC_START_TIMEOUT_MS = 8_000;
const VNC_START_POLL_MS = 240;
const VNC_STOP_GRACE_MS = 1_200;

interface VncCandidate {
  backend: string;
  command: string;
  args: string[];
}

export interface VncEndpoint {
  host: string;
  port: number;
}

export interface VncStatus {
  endpoint: VncEndpoint;
  available: boolean;
  managed: boolean;
  backend: string;
  autoStart: boolean;
  message: string;
}

function normalizePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function isDisabledFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAlive(processRef: ChildProcess | null): processRef is ChildProcess {
  return !!processRef && processRef.exitCode === null && !processRef.killed;
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const checker = spawn('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    checker.once('error', () => resolve(false));
    checker.once('close', (code) => resolve(code === 0));
  });
}

async function canConnect(endpoint: VncEndpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, VNC_CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForEndpoint(endpoint: VncEndpoint, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(endpoint)) {
      return true;
    }
    await delay(VNC_START_POLL_MS);
  }
  return false;
}

export class VncManager {
  private readonly endpoint: VncEndpoint;
  private readonly autoStart: boolean;
  private readonly customCommand: string;
  private managedProcess: ChildProcess | null = null;
  private managedBackend = '';
  private ensurePending: Promise<VncStatus> | null = null;
  private lastMessage = 'not checked';

  constructor() {
    this.endpoint = {
      host: process.env.C2P_VNC_HOST?.trim() || '127.0.0.1',
      port: normalizePort(process.env.C2P_VNC_PORT, 5900)
    };
    this.autoStart = !isDisabledFlag(process.env.C2P_VNC_AUTOSTART);
    this.customCommand = process.env.C2P_VNC_START_CMD?.trim() || '';
  }

  getEndpoint(): VncEndpoint {
    return { ...this.endpoint };
  }

  async getStatusSnapshot(): Promise<VncStatus> {
    const available = await canConnect(this.endpoint);
    const managed = available && isAlive(this.managedProcess);
    const backend = managed ? this.managedBackend || 'managed' : available ? 'external' : 'none';
    const message = available
      ? managed
        ? `vnc ready via ${backend}`
        : 'vnc endpoint reachable'
      : this.lastMessage || 'vnc unavailable';
    return this.toStatus({
      available,
      managed,
      backend,
      message
    });
  }

  async ensureAvailable(): Promise<VncStatus> {
    if (this.ensurePending) {
      return this.ensurePending;
    }
    this.ensurePending = this.ensureAvailableInternal().finally(() => {
      this.ensurePending = null;
    });
    return this.ensurePending;
  }

  dispose(): void {
    this.stopManagedProcess();
  }

  private toStatus(input: {
    available: boolean;
    managed: boolean;
    backend: string;
    message: string;
  }): VncStatus {
    return {
      endpoint: this.getEndpoint(),
      available: input.available,
      managed: input.managed,
      backend: input.backend,
      autoStart: this.autoStart,
      message: input.message
    };
  }

  private buildCandidates(): VncCandidate[] {
    if (this.customCommand) {
      return [
        {
          backend: 'custom',
          command: 'bash',
          args: ['-lc', this.customCommand]
        }
      ];
    }

    const candidates: VncCandidate[] = [];
    if (os.platform() === 'linux') {
      const display = process.env.DISPLAY || ':0';
      candidates.push({
        backend: 'x11vnc',
        command: 'x11vnc',
        args: [
          '-display',
          display,
          '-rfbport',
          String(this.endpoint.port),
          '-localhost',
          '-nopw',
          '-forever',
          '-shared'
        ]
      });
      candidates.push({
        backend: 'wayvnc',
        command: 'wayvnc',
        args: [this.endpoint.host, String(this.endpoint.port)]
      });
    }
    return candidates;
  }

  private stopManagedProcess(): void {
    const processRef = this.managedProcess;
    this.managedProcess = null;
    this.managedBackend = '';
    if (!processRef || processRef.exitCode !== null || processRef.killed) {
      return;
    }

    processRef.kill('SIGTERM');
    setTimeout(() => {
      if (processRef.exitCode === null && !processRef.killed) {
        processRef.kill('SIGKILL');
      }
    }, VNC_STOP_GRACE_MS);
  }

  private async ensureAvailableInternal(): Promise<VncStatus> {
    if (await canConnect(this.endpoint)) {
      const managed = isAlive(this.managedProcess);
      const backend = managed ? this.managedBackend || 'managed' : 'external';
      this.lastMessage = managed ? `vnc ready via ${backend}` : 'vnc endpoint reachable';
      return this.toStatus({
        available: true,
        managed,
        backend,
        message: this.lastMessage
      });
    }

    if (this.managedProcess && !isAlive(this.managedProcess)) {
      this.managedProcess = null;
      this.managedBackend = '';
    }

    if (!this.autoStart) {
      this.lastMessage = 'vnc unavailable and autostart disabled';
      return this.toStatus({
        available: false,
        managed: false,
        backend: 'none',
        message: this.lastMessage
      });
    }

    const candidates = this.buildCandidates();
    if (candidates.length === 0) {
      this.lastMessage = 'no vnc backend candidate found';
      return this.toStatus({
        available: false,
        managed: false,
        backend: 'none',
        message: this.lastMessage
      });
    }

    const attemptErrors: string[] = [];
    for (const candidate of candidates) {
      const exists = await commandExists(candidate.command);
      if (!exists) {
        attemptErrors.push(`${candidate.backend}: command not found`);
        continue;
      }

      const processRef = spawn(candidate.command, candidate.args, {
        stdio: 'ignore'
      });
      this.managedProcess = processRef;
      this.managedBackend = candidate.backend;

      processRef.once('exit', () => {
        if (this.managedProcess === processRef) {
          this.managedProcess = null;
          this.managedBackend = '';
        }
      });

      const ready = await waitForEndpoint(this.endpoint, VNC_START_TIMEOUT_MS);
      if (ready) {
        this.lastMessage = `vnc ready via ${candidate.backend}`;
        return this.toStatus({
          available: true,
          managed: true,
          backend: candidate.backend,
          message: this.lastMessage
        });
      }

      attemptErrors.push(`${candidate.backend}: startup timeout`);
      this.stopManagedProcess();
    }

    this.lastMessage =
      attemptErrors.length > 0 ? `failed to start vnc (${attemptErrors.join('; ')})` : 'failed to start vnc';
    return this.toStatus({
      available: false,
      managed: false,
      backend: 'none',
      message: this.lastMessage
    });
  }
}
