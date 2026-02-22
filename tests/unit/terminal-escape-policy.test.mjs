import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizeInitialAttachData,
  shouldBlockOscColorQueryPayload,
  shouldBlockPrivateModeParams
} from '../../public/lib/terminal-escape-policy.js';

test('sanitizeInitialAttachData keeps CSI 3J clear scrollback sequence', () => {
  const source = `before\x1b[3Jafter`;
  const sanitized = sanitizeInitialAttachData(source, 120, 0);
  assert.equal(sanitized, source);
});

test('sanitizeInitialAttachData strips blocked init-time escape sequences in sanitize window', () => {
  const source = `A\x1b[?1049hB\x1b[6nC\x1bcD`;
  const sanitized = sanitizeInitialAttachData(source, 120, 0);
  assert.equal(sanitized, 'ABCD');
});

test('sanitizeInitialAttachData returns original text after sanitize window expires', () => {
  const source = `\x1b[?1049h`;
  const sanitized = sanitizeInitialAttachData(source, 10, 20);
  assert.equal(sanitized, source);
});

test('shouldBlockPrivateModeParams blocks known private-mode values', () => {
  assert.equal(shouldBlockPrivateModeParams([47]), true);
  assert.equal(shouldBlockPrivateModeParams([1048]), true);
});

test('shouldBlockPrivateModeParams supports parser-like parameter containers', () => {
  assert.equal(
    shouldBlockPrivateModeParams({
      toArray: () => [1047]
    }),
    true
  );
  assert.equal(
    shouldBlockPrivateModeParams({
      length: 1,
      get: () => 12
    }),
    false
  );
});

test('shouldBlockPrivateModeParams ignores unrelated values', () => {
  assert.equal(shouldBlockPrivateModeParams([3]), false);
  assert.equal(shouldBlockPrivateModeParams([]), false);
});

test('shouldBlockOscColorQueryPayload detects OSC query payloads', () => {
  assert.equal(shouldBlockOscColorQueryPayload('?'), true);
  assert.equal(shouldBlockOscColorQueryPayload('rgb:cdcd/d6d6/f4f4;?'), true);
});

test('shouldBlockOscColorQueryPayload keeps regular color payloads', () => {
  assert.equal(shouldBlockOscColorQueryPayload('rgb:cdcd/d6d6/f4f4'), false);
  assert.equal(shouldBlockOscColorQueryPayload('#cdd6f4'), false);
  assert.equal(shouldBlockOscColorQueryPayload(''), false);
});
