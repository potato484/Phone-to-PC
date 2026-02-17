import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
    await sleep(120);
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

async function countInvalidBootstrapAudit(auditDir) {
  const files = await readdir(auditDir).catch(() => []);
  const targets = files.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  let count = 0;
  for (const file of targets) {
    const text = await readFile(path.join(auditDir, file), 'utf8').catch(() => '');
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      let payload = null;
      try {
        payload = JSON.parse(line);
      } catch {
        payload = null;
      }
      if (!payload) {
        continue;
      }
      if (
        payload.event === 'auth.failed' &&
        payload.resource === 'bootstrap' &&
        payload.metadata &&
        payload.metadata.reason === 'invalid bootstrap token'
      ) {
        count += 1;
      }
    }
  }
  return count;
}

test('auth exchange locks after repeated invalid bootstrap token attempts', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-auth-limit-it-'));
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
    const validBootstrapToken = await readBootstrapToken(runtimeDir);

    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${baseUrl}/api/auth/exchange`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer invalid-token-${i}`
        }
      });
      assert.equal(response.status, 401, `attempt ${i + 1} should be unauthorized`);
    }

    const lockedResponse = await fetch(`${baseUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid-token-locked'
      }
    });
    assert.equal(lockedResponse.status, 429, '7th invalid attempt should be locked');

    const lockedPayload = await lockedResponse.json();
    assert.equal(lockedPayload.error, 'too many auth failures');
    assert.equal(Number.isFinite(lockedPayload.retryAfterSec), true);
    assert.ok(Number(lockedPayload.retryAfterSec) >= 1);

    const retryAfterHeader = lockedResponse.headers.get('retry-after');
    assert.equal(typeof retryAfterHeader, 'string');
    assert.ok(Number.parseInt(retryAfterHeader || '0', 10) >= 1);

    const blockedValidResponse = await fetch(`${baseUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validBootstrapToken}`
      }
    });
    assert.equal(blockedValidResponse.status, 429, 'lock should also block valid token during lock window');

    const auditDir = path.join(runtimeDir, '.c2p-audit');
    let auditCount = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4_000) {
      auditCount = await countInvalidBootstrapAudit(auditDir);
      if (auditCount >= 5) {
        break;
      }
      await sleep(120);
    }
    assert.ok(auditCount >= 6, `expected >=6 invalid bootstrap audit events, got ${auditCount}`);
  } finally {
    await stopServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
