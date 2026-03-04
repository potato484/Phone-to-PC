import { DOM, State } from './state.js';

const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
const HEARTBEAT_MAX_TIMEOUT_STREAK = 3;
const SAMPLE_LIMIT = 40;
const PROFILE_ORDER = {
  low: 0,
  balanced: 1,
  high: 2
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function gradeFromScore(score, connected) {
  if (!connected) {
    return 'offline';
  }
  if (score >= 80) {
    return 'excellent';
  }
  if (score >= 60) {
    return 'good';
  }
  if (score >= 40) {
    return 'fair';
  }
  return 'poor';
}

function profileFromScore(score) {
  if (score >= 75) {
    return 'high';
  }
  if (score >= 45) {
    return 'balanced';
  }
  return 'low';
}

function computeQuality(samples, connected) {
  const successful = samples.filter((sample) => !sample.lost && Number.isFinite(sample.rttMs));
  const losses = samples.filter((sample) => sample.lost).length;

  let rttMs = 0;
  if (successful.length > 0) {
    const totalRtt = successful.reduce((sum, sample) => sum + (sample.rttMs || 0), 0);
    rttMs = totalRtt / successful.length;
  }

  let jitterMs = 0;
  if (successful.length > 1) {
    const deltas = [];
    for (let i = 1; i < successful.length; i += 1) {
      const previous = successful[i - 1].rttMs || 0;
      const current = successful[i].rttMs || 0;
      deltas.push(Math.abs(current - previous));
    }
    deltas.sort((a, b) => a - b);
    const q1 = Math.floor(deltas.length * 0.25);
    const q3 = Math.ceil(deltas.length * 0.75);
    const trimmed = q3 > q1 ? deltas.slice(q1, q3) : deltas;
    jitterMs = trimmed.reduce((sum, d) => sum + d, 0) / trimmed.length;
  }

  const lossPercent = samples.length > 0 ? (losses / samples.length) * 100 : 0;

  let score = 0;
  if (connected && samples.length > 0) {
    const rttScore = clamp(110 - 25 * Math.log10(Math.max(1, rttMs)), 0, 100);
    const jitterScore = clamp(105 - 30 * Math.log10(Math.max(1, jitterMs)), 0, 100);
    const lossScore = clamp(100 - lossPercent * 6, 0, 100);
    score = Math.round(rttScore * 0.5 + jitterScore * 0.2 + lossScore * 0.3);
  }

  return {
    rttMs: roundTo(rttMs, 1),
    jitterMs: roundTo(jitterMs, 1),
    lossPercent: roundTo(lossPercent, 1),
    score: clamp(score, 0, 100)
  };
}

function resolveSignalLevelFromGrade(grade) {
  if (grade === 'excellent') {
    return '4';
  }
  if (grade === 'good') {
    return '3';
  }
  if (grade === 'fair') {
    return '2';
  }
  if (grade === 'poor') {
    return '1';
  }
  return '0';
}

export function createQualityMonitor({ sendHeartbeat, onSnapshot }) {
  let heartbeatTimer = 0;
  let heartbeatSeq = 0;
  let connected = false;
  let desktopProfile = 'balanced';
  let timeoutStreak = 0;
  let forcedCloseTriggered = false;
  let riseStreak = 0;
  let dropStreak = 0;
  const pending = new Map();
  const samples = [];

  function clearHeartbeatTimer() {
    if (!heartbeatTimer) {
      return;
    }
    window.clearTimeout(heartbeatTimer);
    heartbeatTimer = 0;
  }

  function clearPending() {
    pending.forEach((entry) => {
      window.clearTimeout(entry.timeoutId);
    });
    pending.clear();
  }

  function scheduleHeartbeat() {
    clearHeartbeatTimer();
    if (!connected) {
      return;
    }
    heartbeatTimer = window.setTimeout(() => {
      heartbeatTimer = 0;
      sendHeartbeatPing();
      scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function pushSample(sample) {
    samples.push(sample);
    if (samples.length > SAMPLE_LIMIT) {
      samples.shift();
    }
  }

  function publishSnapshot(reason) {
    const quality = computeQuality(samples, connected);
    const grade = gradeFromScore(quality.score, connected);
    const recommendedProfile = profileFromScore(quality.score);
    const currentOrder = PROFILE_ORDER[desktopProfile];
    const recommendedOrder = PROFILE_ORDER[recommendedProfile];

    if (recommendedProfile === desktopProfile) {
      riseStreak = 0;
      dropStreak = 0;
    } else if (recommendedOrder < currentOrder) {
      dropStreak += 1;
      riseStreak = 0;
      if (dropStreak >= 2) {
        desktopProfile = recommendedProfile;
        dropStreak = 0;
      }
    } else {
      riseStreak += 1;
      dropStreak = 0;
      if (riseStreak >= 4) {
        desktopProfile = recommendedProfile;
        riseStreak = 0;
      }
    }

    const snapshot = {
      connected,
      score: quality.score,
      grade,
      rttMs: quality.rttMs,
      jitterMs: quality.jitterMs,
      lossPercent: quality.lossPercent,
      desktopProfile,
      reason,
      updatedAt: new Date().toISOString()
    };

    State.desktopQualityProfile = desktopProfile;
    State.connectionQualitySnapshot = snapshot;
    if (DOM.qualitySignal) {
      DOM.qualitySignal.dataset.level = resolveSignalLevelFromGrade(grade);
    }
    if (typeof onSnapshot === 'function') {
      onSnapshot(snapshot);
    }
  }

  function maybeCloseStaleControlSocket(reason) {
    if (!connected || forcedCloseTriggered || timeoutStreak < HEARTBEAT_MAX_TIMEOUT_STREAK) {
      return;
    }
    const ws = State.controlSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    forcedCloseTriggered = true;
    ws.close(4002, reason || 'heartbeat_timeout');
  }

  function sendHeartbeatPing() {
    if (!connected) {
      return;
    }
    heartbeatSeq += 1;
    const seq = heartbeatSeq;
    const sentAt = Date.now();
    const currentQuality = computeQuality(samples, connected);
    const currentGrade = gradeFromScore(currentQuality.score, connected);
    const sent = typeof sendHeartbeat === 'function'
      ? sendHeartbeat({
          type: 'heartbeat.ping',
          seq,
          sentAt,
          rttGrade: currentGrade === 'offline' ? undefined : currentGrade
        })
      : false;

    if (!sent) {
      timeoutStreak += 1;
      pushSample({
        at: Date.now(),
        lost: true,
        rttMs: null
      });
      publishSnapshot('heartbeat_send_failed');
      maybeCloseStaleControlSocket('heartbeat_send_failed');
      return;
    }

    const timeoutId = window.setTimeout(() => {
      pending.delete(seq);
      timeoutStreak += 1;
      pushSample({
        at: Date.now(),
        lost: true,
        rttMs: null
      });
      publishSnapshot('heartbeat_timeout');
      maybeCloseStaleControlSocket('heartbeat_timeout');
    }, HEARTBEAT_TIMEOUT_MS);

    pending.set(seq, {
      sentAt,
      timeoutId
    });
  }

  return {
    onControlReady() {
      connected = true;
      timeoutStreak = 0;
      forcedCloseTriggered = false;
      clearHeartbeatTimer();
      clearPending();

      sendHeartbeatPing();
      scheduleHeartbeat();
      publishSnapshot('control_ready');
    },

    onControlClosed() {
      connected = false;
      timeoutStreak = 0;
      forcedCloseTriggered = false;
      clearHeartbeatTimer();
      clearPending();
      publishSnapshot('control_closed');
    },

    onPong(payload) {
      if (!connected || !payload || typeof payload !== 'object') {
        return;
      }

      const seq = Number.isFinite(Number(payload.seq)) ? Math.floor(Number(payload.seq)) : 0;
      const sentAt = Number.isFinite(Number(payload.sentAt)) ? Number(payload.sentAt) : 0;
      const pendingEntry = pending.get(seq);

      if (pendingEntry) {
        window.clearTimeout(pendingEntry.timeoutId);
        pending.delete(seq);
        timeoutStreak = 0;
        forcedCloseTriggered = false;
        pushSample({
          at: Date.now(),
          lost: false,
          rttMs: Math.max(0, Date.now() - pendingEntry.sentAt)
        });
      } else if (sentAt > 0) {
        timeoutStreak = 0;
        forcedCloseTriggered = false;
        pushSample({
          at: Date.now(),
          lost: false,
          rttMs: Math.max(0, Date.now() - sentAt)
        });
      }
      publishSnapshot('heartbeat_pong');
    },

    getSnapshot() {
      return State.connectionQualitySnapshot || null;
    }
  };
}
