import { State, apiUrl, authedFetch } from './state.js';

const TELEMETRY_OPT_IN_STORAGE_KEY = 'c2p_telemetry_opt_in_v1';
const TELEMETRY_DEVICE_ID_STORAGE_KEY = 'c2p_telemetry_device_id_v1';
const TELEMETRY_FLUSH_INTERVAL_MS = 5_000;
const TELEMETRY_BATCH_SIZE = 24;
const TELEMETRY_QUEUE_LIMIT = 200;
const TELEMETRY_EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;

function readOptIn() {
  try {
    return window.localStorage.getItem(TELEMETRY_OPT_IN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOptIn(enabled) {
  try {
    window.localStorage.setItem(TELEMETRY_OPT_IN_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }
}

function createFallbackId() {
  const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `anon-${seed}`;
}

function ensureDeviceId() {
  try {
    const existing = window.localStorage.getItem(TELEMETRY_DEVICE_ID_STORAGE_KEY);
    if (typeof existing === 'string' && existing.trim().length > 0) {
      return existing.trim();
    }
  } catch {
    // ignore
  }

  const next =
    window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : createFallbackId();
  try {
    window.localStorage.setItem(TELEMETRY_DEVICE_ID_STORAGE_KEY, next);
  } catch {
    // ignore storage failures
  }
  return next;
}

function normalizeEventName(name) {
  if (typeof name !== 'string') {
    return '';
  }
  const normalized = name.trim().toLowerCase();
  return TELEMETRY_EVENT_NAME_PATTERN.test(normalized) ? normalized : '';
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  try {
    const text = JSON.stringify(payload);
    if (typeof text !== 'string' || text.length === 0 || text.length > 8_192) {
      return {};
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function createTelemetry({ toast }) {
  let enabled = readOptIn();
  const deviceId = ensureDeviceId();
  const queue = [];
  let flushTimer = 0;
  let flushInFlight = false;

  function scheduleFlush() {
    if (!enabled || flushInFlight || queue.length === 0 || flushTimer) {
      return;
    }
    flushTimer = window.setTimeout(() => {
      flushTimer = 0;
      void flush();
    }, TELEMETRY_FLUSH_INTERVAL_MS);
  }

  function enqueue(event) {
    queue.push(event);
    if (queue.length > TELEMETRY_QUEUE_LIMIT) {
      queue.splice(0, queue.length - TELEMETRY_QUEUE_LIMIT);
    }
    scheduleFlush();
  }

  async function flush(options = {}) {
    const keepalive = options.keepalive === true;
    if (!enabled || flushInFlight || queue.length === 0 || !State.token) {
      return;
    }

    if (flushTimer) {
      window.clearTimeout(flushTimer);
      flushTimer = 0;
    }

    flushInFlight = true;
    const batch = queue.slice(0, TELEMETRY_BATCH_SIZE);
    try {
      const response = await authedFetch(apiUrl('/api/telemetry/events'), {
        method: 'POST',
        keepalive,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deviceId,
          events: batch
        })
      });
      if (!response.ok) {
        throw new Error(`telemetry rejected (${response.status})`);
      }
      queue.splice(0, batch.length);
    } catch {
      // Keep queue for retry.
    } finally {
      flushInFlight = false;
      scheduleFlush();
    }
  }

  function track(eventName, payload = {}, options = {}) {
    if (!enabled) {
      return false;
    }
    const normalizedName = normalizeEventName(eventName);
    if (!normalizedName) {
      return false;
    }
    const sessionId =
      typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
        ? options.sessionId.trim()
        : undefined;
    enqueue({
      name: normalizedName,
      happenedAt: new Date().toISOString(),
      sessionId,
      payload: sanitizePayload(payload)
    });
    return true;
  }

  function setEnabled(nextEnabled, options = {}) {
    const silent = options.silent === true;
    const normalized = !!nextEnabled;
    if (enabled === normalized) {
      return;
    }
    enabled = normalized;
    writeOptIn(enabled);
    if (!enabled) {
      queue.length = 0;
      if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = 0;
      }
      if (!silent && toast) {
        toast.show('匿名遥测已关闭', 'info');
      }
      return;
    }

    if (!silent && toast) {
      toast.show('匿名遥测已开启', 'success');
    }
    track('telemetry_opt_in', { enabled: true });
    scheduleFlush();
  }

  function init() {
    window.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'hidden') {
          return;
        }
        void flush({ keepalive: true });
      },
      { passive: true }
    );

    window.addEventListener(
      'beforeunload',
      () => {
        void flush({ keepalive: true });
      },
      { passive: true }
    );
  }

  return {
    init,
    isEnabled() {
      return enabled;
    },
    setEnabled,
    track,
    flush,
    getDeviceId() {
      return deviceId;
    }
  };
}
