import assert from 'node:assert/strict';
import test from 'node:test';
import { extractScrollbackClearSequence } from '../../public/lib/terminal-clear-policy.js';

test('extractScrollbackClearSequence keeps text untouched when no CSI 3J is present', () => {
  const result = extractScrollbackClearSequence('before\x1b[H\x1b[2Jafter');
  assert.deepEqual(result, {
    text: 'before\x1b[H\x1b[2Jafter',
    shouldClearScrollback: false,
    carry: ''
  });
});

test('extractScrollbackClearSequence strips CSI 3J and reports clear intent', () => {
  const result = extractScrollbackClearSequence('before\x1b[3Jafter');
  assert.deepEqual(result, {
    text: 'beforeafter',
    shouldClearScrollback: true,
    carry: ''
  });
});

test('extractScrollbackClearSequence strips all CSI 3J sequences in one chunk', () => {
  const result = extractScrollbackClearSequence('\x1b[3Jx\x1b[3Jy\x1b[3J');
  assert.deepEqual(result, {
    text: 'xy',
    shouldClearScrollback: true,
    carry: ''
  });
});

test('extractScrollbackClearSequence preserves trailing partial sequence as carry', () => {
  const result = extractScrollbackClearSequence('hello\x1b[3');
  assert.deepEqual(result, {
    text: 'hello',
    shouldClearScrollback: false,
    carry: '\x1b[3'
  });
});

test('extractScrollbackClearSequence supports CSI 3J split across chunks', () => {
  const first = extractScrollbackClearSequence('\x1b[H\x1b[2J\x1b[3');
  assert.deepEqual(first, {
    text: '\x1b[H\x1b[2J',
    shouldClearScrollback: false,
    carry: '\x1b[3'
  });

  const second = extractScrollbackClearSequence('Jprompt$ ', first.carry);
  assert.deepEqual(second, {
    text: 'prompt$ ',
    shouldClearScrollback: true,
    carry: ''
  });
});
