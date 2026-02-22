function toSafeOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

const DEFAULT_REPLAY_TAIL_BYTES = 64 * 1024;

export async function bootstrapSessionReplayOffset(sessionId, adapters = {}) {
  if (!sessionId) {
    return 0;
  }
  const getSessionOffset =
    typeof adapters.getSessionOffset === 'function' ? adapters.getSessionOffset : () => 0;
  const setSessionOffset =
    typeof adapters.setSessionOffset === 'function' ? adapters.setSessionOffset : () => {};
  const fetchSessionLogBytes =
    typeof adapters.fetchSessionLogBytes === 'function' ? adapters.fetchSessionLogBytes : async () => 0;
  const replayTailBytes = Math.max(
    0,
    toSafeOffset(adapters.replayTailBytes) || DEFAULT_REPLAY_TAIL_BYTES
  );

  const currentOffset = toSafeOffset(getSessionOffset(sessionId));
  if (currentOffset > 0) {
    return currentOffset;
  }

  let logBytes = 0;
  try {
    logBytes = toSafeOffset(await fetchSessionLogBytes(sessionId));
  } catch {
    logBytes = 0;
  }

  if (logBytes > 0) {
    const replayFrom = Math.max(0, logBytes - replayTailBytes);
    setSessionOffset(sessionId, replayFrom);
    return replayFrom;
  }
  return 0;
}
