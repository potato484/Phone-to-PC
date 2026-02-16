import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { C2PStore } from '../../dist/store.js';

test('C2PStore migrates legacy JSON once and remains idempotent', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-store-'));
  const dbPath = path.join(tempDir, 'store.sqlite');
  const legacyPath = path.join(tempDir, '.c2p-store.json');
  const createdAt = new Date().toISOString();

  await writeFile(
    legacyPath,
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          cli: 'shell',
          prompt: 'echo 1',
          cwd: '/tmp',
          status: 'running',
          createdAt,
          startedAt: createdAt,
          updatedAt: createdAt
        }
      ],
      subscriptions: [
        {
          endpoint: 'https://example.com/sub/1',
          expirationTime: null,
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      ]
    }),
    'utf8'
  );

  const storeA = new C2PStore(dbPath);
  try {
    const tasks = storeA.listTasks();
    const subs = storeA.listSubscriptions();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, 'task-1');
    assert.equal(subs.length, 1);
    assert.equal(subs[0]?.endpoint, 'https://example.com/sub/1');

    const backups = (await readdir(tempDir)).filter((name) => name.startsWith('.c2p-store.json.bak.'));
    assert.ok(backups.length >= 1);

    const rawDb = await readFile(dbPath);
    assert.ok(rawDb.byteLength > 0);
  } finally {
    storeA.close();
  }

  const storeB = new C2PStore(dbPath);
  try {
    const tasks = storeB.listTasks();
    const subs = storeB.listSubscriptions();
    assert.equal(tasks.length, 1);
    assert.equal(subs.length, 1);
  } finally {
    storeB.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
