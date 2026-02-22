function toFiniteNumber(value, fallback = 0) {
  const safeFallback = Number.isFinite(fallback) ? fallback : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : safeFallback;
}

function normalizeScope(scope) {
  if (scope === 'terminal' || scope === 'dock-input') {
    return scope;
  }
  return 'other';
}

export function clampScrollDeltaToRemaining(delta, metrics = {}) {
  const safeDelta = Math.max(0, toFiniteNumber(delta, 0));
  if (safeDelta <= 0) {
    return 0;
  }
  const scrollTop = Math.max(0, toFiniteNumber(metrics.scrollTop, 0));
  const scrollHeight = Math.max(0, toFiniteNumber(metrics.scrollHeight, 0));
  const clientHeight = Math.max(0, toFiniteNumber(metrics.clientHeight, 0));
  const remaining = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return Math.min(safeDelta, remaining);
}

export function shouldAutoAlignKeyboardViewport(options = {}) {
  const keyboardVisible = !!options.keyboardVisible;
  if (!keyboardVisible) {
    return false;
  }
  if (options.keyboardChanged) {
    return true;
  }
  const reason = typeof options.reason === 'string' ? options.reason : '';
  if (reason !== 'focusin') {
    return false;
  }
  const activeScope = normalizeScope(options.activeScope);
  if (activeScope === 'other') {
    return false;
  }
  const lastAlignedScope = normalizeScope(options.lastAlignedScope);
  return activeScope !== lastAlignedScope;
}
