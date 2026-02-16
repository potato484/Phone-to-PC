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
        reject(new Error('timeout waiting for websocket message'));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('websocket closed before expected message'));
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

async function waitForHealth(baseUrl, child, timeoutMs = 15000) {
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
    await sleep(120);
  }
  throw new Error('server health check timed out');
}

async function readBootstrapToken(runtimeDir) {
  const tokenPath = path.join(runtimeDir, '.auth-token');
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    try {
      const raw = await readFile(tokenPath, 'utf8');
      const token = raw.trim();
      if (token.length > 0) {
        return token;
      }
    } catch {
      // retry
    }
    await sleep(80);
  }
  throw new Error('bootstrap token not created in time');
}

async function exchangeAccessToken(baseUrl, bootstrapToken) {
  const response = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bootstrapToken}`
    }
  });
  assert.equal(response.status, 200, 'exchange should succeed');
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
    sleep(5000).then(() => {
      child.kill('SIGKILL');
    })
  ]);
}

async function startServer({ runtimeDir, stateFile, port }) {
  const child = spawn(process.execPath, [serverEntry, '--cwd', runtimeDir], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      PORT: String(port),
      TUNNEL: 'off',
      C2P_TMUX_BIN: fakeTmuxPath,
      FAKE_TMUX_STATE_FILE: stateFile,
      C2P_ALLOW_EMPTY_ORIGIN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  return {
    child,
    baseUrl,
    getLogs() {
      return logs;
    }
  };
}

test('tmux sessions survive restart and terminal reconnect stays under 2s', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-it-'));
  const fakeStatePath = path.join(runtimeDir, 'fake-tmux-state.json');

  let currentServer = null;
  try {
    const port = await getFreePort();
    currentServer = await startServer({
      runtimeDir,
      stateFile: fakeStatePath,
      port
    });

    const bootstrapToken = await readBootstrapToken(runtimeDir);
    const accessToken = await exchangeAccessToken(currentServer.baseUrl, bootstrapToken);

    const controlWs = await openWebSocket(`ws://127.0.0.1:${port}/ws/control`);
    const waitControlJson = createJsonWaiter(controlWs);

    controlWs.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'node-test',
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

    const terminalUrl = `ws://127.0.0.1:${port}/ws/terminal?session=${encodeURIComponent(sessionId)}&cols=120&rows=36`;

    const terminalA = await openWebSocket(terminalUrl);
    const waitTerminalAJson = createJsonWaiter(terminalA);

    terminalA.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'node-test',
          version: 1
        }
      })
    );

    await waitTerminalAJson((payload) => payload.type === 'auth.ok');

    const echoedA = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('terminal echo timeout')); 
      }, 4000);

      const cleanup = () => {
        clearTimeout(timer);
        terminalA.off('message', onMessage);
      };

      const onMessage = (raw) => {
        const text = rawDataToText(raw);
        if (text.includes('ping-from-test')) {
          cleanup();
          resolve(text);
        }
      };

      terminalA.on('message', onMessage);
      terminalA.send('ping-from-test\n');
    });

    assert.equal(typeof echoedA, 'string');
    terminalA.close();
    await once(terminalA, 'close');

    const reconnectStartedAt = performance.now();
    const terminalB = await openWebSocket(terminalUrl);
    const waitTerminalBJson = createJsonWaiter(terminalB);

    terminalB.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'node-test',
          version: 1
        }
      })
    );

    await waitTerminalBJson((payload) => payload.type === 'auth.ok');
    const reconnectLatencyMs = performance.now() - reconnectStartedAt;
    assert.ok(reconnectLatencyMs < 2000, `reconnect latency=${reconnectLatencyMs.toFixed(2)}ms should be < 2000ms`);

    terminalB.close();
    await once(terminalB, 'close');
    controlWs.close();
    await once(controlWs, 'close');

    await stopServer(currentServer.child);

    currentServer = await startServer({
      runtimeDir,
      stateFile: fakeStatePath,
      port
    });

    const refreshedBootstrap = await readBootstrapToken(runtimeDir);
    const refreshedAccessToken = await exchangeAccessToken(currentServer.baseUrl, refreshedBootstrap);

    const controlWsAfterRestart = await openWebSocket(`ws://127.0.0.1:${port}/ws/control`);
    const waitControlRestartJson = createJsonWaiter(controlWsAfterRestart);

    controlWsAfterRestart.send(
      JSON.stringify({
        type: 'auth',
        token: refreshedAccessToken,
        client: {
          ua: 'node-test',
          version: 1
        }
      })
    );

    await waitControlRestartJson((payload) => payload.type === 'auth.ok');
    const sessionsPayload = await waitControlRestartJson(
      (payload) => payload.type === 'sessions' && Array.isArray(payload.list),
      6000
    );

    const restored = sessionsPayload.list.some((entry) => entry && typeof entry.id === 'string' && entry.id === sessionId);
    assert.equal(restored, true, `session ${sessionId} should be restored after restart`);

    controlWsAfterRestart.close();
    await once(controlWsAfterRestart, 'close');
  } finally {
    if (currentServer) {
      await stopServer(currentServer.child);
    }
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
