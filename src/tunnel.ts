import { execFile, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

interface TailscaleStatusSelf {
  DNSName?: string;
  Online?: boolean;
  TailscaleIPs?: string[];
}

interface TailscaleStatus {
  Self?: TailscaleStatusSelf;
}

export type TunnelMode = 'auto' | 'cloudflare' | 'tailscale' | 'off';

const TUNNEL_INSTALL_DOC =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
const TAILSCALE_INSTALL_DOC = 'https://tailscale.com/download';
const TUNNEL_URL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;
const TUNNEL_START_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export function isEnabledEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function resolveTunnelMode(): TunnelMode {
  const raw = (process.env.TUNNEL ?? 'auto').trim().toLowerCase();
  if (raw === '' || raw === 'auto') {
    return 'auto';
  }
  if (raw === 'cloudflare') {
    return 'cloudflare';
  }
  if (raw === 'tailscale') {
    return 'tailscale';
  }
  if (raw === 'off') {
    return 'off';
  }
  console.log(`[c2p] tunnel: unsupported TUNNEL=${raw}, fallback to auto`);
  return 'auto';
}

function appendToken(baseUrl: string, tokenValue: string): string {
  const url = new URL(baseUrl);
  url.hash = `token=${tokenValue}`;
  return url.toString();
}

function registerTunnelCleanup(child: ChildProcess): void {
  const cleanup = (): void => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  };

  const onSigint = (): void => {
    cleanup();
    process.exit(0);
  };
  const onSigterm = (): void => {
    cleanup();
    process.exit(0);
  };

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', cleanup);
  child.once('exit', () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('exit', cleanup);
  });
}

async function readTailscaleStatus(): Promise<TailscaleStatus | null> {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json']);
    const output = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
    return JSON.parse(output) as TailscaleStatus;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log('[c2p] tunnel: tailscale not found, LAN-only mode');
      console.log(`[c2p] install: ${TAILSCALE_INSTALL_DOC}`);
    } else if (error instanceof SyntaxError) {
      console.log('[c2p] tunnel: failed to parse tailscale status, LAN-only mode');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[c2p] tunnel: tailscale status failed (${message})`);
    }
    return null;
  }
}

async function startTailscaleTunnel(port: number, tokenValue: string): Promise<string | null> {
  const status = await readTailscaleStatus();
  if (!status) {
    return null;
  }

  const self = status.Self;
  const rawDnsName = typeof self?.DNSName === 'string' ? self.DNSName.trim() : '';
  const dnsName = rawDnsName.endsWith('.') ? rawDnsName.slice(0, -1) : rawDnsName;
  if (!dnsName) {
    console.log('[c2p] tunnel: tailscale DNS name unavailable, LAN-only mode');
    return null;
  }
  if (self?.Online !== true) {
    console.log('[c2p] tunnel: tailscale node is offline, LAN-only mode');
    return null;
  }

  const tailscaleIp = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.find((ip) => /^100\./.test(ip.trim()))
    : undefined;
  if (tailscaleIp) {
    console.log(`[c2p] tailscale ip: ${tailscaleIp}`);
  }

  const tunnelCommand = isEnabledEnvFlag(process.env.TAILSCALE_FUNNEL) ? 'funnel' : 'serve';
  try {
    await execFileAsync('tailscale', [tunnelCommand, '--bg', '--https=443', `http://localhost:${port}`]);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log('[c2p] tunnel: tailscale not found, LAN-only mode');
      console.log(`[c2p] install: ${TAILSCALE_INSTALL_DOC}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[c2p] tunnel: tailscale ${tunnelCommand} failed (${message})`);
    }
    return null;
  }

  return appendToken(`https://${dnsName}`, tokenValue);
}

export async function startTunnel(port: number, tokenValue: string): Promise<string | null> {
  const mode = resolveTunnelMode();
  if (mode === 'off') {
    return null;
  }
  if (mode === 'tailscale') {
    return startTailscaleTunnel(port, tokenValue);
  }

  const tunnelHostname = process.env.TUNNEL_HOSTNAME?.trim();
  if (tunnelHostname) {
    const child = spawn('cloudflared', ['tunnel', 'run'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let logBuffer = '';

    const ready = await new Promise<boolean>((resolve) => {
      let done = false;

      const settle = (value: boolean): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        resolve(value);
      };

      const onData = (chunk: Buffer): void => {
        logBuffer += chunk.toString('utf8');
        if (/Registered tunnel connection/i.test(logBuffer)) {
          settle(true);
          return;
        }
        if (logBuffer.length > 8_192) {
          logBuffer = logBuffer.slice(-2_048);
        }
      };

      const onError = (error: Error): void => {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          console.log('[c2p] tunnel: cloudflared not found, LAN-only mode');
          console.log(`[c2p] install: ${TUNNEL_INSTALL_DOC}`);
        } else {
          console.log(`[c2p] tunnel: failed to start named tunnel (${error.message})`);
        }
        settle(false);
      };

      const onExit = (): void => {
        settle(false);
      };

      const timer = setTimeout(() => {
        console.log('[c2p] tunnel: timeout waiting for named tunnel readiness');
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
        }
        settle(false);
      }, TUNNEL_START_TIMEOUT_MS);

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });

    if (!ready) {
      return null;
    }

    registerTunnelCleanup(child);
    return appendToken(`https://${tunnelHostname}`, tokenValue);
  }

  const child = spawn(
    'cloudflared',
    ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let logBuffer = '';

  const publicUrl = await new Promise<string | null>((resolve) => {
    let done = false;

    const settle = (value: string | null): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(value);
    };

    const tryMatchUrl = (chunk: Buffer): void => {
      logBuffer += chunk.toString('utf8');
      const match = logBuffer.match(TUNNEL_URL_RE);
      if (match) {
        settle(match[0]);
        return;
      }
      if (logBuffer.length > 8_192) {
        logBuffer = logBuffer.slice(-2_048);
      }
    };

    const onData = (chunk: Buffer): void => {
      tryMatchUrl(chunk);
    };

    const onError = (error: Error): void => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        console.log('[c2p] tunnel: cloudflared not found, LAN-only mode');
        console.log(`[c2p] install: ${TUNNEL_INSTALL_DOC}`);
      } else {
        console.log(`[c2p] tunnel: failed to start cloudflared (${error.message})`);
      }
      settle(null);
    };

    const onExit = (): void => {
      settle(null);
    };

    const timer = setTimeout(() => {
      console.log('[c2p] tunnel: timeout waiting for trycloudflare URL');
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      settle(null);
    }, TUNNEL_START_TIMEOUT_MS);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  if (!publicUrl) {
    return null;
  }
  registerTunnelCleanup(child);

  return appendToken(publicUrl, tokenValue);
}

export function getLanAddress(): string | undefined {
  const nets = os.networkInterfaces();
  for (const net of Object.values(nets)) {
    if (!net) {
      continue;
    }
    for (const info of net) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return undefined;
}
