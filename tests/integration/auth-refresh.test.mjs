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

async function exchangeAccessToken(baseUrl, bootstrapToken, scope = 'admin') {
  const response = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bootstrapToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ scope })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(typeof payload.accessToken, 'string');
  return payload;
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

async function waitForAuditEvent(auditDir, eventName, matcher, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const files = await readdir(auditDir).catch(() => []);
    const targets = files.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
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
        if (!payload || payload.event !== eventName) {
          continue;
        }
        if (matcher(payload)) {
          return payload;
        }
      }
    }
    await sleep(120);
  }
  throw new Error(`audit event not found: ${eventName}`);
}

test('auth refresh rotates token, keeps scope, revokes previous token and emits audit', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-refresh-it-'));
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
    const readonlyIssued = await exchangeAccessToken(baseUrl, bootstrapToken, 'readonly');
    assert.equal(readonlyIssued.scope, 'readonly');

    const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readonlyIssued.accessToken}`
      }
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json();

    assert.equal(typeof refreshed.accessToken, 'string');
    assert.notEqual(refreshed.accessToken, readonlyIssued.accessToken);
    assert.equal(refreshed.scope, 'readonly');

    const oldTokenRuntime = await fetch(`${baseUrl}/api/runtime`, {
      headers: {
        Authorization: `Bearer ${readonlyIssued.accessToken}`
      }
    });
    assert.equal(oldTokenRuntime.status, 401, 'old token should be revoked after refresh');

    const oldPayload = await oldTokenRuntime.json();
    assert.equal(oldPayload.reason, 'revoked');

    const newTokenRuntime = await fetch(`${baseUrl}/api/runtime`, {
      headers: {
        Authorization: `Bearer ${refreshed.accessToken}`
      }
    });
    assert.equal(newTokenRuntime.status, 200, 'new token should remain valid');

    const auditDir = path.join(runtimeDir, '.c2p-audit');
    const refreshAudit = await waitForAuditEvent(
      auditDir,
      'auth.token_refreshed',
      (entry) => entry.metadata?.scope === 'readonly' && typeof entry.metadata?.previousJti === 'string'
    );
    assert.equal(refreshAudit.outcome, 'success');

    const revokeResponse = await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshed.accessToken}`
      }
    });
    assert.equal(revokeResponse.status, 200);
  } finally {
    await stopServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
