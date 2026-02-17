import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('tokens.css matches generator output', async () => {
  await execFileAsync(process.execPath, ['scripts/build-tokens.mjs', '--check'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const existing = await readFile('public/tokens.css', 'utf8');

  assert.match(existing, /--c2p-bg:/);
  assert.match(existing, /--bg: var\(--c2p-bg\)/);
});
