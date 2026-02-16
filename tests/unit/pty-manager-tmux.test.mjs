import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn as ptySpawn } from 'node-pty';
import { PtyManager } from '../../dist/pty-manager.js';

function onceData(attachment, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offData();
      reject(new Error('timeout waiting for attachment data'));
    }, timeoutMs);

    const offData = attachment.onData((chunk) => {
      clearTimeout(timer);
      offData();
      resolve(chunk.data);
    });
  });
}

function canForkPty() {
  try {
    const probe = ptySpawn('/bin/bash', ['-lc', 'exit 0'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env
    });
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

test('PtyManager uses tmux backend for spawn/attach/recover/kill', async (t) => {
  if (!canForkPty()) {
    t.skip('forkpty is blocked in current sandbox');
    return;
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-pty-'));
  const fakeTmuxPath = path.resolve('tests/helpers/fake-tmux.mjs');
  const fakeStatePath = path.join(runtimeDir, 'fake-tmux-state.json');

  const previousTmuxBin = process.env.C2P_TMUX_BIN;
  const previousFakeState = process.env.FAKE_TMUX_STATE_FILE;
  process.env.C2P_TMUX_BIN = fakeTmuxPath;
  process.env.FAKE_TMUX_STATE_FILE = fakeStatePath;

  const manager = new PtyManager(runtimeDir);
  let recoveredManager = null;

  try {
    assert.equal(manager.isReady(), true);
    const nestedDir = path.join(runtimeDir, 'nested-workspace');
    await mkdir(nestedDir, { recursive: true });

    const info = manager.spawn({
      id: 'session-test-1',
      cli: 'shell',
      cwd: 'nested-workspace',
      cols: 120,
      rows: 40
    });

    assert.equal(info.id, 'session-test-1');
    assert.equal(info.cwd, nestedDir);
    assert.equal(manager.hasSession('session-test-1'), true);

    const fallbackInfo = manager.spawn({
      id: 'session-test-2',
      cli: 'shell',
      cwd: 'missing-dir',
      cols: 100,
      rows: 30
    });
    assert.equal(fallbackInfo.cwd, runtimeDir);
    manager.kill('session-test-2');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const attachment = manager.attach('session-test-1', {
      cols: 120,
      rows: 40
    });

    const pendingData = onceData(attachment);
    attachment.write('hello-pty\n');
    const echoed = await pendingData;
    assert.equal(echoed.includes('hello-pty'), true);
    attachment.close();

    recoveredManager = new PtyManager(runtimeDir);
    const recovered = recoveredManager.recoverSessions([
      {
        id: 'session-test-1',
        cli: 'shell',
        cwd: nestedDir,
        cols: 120,
        rows: 40,
        startedAt: info.startedAt,
        updatedAt: info.startedAt,
        status: 'running'
      }
    ]);

    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0]?.id, 'session-test-1');

    let exitObserved = false;
    const offExit = recoveredManager.onExit((sessionId) => {
      if (sessionId === 'session-test-1') {
        exitObserved = true;
      }
    });

    recoveredManager.kill('session-test-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    offExit();

    assert.equal(exitObserved, true);
    assert.equal(recoveredManager.hasSession('session-test-1'), false);
  } finally {
    manager.dispose();
    if (recoveredManager) {
      recoveredManager.dispose();
    }

    if (previousTmuxBin === undefined) {
      delete process.env.C2P_TMUX_BIN;
    } else {
      process.env.C2P_TMUX_BIN = previousTmuxBin;
    }

    if (previousFakeState === undefined) {
      delete process.env.FAKE_TMUX_STATE_FILE;
    } else {
      process.env.FAKE_TMUX_STATE_FILE = previousFakeState;
    }

    await rm(runtimeDir, { recursive: true, force: true });
  }
});
