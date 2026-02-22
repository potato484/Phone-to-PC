function toSafeOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

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
    setSessionOffset(sessionId, logBytes);
    return logBytes;
  }
  return 0;
}
