const MOBILE_SCROLLBACK_LOW_MEMORY = 8000;
const MOBILE_SCROLLBACK_DEFAULT = 12000;
const MOBILE_SCROLLBACK_HIGH_MEMORY = 20000;
const LOW_MEMORY_DEVICE_GB = 3;
const HIGH_MEMORY_DEVICE_GB = 8;

function toFinitePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return parsed;
}

export function resolveMobileTerminalScrollback(deviceMemory) {
  const safeDeviceMemory = toFinitePositiveNumber(deviceMemory);
  if (Number.isFinite(safeDeviceMemory)) {
    if (safeDeviceMemory <= LOW_MEMORY_DEVICE_GB) {
      return MOBILE_SCROLLBACK_LOW_MEMORY;
    }
    if (safeDeviceMemory >= HIGH_MEMORY_DEVICE_GB) {
      return MOBILE_SCROLLBACK_HIGH_MEMORY;
    }
  }
  return MOBILE_SCROLLBACK_DEFAULT;
}
