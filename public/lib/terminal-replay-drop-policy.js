function toSafeOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function applyReplayDropBarrier(data, options = {}) {
  const text = typeof data === 'string' ? data : '';
  const logBytes = toSafeOffset(options.logBytes);
  const currentOffset = toSafeOffset(options.currentOffset);
  const dropUntilOffset = toSafeOffset(options.dropUntilOffset);

  if (dropUntilOffset <= currentOffset || logBytes <= 0) {
    return {
      text,
      logBytes,
      droppedLogBytes: 0,
      barrierReached: dropUntilOffset <= currentOffset
    };
  }

  const remainingDropBytes = dropUntilOffset - currentOffset;
  if (remainingDropBytes >= logBytes) {
    return {
      text: '',
      logBytes: 0,
      droppedLogBytes: logBytes,
      barrierReached: currentOffset + logBytes >= dropUntilOffset
    };
  }

  const encodeText = typeof options.encodeText === 'function' ? options.encodeText : null;
  const decodeBytes = typeof options.decodeBytes === 'function' ? options.decodeBytes : null;
  if (!text || !encodeText || !decodeBytes) {
    return {
      text: '',
      logBytes: 0,
      droppedLogBytes: logBytes,
      barrierReached: true
    };
  }

  let encoded = null;
  try {
    encoded = encodeText(text);
  } catch {
    encoded = null;
  }
  if (!encoded || typeof encoded.byteLength !== 'number' || encoded.byteLength !== logBytes) {
    return {
      text: '',
      logBytes: 0,
      droppedLogBytes: logBytes,
      barrierReached: true
    };
  }

  const trailingBytes = encoded.subarray(remainingDropBytes);
  let trailingText = '';
  try {
    trailingText = decodeBytes(trailingBytes);
  } catch {
    trailingText = '';
  }

  return {
    text: trailingText,
    logBytes: Math.max(0, logBytes - remainingDropBytes),
    droppedLogBytes: remainingDropBytes,
    barrierReached: true
  };
}
