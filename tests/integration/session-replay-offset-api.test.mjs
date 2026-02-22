import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverEntry = path.join(repoRoot, 'dist', 'server.js');
const fakeTmuxPath = path.join(repoRoot, 'tests', 'helpers', 'fake-tmux.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      Authorization: `Bearer ${bootstrapToken}`
    }
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

test('replay-offset API aligns tail replay start to next newline when possible', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-replay-offset-it-'));
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

    const logsDir = path.join(runtimeDir, '.c2p-sessions');
    await mkdir(logsDir, { recursive: true });

    const alignedSessionId = 'replay-offset-aligned';
    const alignedContent = 'line-1\nline-2\nline-3\nline-4';
    const alignedLogPath = path.join(logsDir, `${alignedSessionId}.log`);
    await writeFile(alignedLogPath, alignedContent, 'utf8');
    const alignedLogBytes = Buffer.byteLength(alignedContent, 'utf8');
    const alignedTailBytes = 12;
    const replayStart = Math.max(0, alignedLogBytes - alignedTailBytes);
    const newlineIndex = Buffer.from(alignedContent, 'utf8').subarray(replayStart).indexOf(0x0a);
    assert.equal(newlineIndex >= 0, true);

    const alignedResponse = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(alignedSessionId)}/replay-offset?tailBytes=${alignedTailBytes}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );
    assert.equal(alignedResponse.status, 200);
    const alignedPayload = await alignedResponse.json();
    assert.equal(alignedPayload.logBytes, alignedLogBytes);
    assert.equal(alignedPayload.aligned, true);
    assert.equal(alignedPayload.replayFrom, replayStart + newlineIndex + 1);

    const rawSessionId = 'replay-offset-raw';
    const rawContent = 'abcdefghijklmnopqrstuvwxyz';
    const rawLogPath = path.join(logsDir, `${rawSessionId}.log`);
    await writeFile(rawLogPath, rawContent, 'utf8');
    const rawLogBytes = Buffer.byteLength(rawContent, 'utf8');
    const rawTailBytes = 5;
    const rawReplayStart = Math.max(0, rawLogBytes - rawTailBytes);

    const rawResponse = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(rawSessionId)}/replay-offset?tailBytes=${rawTailBytes}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );
    assert.equal(rawResponse.status, 200);
    const rawPayload = await rawResponse.json();
    assert.equal(rawPayload.logBytes, rawLogBytes);
    assert.equal(rawPayload.aligned, false);
    assert.equal(rawPayload.replayFrom, rawReplayStart);

    const missingResponse = await fetch(`${baseUrl}/api/sessions/replay-offset-missing/replay-offset`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    assert.equal(missingResponse.status, 404);
  } finally {
    await stopServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
