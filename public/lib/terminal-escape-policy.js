const INITIAL_ATTACH_ALT_SCREEN_ENTER_RE = /\x1b(?:\x1b)?\[\?(?:47|1047|1049)(?:;[0-9]+)*h/g;
const INITIAL_ATTACH_CURSOR_POSITION_QUERY_RE = /\x1b(?:\x1b)?\[\??6n/g;
const INITIAL_ATTACH_RESET_RE = /\x1bc/g;
const BLOCKED_TERMINAL_PRIVATE_MODES = new Set([47, 1047, 1048, 1049]);

export function sanitizeInitialAttachData(data, sanitizeUntilMs, nowMs = Date.now()) {
  if (typeof data !== 'string' || !data || data.indexOf('\x1b') < 0) {
    return data;
  }
  if (!Number.isFinite(sanitizeUntilMs) || sanitizeUntilMs <= 0 || nowMs > sanitizeUntilMs) {
    return data;
  }
  return data
    .replace(INITIAL_ATTACH_ALT_SCREEN_ENTER_RE, '')
    .replace(INITIAL_ATTACH_CURSOR_POSITION_QUERY_RE, '')
    .replace(INITIAL_ATTACH_RESET_RE, '');
}

function normalizeParserParams(params) {
  if (Array.isArray(params)) {
    return params;
  }
  if (!params || typeof params !== 'object') {
    return [];
  }
  if (typeof params.toArray === 'function') {
    try {
      const values = params.toArray();
      return Array.isArray(values) ? values : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(params.params)) {
    return params.params;
  }
  if (typeof params.length === 'number' && typeof params.get === 'function') {
    const values = [];
    for (let index = 0; index < params.length; index += 1) {
      values.push(params.get(index));
    }
    return values;
  }
  return [];
}

export function shouldBlockPrivateModeParams(params) {
  const parsedValues = normalizeParserParams(params);
  if (parsedValues.length === 0) {
    return false;
  }
  return parsedValues.some((value) => BLOCKED_TERMINAL_PRIVATE_MODES.has(Number(value)));
}
