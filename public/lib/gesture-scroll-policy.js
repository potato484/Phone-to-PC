const DEFAULT_EDGE_EPSILON_PX = 0.5;
const DEFAULT_WRITE_EPSILON_PX = 0.5;

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveScrollerMetrics(scroller) {
  if (!scroller || typeof scroller !== 'object') {
    return {
      maxScrollLeft: 0,
      scrollLeft: 0
    };
  }
  const scrollWidth = Math.max(0, toFiniteNumber(scroller.scrollWidth, 0));
  const clientWidth = Math.max(0, toFiniteNumber(scroller.clientWidth, 0));
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const scrollLeft = clamp(toFiniteNumber(scroller.scrollLeft, 0), 0, maxScrollLeft);
  return {
    maxScrollLeft,
    scrollLeft
  };
}

export function computeHorizontalScrollUpdate(scroller, startScrollLeft, dx, options = {}) {
  const edgeEpsilonPx = Math.max(
    0,
    toFiniteNumber(options.edgeEpsilonPx, DEFAULT_EDGE_EPSILON_PX)
  );
  const writeEpsilonPx = Math.max(
    0,
    toFiniteNumber(options.writeEpsilonPx, DEFAULT_WRITE_EPSILON_PX)
  );
  const { maxScrollLeft, scrollLeft } = resolveScrollerMetrics(scroller);
  const baselineScrollLeft = clamp(
    toFiniteNumber(startScrollLeft, scrollLeft),
    0,
    maxScrollLeft
  );
  const nextScrollLeft = clamp(
    baselineScrollLeft - toFiniteNumber(dx, 0),
    0,
    maxScrollLeft
  );
  const canScroll = maxScrollLeft > edgeEpsilonPx;
  const shouldConsume = canScroll && Math.abs(nextScrollLeft - scrollLeft) > writeEpsilonPx;

  return {
    maxScrollLeft,
    scrollLeft,
    baselineScrollLeft,
    nextScrollLeft,
    canScroll,
    shouldConsume
  };
}

export function resolveDirectionLock({
  currentLock = '',
  absDx = 0,
  absDy = 0,
  thresholdPx = 0,
  hasHorizontalTarget = false,
  canConsumeHorizontal = false,
  horizontalIntentRatio = 1,
  verticalRecoverRatio = 1
}) {
  let nextLock = currentLock === 'x' || currentLock === 'y' ? currentLock : '';
  const safeAbsDx = Math.abs(toFiniteNumber(absDx, 0));
  const safeAbsDy = Math.abs(toFiniteNumber(absDy, 0));
  const safeThreshold = Math.max(0, toFiniteNumber(thresholdPx, 0));
  const safeHorizontalRatio = Math.max(1, toFiniteNumber(horizontalIntentRatio, 1));
  const safeVerticalRecoverRatio = Math.max(0, toFiniteNumber(verticalRecoverRatio, 1));

  if (!nextLock && (safeAbsDx >= safeThreshold || safeAbsDy >= safeThreshold)) {
    const preferHorizontal =
      hasHorizontalTarget &&
      canConsumeHorizontal &&
      safeAbsDx >= safeAbsDy * safeHorizontalRatio;
    nextLock = preferHorizontal ? 'x' : 'y';
  }

  if (nextLock === 'x') {
    const shouldRecoverVertical = safeAbsDy > safeAbsDx * safeVerticalRecoverRatio;
    if (!hasHorizontalTarget || !canConsumeHorizontal || shouldRecoverVertical) {
      nextLock = 'y';
    }
  }

  return nextLock;
}
