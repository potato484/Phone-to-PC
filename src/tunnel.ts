import { execFile } from 'node:child_process';
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

export type TunnelMode = 'tailscale';
const TAILSCALE_INSTALL_DOC = 'https://tailscale.com/download';
const execFileAsync = promisify(execFile);

export function isEnabledEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function resolveTunnelMode(): TunnelMode {
  const raw = (process.env.TUNNEL ?? 'tailscale').trim().toLowerCase();
  if (raw === '' || raw === 'tailscale') {
    return 'tailscale';
  }
  throw new Error(`[c2p] tunnel: unsupported TUNNEL=${raw}, only tailscale is supported`);
}

function appendToken(baseUrl: string, tokenValue: string): string {
  const url = new URL(baseUrl);
  url.hash = `token=${tokenValue}`;
  return url.toString();
}

function resolveTailscaleBin(): string {
  const raw = (process.env.C2P_TAILSCALE_BIN ?? '').trim();
  if (!raw) {
    return 'tailscale';
  }
  return raw;
}

async function readTailscaleStatus(tailscaleBin: string): Promise<TailscaleStatus> {
  try {
    const { stdout } = await execFileAsync(tailscaleBin, ['status', '--json']);
    const output = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
    return JSON.parse(output) as TailscaleStatus;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`[c2p] tunnel: tailscale not found (${tailscaleBin}), install: ${TAILSCALE_INSTALL_DOC}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error('[c2p] tunnel: failed to parse tailscale status --json output');
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[c2p] tunnel: tailscale status failed (${message})`);
  }
}

export async function startTunnel(port: number, tokenValue: string): Promise<string> {
  resolveTunnelMode();
  const tailscaleBin = resolveTailscaleBin();
  const status = await readTailscaleStatus(tailscaleBin);
  const self = status.Self;
  const rawDnsName = typeof self?.DNSName === 'string' ? self.DNSName.trim() : '';
  const dnsName = rawDnsName.endsWith('.') ? rawDnsName.slice(0, -1) : rawDnsName;
  if (!dnsName) {
    throw new Error('[c2p] tunnel: tailscale DNS name unavailable');
  }
  if (self?.Online !== true) {
    throw new Error('[c2p] tunnel: tailscale node is offline');
  }

  const tailscaleIp = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.find((ip) => /^100\./.test(ip.trim()))
    : undefined;
  if (tailscaleIp) {
    console.log(`[c2p] tailscale ip: ${tailscaleIp}`);
  }

  const tunnelCommand = isEnabledEnvFlag(process.env.TAILSCALE_FUNNEL) ? 'funnel' : 'serve';
  try {
    await execFileAsync(tailscaleBin, [tunnelCommand, '--bg', '--https=443', `http://localhost:${port}`]);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`[c2p] tunnel: tailscale not found (${tailscaleBin}), install: ${TAILSCALE_INSTALL_DOC}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[c2p] tunnel: tailscale ${tunnelCommand} failed (${message})`);
  }

  return appendToken(`https://${dnsName}`, tokenValue);
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
