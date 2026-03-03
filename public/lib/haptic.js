const HAPTIC = {
  light: 8,
  medium: 15
};

export function vibrate(type) {
  const duration = HAPTIC[type];
  if (!duration || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return false;
  }
  try {
    return navigator.vibrate(duration);
  } catch {
    return false;
  }
}
