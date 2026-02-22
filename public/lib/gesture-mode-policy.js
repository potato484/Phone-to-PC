export function shouldAllowSingleFingerTerminalScroll() {
  return true;
}

export function computePinchScale(startDistance, currentDistance) {
  const start = Number(startDistance);
  const current = Number(currentDistance);
  if (!Number.isFinite(start) || !Number.isFinite(current) || start <= 0 || current <= 0) {
    return 1;
  }
  return current / start;
}

export function shouldApplyPinchScale(options = {}) {
  const scale = Number(options.scale);
  if (!Number.isFinite(scale) || scale <= 0) {
    return false;
  }
  const lastScale = Number.isFinite(Number(options.lastScale)) && Number(options.lastScale) > 0
    ? Number(options.lastScale)
    : 1;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : 0;
  const lastAppliedAtMs = Number.isFinite(Number(options.lastAppliedAtMs)) ? Number(options.lastAppliedAtMs) : 0;
  const scaleEpsilon = Number.isFinite(Number(options.scaleEpsilon)) && Number(options.scaleEpsilon) >= 0
    ? Number(options.scaleEpsilon)
    : 0.015;
  const minIntervalMs = Number.isFinite(Number(options.minIntervalMs)) && Number(options.minIntervalMs) >= 0
    ? Number(options.minIntervalMs)
    : 24;
  if (Math.abs(scale - lastScale) < scaleEpsilon) {
    return false;
  }
  return nowMs - lastAppliedAtMs >= minIntervalMs;
}
