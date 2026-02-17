export const PREF_THEME_KEY = 'c2p_pref_theme';
export const PREF_CONTRAST_KEY = 'c2p_pref_contrast';
export const PREF_MOTION_KEY = 'c2p_pref_motion';
export const PREF_TRANSPARENCY_KEY = 'c2p_pref_transparency';

export const THEME_PREF_VALUES = ['system', 'dark', 'light'];
export const CONTRAST_PREF_VALUES = ['system', 'more', 'normal'];
export const MOTION_PREF_VALUES = ['system', 'reduce', 'normal'];
export const TRANSPARENCY_PREF_VALUES = ['normal', 'reduce'];

function normalizeEnum(value, allowed, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return fallback;
  }
  return allowed.includes(text) ? text : fallback;
}

export function normalizeThemePreference(value) {
  return normalizeEnum(value, THEME_PREF_VALUES, 'system');
}

export function normalizeContrastPreference(value) {
  return normalizeEnum(value, CONTRAST_PREF_VALUES, 'system');
}

export function normalizeMotionPreference(value) {
  return normalizeEnum(value, MOTION_PREF_VALUES, 'system');
}

export function normalizeTransparencyPreference(value) {
  return normalizeEnum(value, TRANSPARENCY_PREF_VALUES, 'normal');
}

export function readPreferencesFromStorage(storage) {
  const safeStorage =
    storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
  const get = (key) => {
    if (!safeStorage) {
      return '';
    }
    try {
      return safeStorage.getItem(key) || '';
    } catch {
      return '';
    }
  };

  return {
    theme: normalizeThemePreference(get(PREF_THEME_KEY)),
    contrast: normalizeContrastPreference(get(PREF_CONTRAST_KEY)),
    motion: normalizeMotionPreference(get(PREF_MOTION_KEY)),
    transparency: normalizeTransparencyPreference(get(PREF_TRANSPARENCY_KEY))
  };
}

