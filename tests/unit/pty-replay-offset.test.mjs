import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveReplayOffsetForLogFile } from '../../dist/pty-manager.js';

test('resolveReplayOffsetForLogFile aligns to next newline when replay starts mid-line', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-replay-offset-'));
  const logPath = path.join(runtimeDir, 'session.log');
  const content = 'line-1\nline-2\nline-3\n';

  try {
    await writeFile(logPath, content, 'utf8');
    const logBytes = Buffer.byteLength(content, 'utf8');
    const tailBytes = 10;
    const replayStart = Math.max(0, logBytes - tailBytes);
    const remaining = Buffer.from(content, 'utf8').subarray(replayStart);
    const newlineIndex = remaining.indexOf(0x0a);
    assert.equal(newlineIndex >= 0, true);

    const replay = resolveReplayOffsetForLogFile(logPath, logBytes, tailBytes);
    assert.equal(replay.aligned, true);
    assert.equal(replay.replayFrom, replayStart + newlineIndex + 1);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('resolveReplayOffsetForLogFile keeps raw tail start when newline is not found', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-replay-offset-'));
  const logPath = path.join(runtimeDir, 'session.log');
  const content = 'abcdefghijklmnop';

  try {
    await writeFile(logPath, content, 'utf8');
    const logBytes = Buffer.byteLength(content, 'utf8');
    const tailBytes = 5;
    const replayStart = Math.max(0, logBytes - tailBytes);

    const replay = resolveReplayOffsetForLogFile(logPath, logBytes, tailBytes);
    assert.equal(replay.aligned, false);
    assert.equal(replay.replayFrom, replayStart);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('resolveReplayOffsetForLogFile returns zero when tail is larger than log', async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-replay-offset-'));
  const logPath = path.join(runtimeDir, 'session.log');

  try {
    await writeFile(logPath, 'short\n', 'utf8');
    const content = await readFile(logPath, 'utf8');
    const replay = resolveReplayOffsetForLogFile(logPath, Buffer.byteLength(content, 'utf8'), 64 * 1024);
    assert.equal(replay.replayFrom, 0);
    assert.equal(replay.aligned, true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
