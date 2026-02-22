import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapSessionReplayOffset } from '../../public/lib/session-replay-offset-policy.js';

test('bootstrapSessionReplayOffset keeps existing positive offset', async () => {
  let fetchCalls = 0;
  let setCalls = 0;
  const result = await bootstrapSessionReplayOffset('session-a', {
    getSessionOffset: () => 1024,
    fetchSessionLogBytes: async () => {
      fetchCalls += 1;
      return 4096;
    },
    setSessionOffset: () => {
      setCalls += 1;
    }
  });

  assert.equal(result, 1024);
  assert.equal(fetchCalls, 0);
  assert.equal(setCalls, 0);
});

test('bootstrapSessionReplayOffset prefers server-provided aligned replay offset', async () => {
  const setHistory = [];
  let fallbackFetchCalls = 0;
  const result = await bootstrapSessionReplayOffset('session-aligned', {
    getSessionOffset: () => 0,
    fetchSessionReplayOffset: async () => ({
      replayFrom: 3072,
      logBytes: 8192,
      aligned: true
    }),
    fetchSessionLogBytes: async () => {
      fallbackFetchCalls += 1;
      return 8192;
    },
    setSessionOffset: (sessionId, offset) => {
      setHistory.push([sessionId, offset]);
    }
  });

  assert.equal(result, 3072);
  assert.equal(fallbackFetchCalls, 0);
  assert.deepEqual(setHistory, [['session-aligned', 3072]]);
});

test('bootstrapSessionReplayOffset initializes from recent tail when offset missing', async () => {
  const setHistory = [];
  const result = await bootstrapSessionReplayOffset('session-b', {
    getSessionOffset: () => 0,
    fetchSessionLogBytes: async () => 8192,
    replayTailBytes: 4096,
    setSessionOffset: (sessionId, offset) => {
      setHistory.push([sessionId, offset]);
    }
  });

  assert.equal(result, 4096);
  assert.deepEqual(setHistory, [['session-b', 4096]]);
});

test('bootstrapSessionReplayOffset falls back to byte-tail policy when replay-offset API is unavailable', async () => {
  const setHistory = [];
  const result = await bootstrapSessionReplayOffset('session-fallback', {
    getSessionOffset: () => 0,
    fetchSessionReplayOffset: async () => null,
    fetchSessionLogBytes: async () => 8192,
    replayTailBytes: 2048,
    setSessionOffset: (sessionId, offset) => {
      setHistory.push([sessionId, offset]);
    }
  });

  assert.equal(result, 6144);
  assert.deepEqual(setHistory, [['session-fallback', 6144]]);
});

test('bootstrapSessionReplayOffset falls back to zero when log size is smaller than tail', async () => {
  const setHistory = [];
  const result = await bootstrapSessionReplayOffset('session-small', {
    getSessionOffset: () => 0,
    fetchSessionLogBytes: async () => 1024,
    replayTailBytes: 4096,
    setSessionOffset: (sessionId, offset) => {
      setHistory.push([sessionId, offset]);
    }
  });

  assert.equal(result, 0);
  assert.deepEqual(setHistory, [['session-small', 0]]);
});

test('bootstrapSessionReplayOffset tolerates fetch failures', async () => {
  let setCalls = 0;
  const result = await bootstrapSessionReplayOffset('session-c', {
    getSessionOffset: () => 0,
    fetchSessionLogBytes: async () => {
      throw new Error('network');
    },
    setSessionOffset: () => {
      setCalls += 1;
    }
  });

  assert.equal(result, 0);
  assert.equal(setCalls, 0);
});

test('bootstrapSessionReplayOffset returns 0 for empty session id', async () => {
  const result = await bootstrapSessionReplayOffset('', {
    getSessionOffset: () => 2048,
    fetchSessionLogBytes: async () => 4096
  });

  assert.equal(result, 0);
});
