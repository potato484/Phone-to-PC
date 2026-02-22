const MAX_INPUT_LINE_TRACKED_CHARS = 256;

function normalizeInputBuffer(value) {
  if (typeof value !== 'string') {
    return '';
  }
  if (value.length <= MAX_INPUT_LINE_TRACKED_CHARS) {
    return value;
  }
  return value.slice(-MAX_INPUT_LINE_TRACKED_CHARS);
}

function appendPrintable(buffer, text) {
  const combined = `${buffer}${text}`;
  return normalizeInputBuffer(combined);
}

function stripKnownInputControlSequences(data) {
  const source = typeof data === 'string' ? data : '';
  if (!source || source.indexOf('\u001b') < 0) {
    return source;
  }
  return source
    // Bracketed paste wrappers.
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    // OSC: ESC ] ... BEL / ST
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ ... final-byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Single-char ESC functions.
    .replace(/\x1b[@-Z\\-_]/g, '');
}

export function parseInputLineForExplicitClear(lineBuffer, data) {
  const safeData = stripKnownInputControlSequences(data);
  let nextLineBuffer = normalizeInputBuffer(lineBuffer);
  let clearCommandDetected = false;

  for (const char of safeData) {
    if (char === '\r' || char === '\n') {
      if (nextLineBuffer.trim() === 'clear') {
        clearCommandDetected = true;
      }
      nextLineBuffer = '';
      continue;
    }
    if (char === '\u007f' || char === '\b') {
      nextLineBuffer = nextLineBuffer.slice(0, -1);
      continue;
    }
    if (char === '\u0015' || char === '\u0003' || char === '\u001b') {
      nextLineBuffer = '';
      continue;
    }
    if (char === '\t') {
      nextLineBuffer = appendPrintable(nextLineBuffer, char);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      nextLineBuffer = appendPrintable(nextLineBuffer, char);
    }
  }

  return {
    lineBuffer: nextLineBuffer,
    clearCommandDetected
  };
}
