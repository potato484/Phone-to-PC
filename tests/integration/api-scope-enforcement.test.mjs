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

async function findLatestAuditFile(auditDir) {
  const files = await readdir(auditDir).catch(() => []);
  const target = files.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().pop();
  if (!target) {
    return '';
  }
  return path.join(auditDir, target);
}

test('readonly scope cannot call write APIs and emits denied-scope audit', async (t) => {
  if (!(await canListenLoopback())) {
    t.skip('loopback listen is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-scope-it-'));
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

    const authHeaders = {
      Authorization: `Bearer ${readonlyIssued.accessToken}`,
      'Content-Type': 'application/json'
    };

    const listResponse = await fetch(`${baseUrl}/api/fs/list?path=.`, {
      headers: {
        Authorization: `Bearer ${readonlyIssued.accessToken}`
      }
    });
    assert.equal(listResponse.status, 200, 'readonly should keep read access');

    const blocked = [
      {
        method: 'POST',
        url: `${baseUrl}/api/fs/write`,
        body: JSON.stringify({ path: 'readonly-test.txt', content: 'hello' }),
        headers: authHeaders
      },
      {
        method: 'POST',
        url: `${baseUrl}/api/fs/mkdir`,
        body: JSON.stringify({ path: 'readonly-dir', recursive: true }),
        headers: authHeaders
      },
      {
        method: 'POST',
        url: `${baseUrl}/api/fs/rename`,
        body: JSON.stringify({ path: 'a', to: 'b' }),
        headers: authHeaders
      },
      {
        method: 'POST',
        url: `${baseUrl}/api/fs/remove`,
        body: JSON.stringify({ path: 'a', recursive: true }),
        headers: authHeaders
      },
      {
        method: 'POST',
        url: `${baseUrl}/api/fs/upload?path=readonly-upload.bin`,
        body: 'payload',
        headers: {
          Authorization: `Bearer ${readonlyIssued.accessToken}`,
          'Content-Type': 'application/octet-stream'
        }
      },
      {
        method: 'POST',
        url: `${baseUrl}/api/telemetry/events`,
        body: JSON.stringify({
          deviceId: 'readonly-device',
          events: [{ name: 'session_quality_pass', happenedAt: new Date().toISOString(), payload: {} }]
        }),
        headers: authHeaders
      }
    ];

    for (const request of blocked) {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      assert.equal(response.status, 403, `${request.url} should be forbidden for readonly`);
      const payload = await response.json();
      assert.equal(payload.reason, 'insufficient_scope');
      assert.equal(payload.requiredScope, 'admin');
      assert.equal(payload.actualScope, 'readonly');
    }

    const summaryResponse = await fetch(`${baseUrl}/api/telemetry/summary`, {
      headers: {
        Authorization: `Bearer ${readonlyIssued.accessToken}`
      }
    });
    assert.equal(summaryResponse.status, 200, 'readonly should read telemetry summary');

    const revokeResponse = await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readonlyIssued.accessToken}`
      }
    });
    assert.equal(revokeResponse.status, 200, 'readonly should revoke itself');

    const auditDir = path.join(runtimeDir, '.c2p-audit');
    let deniedFound = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4_000) {
      const auditFile = await findLatestAuditFile(auditDir);
      if (!auditFile) {
        await sleep(120);
        continue;
      }
      const text = await readFile(auditFile, 'utf8').catch(() => '');
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
        if (!payload || payload.event !== 'auth.denied_scope') {
          continue;
        }
        if (payload.metadata?.requiredScope === 'admin' && payload.metadata?.actualScope === 'readonly') {
          deniedFound = true;
          break;
        }
      }
      if (deniedFound) {
        break;
      }
      await sleep(120);
    }

    assert.equal(deniedFound, true, 'denied scope audit event should be emitted');
  } finally {
    await stopServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
