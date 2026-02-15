import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import qrcode from 'qrcode-terminal';
import { createAuthMiddleware, ensureAuthToken, validateUpgradeToken } from './auth.js';
import { PtyManager } from './pty-manager.js';
import { PushService } from './push.js';
import { registerApiRoutes } from './routes/api.js';
import { C2PStore } from './store.js';
import { getLanAddress, isEnabledEnvFlag, resolveTunnelMode, startTunnel } from './tunnel.js';
import { createControlChannel } from './ws/control.js';
import type { WsChannel } from './ws/channel.js';
import { createTerminalChannel } from './ws/terminal.js';

interface ServerCliOptions {
  cwd?: string;
}

function parseServerCliOptions(args: string[]): ServerCliOptions {
  const options: ServerCliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cwd') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        console.log('[c2p] cli: missing value for --cwd');
        continue;
      }
      options.cwd = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      options.cwd = arg.slice('--cwd='.length);
    }
  }
  return options;
}

function resolveDefaultWorkingDirectory(rawCwd: string | undefined): string {
  if (!rawCwd || rawCwd.trim().length === 0) {
    return process.cwd();
  }
  const candidate = path.resolve(rawCwd.trim());
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // fall through to default
  }
  console.log(`[c2p] cli: invalid --cwd=${rawCwd}, fallback to ${process.cwd()}`);
  return process.cwd();
}

const cliOptions = parseServerCliOptions(process.argv.slice(2));
const defaultWorkingDirectory = resolveDefaultWorkingDirectory(cliOptions.cwd);
const port = Number(process.env.PORT ?? 3000);
const store = new C2PStore();
const token = ensureAuthToken();
const authMiddleware = createAuthMiddleware(token);
const ptyManager = new PtyManager(defaultWorkingDirectory);
const pushService = new PushService(store);

pushService.init({
  subject: process.env.VAPID_SUBJECT,
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
});

const app = express();
const publicDir = path.resolve(process.cwd(), 'public');

app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api', authMiddleware);
registerApiRoutes(app, {
  store,
  ptyManager,
  pushService,
  defaultWorkingDirectory
});

const server = http.createServer(app);
const channels: WsChannel[] = [
  createControlChannel({ ptyManager, store, pushService }),
  createTerminalChannel({ ptyManager })
];
const channelMap = new Map(channels.map((channel) => [channel.pathname, channel]));

server.on('upgrade', (request, socket, head) => {
  if (!validateUpgradeToken(request, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const host = request.headers.host ?? 'localhost';
  const parsed = new URL(request.url ?? '/', `http://${host}`);
  const channel = channelMap.get(parsed.pathname);
  if (!channel) {
    socket.destroy();
    return;
  }

  channel.handleUpgrade(request, socket, head);
});

server.listen(port, async () => {
  const localUrl = `http://localhost:${port}/#token=${token}`;
  const lan = getLanAddress();

  console.log(`[c2p] listening on ${port}`);
  console.log(`[c2p] default cwd: ${defaultWorkingDirectory}`);
  console.log(`[c2p] local: ${localUrl}`);
  if (lan) {
    console.log(`[c2p] lan: http://${lan}:${port}/#token=${token}`);
  }

  const tunnelUrl = await startTunnel(port, token);
  if (tunnelUrl) {
    if (resolveTunnelMode() === 'tailscale') {
      const tunnelCommand = isEnabledEnvFlag(process.env.TAILSCALE_FUNNEL) ? 'funnel' : 'serve';
      console.log(`[c2p] tunnel: tailscale ${tunnelCommand} -> ${tunnelUrl}`);
    } else {
      console.log(`[c2p] tunnel: ${tunnelUrl}`);
    }
    console.log('[c2p] scan to connect:');
    qrcode.generate(tunnelUrl, { small: true });
    void pushService.notify('C2P 已启动', '点击连接', {
      type: 'url-update',
      url: tunnelUrl
    });
  }
});
