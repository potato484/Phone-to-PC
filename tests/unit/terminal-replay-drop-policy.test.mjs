import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReplayDropBarrier } from '../../public/lib/terminal-replay-drop-policy.js';

test('applyReplayDropBarrier keeps chunk untouched when barrier is inactive', () => {
  const result = applyReplayDropBarrier('prompt$ ', {
    logBytes: 8,
    currentOffset: 1024,
    dropUntilOffset: 0
  });

  assert.deepEqual(result, {
    text: 'prompt$ ',
    logBytes: 8,
    droppedLogBytes: 0,
    barrierReached: true
  });
});

test('applyReplayDropBarrier drops full chunk while barrier is still ahead', () => {
  const result = applyReplayDropBarrier('stale', {
    logBytes: 5,
    currentOffset: 100,
    dropUntilOffset: 108
  });

  assert.deepEqual(result, {
    text: '',
    logBytes: 0,
    droppedLogBytes: 5,
    barrierReached: false
  });
});

test('applyReplayDropBarrier drops prefix bytes and keeps trailing text on boundary chunk', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = 'oldprompt$ ';
  const result = applyReplayDropBarrier(source, {
    logBytes: encoder.encode(source).byteLength,
    currentOffset: 200,
    dropUntilOffset: 203,
    encodeText: (text) => encoder.encode(text),
    decodeBytes: (bytes) => decoder.decode(bytes)
  });

  assert.equal(result.text, 'prompt$ ');
  assert.equal(result.logBytes, encoder.encode('prompt$ ').byteLength);
  assert.equal(result.droppedLogBytes, encoder.encode('old').byteLength);
  assert.equal(result.barrierReached, true);
});

test('applyReplayDropBarrier drops full chunk when split is impossible', () => {
  const result = applyReplayDropBarrier('partial', {
    logBytes: 7,
    currentOffset: 50,
    dropUntilOffset: 53
  });

  assert.deepEqual(result, {
    text: '',
    logBytes: 0,
    droppedLogBytes: 7,
    barrierReached: true
  });
});
