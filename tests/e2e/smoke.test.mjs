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

function createJsonWaiter(ws) {
  return function waitForJson(predicate, timeoutMs = 5000) {
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

async function openWebSocket(url) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
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
      Authorization: `Bearer ${bootstrapToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ scope: 'admin' })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(typeof payload.accessToken, 'string');
  return payload.accessToken;
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

test('e2e smoke: auth -> session -> ws -> fs', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-e2e-'));
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

    const runtimeRes = await fetch(`${baseUrl}/api/runtime`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    assert.equal(runtimeRes.status, 200, 'runtime API should be accessible');

    const controlWs = await openWebSocket(`ws://127.0.0.1:${port}/ws/control`);
    const waitControlJson = createJsonWaiter(controlWs);

    controlWs.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'e2e-smoke-test',
          version: 1
        }
      })
    );

    await waitControlJson((payload) => payload.type === 'auth.ok');
    await waitControlJson((payload) => payload.type === 'sessions' && Array.isArray(payload.list));

    controlWs.send(
      JSON.stringify({
        type: 'spawn',
        cli: 'shell',
        cols: 120,
        rows: 36
      })
    );

    const spawned = await waitControlJson((payload) => payload.type === 'spawned' && typeof payload.sessionId === 'string');
    const sessionId = spawned.sessionId;

    const terminalWs = await openWebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?session=${encodeURIComponent(sessionId)}&cols=120&rows=36`
    );
    const waitTerminalJson = createJsonWaiter(terminalWs);

    terminalWs.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'e2e-smoke-test',
          version: 1
        }
      })
    );

    await waitTerminalJson((payload) => payload.type === 'auth.ok');

    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('terminal echo timeout'));
      }, 5_000);

      const cleanup = () => {
        clearTimeout(timer);
        terminalWs.off('message', onMessage);
      };

      const onMessage = (raw) => {
        const text = rawDataToText(raw);
        if (text.includes('e2e-smoke-ok')) {
          cleanup();
          resolve(text);
        }
      };

      terminalWs.on('message', onMessage);
      terminalWs.send('echo e2e-smoke-ok\\n');
    });
    assert.equal(typeof echoed, 'string');

    const filePath = 'e2e-smoke.txt';

    const writeRes = await fetch(`${baseUrl}/api/fs/write`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: filePath,
        content: 'hello-from-e2e'
      })
    });
    assert.equal(writeRes.status, 201, 'fs write should succeed');

    const readRes = await fetch(`${baseUrl}/api/fs/read?path=${encodeURIComponent(filePath)}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    assert.equal(readRes.status, 200, 'fs read should succeed');
    const readPayload = await readRes.json();
    assert.equal(readPayload.content, 'hello-from-e2e');

    const downloadRes = await fetch(`${baseUrl}/api/fs/download?path=${encodeURIComponent(filePath)}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    assert.equal(downloadRes.status, 200, 'fs download should succeed');
    const downloaded = await downloadRes.text();
    assert.equal(downloaded, 'hello-from-e2e');

    controlWs.send(
      JSON.stringify({
        type: 'kill',
        sessionId
      })
    );
    await waitControlJson((payload) => payload.type === 'exited' && payload.sessionId === sessionId);

    terminalWs.close();
    await once(terminalWs, 'close');
    controlWs.close();
    await once(controlWs, 'close');
  } finally {
    await stopServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