export function writePreferenceToStorage(storage, key, value) {
  const safeStorage = storage && typeof storage.setItem === 'function' ? storage : null;
  if (!safeStorage) {
    return;
  }
  try {
    safeStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

export function applyPreferencesToRoot(root, preferences) {
  const safeRoot = root && typeof root.setAttribute === 'function' ? root : null;
  if (!safeRoot) {
    return;
  }

  const theme = preferences ? preferences.theme : 'system';
  if (theme === 'dark' || theme === 'light') {
    safeRoot.setAttribute('data-theme', theme);
  } else {
    safeRoot.removeAttribute('data-theme');
  }

  const contrast = preferences ? preferences.contrast : 'system';
  if (contrast === 'more' || contrast === 'normal') {
    safeRoot.setAttribute('data-contrast', contrast);
  } else {
    safeRoot.removeAttribute('data-contrast');
  }

  const motion = preferences ? preferences.motion : 'system';
  if (motion === 'reduce' || motion === 'normal') {
    safeRoot.setAttribute('data-motion', motion);
  } else {
    safeRoot.removeAttribute('data-motion');
  }

  const transparency = preferences ? preferences.transparency : 'normal';
  if (transparency === 'reduce') {
    safeRoot.setAttribute('data-transparency', 'reduce');
  } else {
    safeRoot.removeAttribute('data-transparency');
  }
}

function scheduleMetaThemeColorSync(metaEl, root) {
  if (!metaEl || !root || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return;
  }

  window.requestAnimationFrame(() => {
    try {
      const bg = window.getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) {
        metaEl.setAttribute('content', bg);
      }
    } catch {
      // ignore computed-style failures
    }
  });
}

export function createThemeManager({ getTelemetry } = {}) {
  const hasDocument = typeof document !== 'undefined';
  const root = hasDocument ? document.documentElement : null;
  const metaThemeColor = hasDocument ? document.querySelector('meta[name="theme-color"]') : null;
  const storage = typeof window !== 'undefined' ? window.localStorage : null;

  let preferences = readPreferencesFromStorage(storage);
  let mqlTheme = null;
  let mqlContrast = null;
  let mqlMotion = null;
  let systemChangeHandler = null;

  function track(name, payload) {
    if (typeof getTelemetry !== 'function') {
      return;
    }
    const telemetry = getTelemetry();
    if (!telemetry || typeof telemetry.track !== 'function') {
      return;
    }
    telemetry.track(name, payload || {});
  }

  function syncMetaThemeColor() {
    scheduleMetaThemeColorSync(metaThemeColor, root);
  }

  function apply() {
    applyPreferencesToRoot(root, preferences);
    syncMetaThemeColor();
  }

  function setPreferences(next) {
    preferences = {
      theme: normalizeThemePreference(next && next.theme),
      contrast: normalizeContrastPreference(next && next.contrast),
      motion: normalizeMotionPreference(next && next.motion),
      transparency: normalizeTransparencyPreference(next && next.transparency)
    };
  }

  function setPreference(kind, value) {
    const next = { ...preferences };
    if (kind === 'theme') {
      next.theme = normalizeThemePreference(value);
      writePreferenceToStorage(storage, PREF_THEME_KEY, next.theme);
    } else if (kind === 'contrast') {
      next.contrast = normalizeContrastPreference(value);
      writePreferenceToStorage(storage, PREF_CONTRAST_KEY, next.contrast);
      track('ui.contrast_more_enabled', {
        enabled: next.contrast === 'more',
        preference: next.contrast
      });
    } else if (kind === 'motion') {
      next.motion = normalizeMotionPreference(value);
      writePreferenceToStorage(storage, PREF_MOTION_KEY, next.motion);
      track('ui.motion_reduce_enabled', {
        enabled: next.motion === 'reduce',
        preference: next.motion
      });
    } else if (kind === 'transparency') {
      next.transparency = normalizeTransparencyPreference(value);
      writePreferenceToStorage(storage, PREF_TRANSPARENCY_KEY, next.transparency);
      track('ui.transparency_reduce_enabled', {
        enabled: next.transparency === 'reduce',
        preference: next.transparency
      });
    } else {
      return;
    }
    setPreferences(next);
    apply();
  }

  function bindSelect(selectEl, kind) {
    if (!selectEl || typeof selectEl.addEventListener !== 'function') {
      return;
    }

    selectEl.value = preferences[kind];
    selectEl.addEventListener('change', () => {
      setPreference(kind, selectEl.value);
    });
  }

  function bindMediaListeners() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const listen = (mql, handler) => {
      if (!mql || typeof mql.addEventListener !== 'function') {
        return;
      }
      mql.addEventListener('change', handler);
    };

    mqlTheme = window.matchMedia('(prefers-color-scheme: light)');
    mqlContrast = window.matchMedia('(prefers-contrast: more)');
    mqlMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    systemChangeHandler = () => {
      if (
        preferences.theme === 'system' ||
        preferences.contrast === 'system' ||
        preferences.motion === 'system'
      ) {
        syncMetaThemeColor();
      }
    };

    listen(mqlTheme, systemChangeHandler);
    listen(mqlContrast, systemChangeHandler);
    listen(mqlMotion, systemChangeHandler);
  }

  function unbindMediaListeners() {
    const unlisten = (mql, handler) => {
      if (!mql || typeof mql.removeEventListener !== 'function') {
        return;
      }
      mql.removeEventListener('change', handler);
    };

    if (systemChangeHandler) {
      unlisten(mqlTheme, systemChangeHandler);
      unlisten(mqlContrast, systemChangeHandler);
      unlisten(mqlMotion, systemChangeHandler);
    }
    mqlTheme = null;
    mqlContrast = null;
    mqlMotion = null;
    systemChangeHandler = null;
  }

  return {
    init() {
      setPreferences(readPreferencesFromStorage(storage));
      apply();
      bindMediaListeners();
    },
    destroy() {
      unbindMediaListeners();
    },
    bindControls({ themeSelect, contrastSelect, motionSelect, transparencySelect } = {}) {
      bindSelect(themeSelect, 'theme');
      bindSelect(contrastSelect, 'contrast');
      bindSelect(motionSelect, 'motion');
      bindSelect(transparencySelect, 'transparency');
    },
    getPreferences() {
      return { ...preferences };
    },
    setPreference
  };
}
