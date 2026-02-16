import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { C2PStore } from '../../dist/store.js';

test('C2PStore stores and summarizes telemetry events', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-telemetry-'));
  const dbPath = path.join(tempDir, 'store.sqlite');
  const store = new C2PStore(dbPath);

  try {
    store.addTelemetryEvent({
      deviceId: 'dev-a',
      eventName: 'session_quality_pass',
      happenedAt: '2026-02-16T10:00:00.000Z',
      payload: { score: 81 }
    });
    store.addTelemetryEvent({
      deviceId: 'dev-a',
      eventName: 'magic_moment_reached',
      sessionId: 'session-1',
      happenedAt: '2026-02-16T10:02:00.000Z',
      payload: { score: 88 }
    });
    store.addTelemetryEvent({
      deviceId: 'dev-b',
      eventName: 'session_quality_pass',
      happenedAt: '2026-02-16T10:03:00.000Z',
      payload: { score: 75 }
    });

    const events = store.listTelemetryEvents({ limit: 10 });
    assert.equal(events.length, 3);
    assert.equal(events[0]?.eventName, 'session_quality_pass');
    assert.equal(events[0]?.deviceId, 'dev-b');
    assert.deepEqual(events[1]?.payload, { score: 88 });

    const qualityPassOnly = store.listTelemetryEvents({
      eventName: 'session_quality_pass',
      limit: 10
    });
    assert.equal(qualityPassOnly.length, 2);

    const summary = store.getTelemetrySummary();
    assert.equal(summary.totalEvents, 3);
    assert.equal(summary.uniqueDevices, 2);
    const qualityPassSummary = summary.eventCounts.find((entry) => entry.eventName === 'session_quality_pass');
    assert.equal(qualityPassSummary?.count, 2);

    const recentSummary = store.getTelemetrySummary({
      since: '2026-02-16T10:02:30.000Z'
    });
    assert.equal(recentSummary.totalEvents, 1);
    assert.equal(recentSummary.uniqueDevices, 1);
  } finally {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
