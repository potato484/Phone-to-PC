import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverEntry = path.join(repoRoot, 'dist', 'server.js');
const fakeTmuxPath = path.join(repoRoot, 'tests', 'helpers', 'fake-tmux.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawDataToText(raw) {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }
  return Buffer.concat(raw.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item)))).toString('utf8');
}

async function canListenLoopback() {
  try {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code=${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(100);
  }
  throw new Error('health check timeout');
}

async function readBootstrapToken(runtimeDir) {
  const tokenPath = path.join(runtimeDir, '.auth-token');
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    try {
      const raw = await readFile(tokenPath, 'utf8');
      const token = raw.trim();
      if (token) {
        return token;
      }
    } catch {
      // retry
    }
    await sleep(80);
  }
  throw new Error('bootstrap token not ready');
}

async function exchangeAccessToken(baseUrl, bootstrapToken) {
  const response = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bootstrapToken}`
    }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(typeof payload.accessToken, 'string');
  return payload.accessToken;
}

async function openWebSocket(url) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function createJsonWaiter(ws) {
  return function waitForJson(predicate, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timeout waiting websocket json'));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('websocket closed unexpectedly'));
      };

      const onMessage = (raw) => {
        let payload = null;
        try {
          payload = JSON.parse(rawDataToText(raw));
        } catch {
          payload = null;
        }
        if (!payload) {
          return;
        }
        if (predicate(payload)) {
          cleanup();
          resolve(payload);
        }
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
    });
  };
}

async function stopServer(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    sleep(5_000).then(() => {
      child.kill('SIGKILL');
    })
  ]);
}

test('control channel responds heartbeat pong after auth', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-heartbeat-it-'));
  const fakeStatePath = path.join(runtimeDir, 'fake-tmux-state.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, [serverEntry, '--cwd', runtimeDir], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      PORT: String(port),
      TUNNEL: 'off',
      C2P_TMUX_BIN: fakeTmuxPath,
      FAKE_TMUX_STATE_FILE: fakeStatePath,
      C2P_ALLOW_EMPTY_ORIGIN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForHealth(baseUrl, server);
    const bootstrapToken = await readBootstrapToken(runtimeDir);
    const accessToken = await exchangeAccessToken(baseUrl, bootstrapToken);

    const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws/control`);
    const waitForJson = createJsonWaiter(ws);

    ws.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'node-integration-test',
          version: 1
        }
      })
    );

    await waitForJson((payload) => payload.type === 'auth.ok');

    const sentAt = Date.now();
    ws.send(
      JSON.stringify({
        type: 'heartbeat.ping',
        seq: 42,
        sentAt
      })
    );

    const pong = await waitForJson((payload) => payload.type === 'heartbeat.pong');
    assert.equal(pong.seq, 42);
    assert.equal(pong.sentAt, sentAt);
    assert.equal(Number.isFinite(Number(pong.serverAt)), true);

    ws.close();
    await once(ws, 'close');
  } finally {
    await stopServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
