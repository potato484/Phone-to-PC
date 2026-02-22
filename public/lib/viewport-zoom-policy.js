const DEFAULT_SCALE_EPSILON = 0.02;
const DEFAULT_VIEWPORT_EPSILON_PX = 1;

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasViewportDelta(current, previous, epsilon) {
  if (previous <= 0) {
    return current > 0;
  }
  return Math.abs(current - previous) > epsilon;
}

export function shouldScheduleZoomResize(options = {}) {
  const scaleEpsilon = Math.max(0, toFiniteNumber(options.scaleEpsilon, DEFAULT_SCALE_EPSILON));
  const viewportEpsilonPx = Math.max(0, toFiniteNumber(options.viewportEpsilonPx, DEFAULT_VIEWPORT_EPSILON_PX));
  const currentScale = Math.max(0, toFiniteNumber(options.currentScale, 1));
  const previousScale = Math.max(0, toFiniteNumber(options.previousScale, 1));
  const viewportWidth = Math.max(0, toFiniteNumber(options.viewportWidth, 0));
  const viewportHeight = Math.max(0, toFiniteNumber(options.viewportHeight, 0));
  const previousViewportWidth = Math.max(0, toFiniteNumber(options.previousViewportWidth, 0));
  const previousViewportHeight = Math.max(0, toFiniteNumber(options.previousViewportHeight, 0));

  const scaleChanged = Math.abs(currentScale - previousScale) > scaleEpsilon;
  const widthChanged = hasViewportDelta(viewportWidth, previousViewportWidth, viewportEpsilonPx);
  const heightChanged = hasViewportDelta(viewportHeight, previousViewportHeight, viewportEpsilonPx);
  return scaleChanged || widthChanged || heightChanged;
}
