import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMobileTerminalScrollback } from '../../public/lib/terminal-scrollback-policy.js';

test('resolveMobileTerminalScrollback uses low-memory tier for small devices', () => {
  assert.equal(resolveMobileTerminalScrollback(2), 8000);
  assert.equal(resolveMobileTerminalScrollback(3), 8000);
});

test('resolveMobileTerminalScrollback uses default tier for medium devices', () => {
  assert.equal(resolveMobileTerminalScrollback(4), 12000);
  assert.equal(resolveMobileTerminalScrollback(6), 12000);
});

test('resolveMobileTerminalScrollback uses high tier for large-memory devices', () => {
  assert.equal(resolveMobileTerminalScrollback(8), 20000);
  assert.equal(resolveMobileTerminalScrollback(16), 20000);
});

test('resolveMobileTerminalScrollback falls back to default when memory info is unavailable', () => {
  assert.equal(resolveMobileTerminalScrollback(undefined), 12000);
  assert.equal(resolveMobileTerminalScrollback(Number.NaN), 12000);
});
