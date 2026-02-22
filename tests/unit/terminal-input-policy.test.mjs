import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInputLineForExplicitClear } from '../../public/lib/terminal-input-policy.js';

test('parseInputLineForExplicitClear detects clear command on submit', () => {
  const result = parseInputLineForExplicitClear('', 'clear\r');
  assert.deepEqual(result, {
    lineBuffer: '',
    clearCommandDetected: true
  });
});

test('parseInputLineForExplicitClear ignores non-clear commands', () => {
  const result = parseInputLineForExplicitClear('', 'echo clear\r');
  assert.deepEqual(result, {
    lineBuffer: '',
    clearCommandDetected: false
  });
});

test('parseInputLineForExplicitClear handles incremental typing and backspace', () => {
  const first = parseInputLineForExplicitClear('', 'cleax');
  assert.deepEqual(first, {
    lineBuffer: 'cleax',
    clearCommandDetected: false
  });
  const second = parseInputLineForExplicitClear(first.lineBuffer, '\u007fr\r');
  assert.deepEqual(second, {
    lineBuffer: '',
    clearCommandDetected: true
  });
});

test('parseInputLineForExplicitClear resets line buffer on Ctrl+C and ESC', () => {
  const first = parseInputLineForExplicitClear('', 'clear');
  assert.deepEqual(first, {
    lineBuffer: 'clear',
    clearCommandDetected: false
  });
  const second = parseInputLineForExplicitClear(first.lineBuffer, '\u0003');
  assert.deepEqual(second, {
    lineBuffer: '',
    clearCommandDetected: false
  });
  const third = parseInputLineForExplicitClear('clear', '\u001b');
  assert.deepEqual(third, {
    lineBuffer: '',
    clearCommandDetected: false
  });
});

test('parseInputLineForExplicitClear detects clear wrapped by bracketed-paste markers', () => {
  const result = parseInputLineForExplicitClear('', '\u001b[200~clear\u001b[201~\r');
  assert.deepEqual(result, {
    lineBuffer: '',
    clearCommandDetected: true
  });
});

test('parseInputLineForExplicitClear ignores CSI control sequences mixed in input', () => {
  const result = parseInputLineForExplicitClear('', '\u001b[1;5Aclear\r');
  assert.deepEqual(result, {
    lineBuffer: '',
    clearCommandDetected: true
  });
});
