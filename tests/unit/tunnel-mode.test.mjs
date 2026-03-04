import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { resolveTunnelMode, startTunnel } from '../../dist/tunnel.js';

const fakeTailscalePath = path.resolve('tests/helpers/fake-tailscale.mjs');

async function withEnv(overrides, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('resolveTunnelMode only accepts tailscale', { concurrency: false }, async () => {
  await withEnv({ TUNNEL: 'tailscale' }, async () => {
    assert.equal(resolveTunnelMode(), 'tailscale');
  });
  await withEnv({ TUNNEL: '' }, async () => {
    assert.equal(resolveTunnelMode(), 'tailscale');
  });
});

test('resolveTunnelMode rejects legacy tunnel values', { concurrency: false }, async () => {
  await withEnv({ TUNNEL: 'off' }, async () => {
    assert.throws(() => resolveTunnelMode(), /only tailscale is supported/);
  });
  await withEnv({ TUNNEL: 'legacy' }, async () => {
    assert.throws(() => resolveTunnelMode(), /only tailscale is supported/);
  });
  await withEnv({ TUNNEL: 'auto' }, async () => {
    assert.throws(() => resolveTunnelMode(), /only tailscale is supported/);
  });
});

test('startTunnel returns tailscale URL with token', { concurrency: false }, async () => {
  await withEnv(
    {
      TUNNEL: 'tailscale',
      C2P_TAILSCALE_BIN: fakeTailscalePath,
      FAKE_TAILSCALE_MODE: 'online',
      TAILSCALE_FUNNEL: 'false'
    },
    async () => {
      const url = await startTunnel(3000, 'bootstrap-token');
      assert.equal(url, 'https://fake-node.tailnet.ts.net/#token=bootstrap-token');
    }
  );
});

test('startTunnel fails when tailscale node is offline', { concurrency: false }, async () => {
  await withEnv(
    {
      TUNNEL: 'tailscale',
      C2P_TAILSCALE_BIN: fakeTailscalePath,
      FAKE_TAILSCALE_MODE: 'offline'
    },
    async () => {
      await assert.rejects(startTunnel(3000, 'token'), /tailscale node is offline/);
    }
  );
});
