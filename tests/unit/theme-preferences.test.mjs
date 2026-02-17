import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPreferencesToRoot,
  normalizeContrastPreference,
  normalizeMotionPreference,
  normalizeThemePreference,
  normalizeTransparencyPreference,
  readPreferencesFromStorage
} from '../../public/lib/theme.js';

function createFakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    }
  };
}

function createFakeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    }
  };
}

test('normalizeThemePreference accepts system/dark/light', () => {
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('  dark  '), 'dark');
  assert.equal(normalizeThemePreference('unknown'), 'system');
  assert.equal(normalizeThemePreference(''), 'system');
});

test('normalizeContrastPreference accepts system/more/normal', () => {
  assert.equal(normalizeContrastPreference('system'), 'system');
  assert.equal(normalizeContrastPreference('more'), 'more');
  assert.equal(normalizeContrastPreference('normal'), 'normal');
  assert.equal(normalizeContrastPreference('x'), 'system');
});

test('normalizeMotionPreference accepts system/reduce/normal', () => {
  assert.equal(normalizeMotionPreference('system'), 'system');
  assert.equal(normalizeMotionPreference('reduce'), 'reduce');
  assert.equal(normalizeMotionPreference('normal'), 'normal');
  assert.equal(normalizeMotionPreference('x'), 'system');
});

test('normalizeTransparencyPreference accepts normal/reduce', () => {
  assert.equal(normalizeTransparencyPreference('normal'), 'normal');
  assert.equal(normalizeTransparencyPreference('reduce'), 'reduce');
  assert.equal(normalizeTransparencyPreference('system'), 'normal');
});

test('readPreferencesFromStorage falls back to defaults', () => {
  const prefs = readPreferencesFromStorage(createFakeStorage({}));
  assert.deepEqual(prefs, {
    theme: 'system',
    contrast: 'system',
    motion: 'system',
    transparency: 'normal'
  });
});

test('applyPreferencesToRoot sets and removes data attributes', () => {
  const root = createFakeRoot();

  applyPreferencesToRoot(root, {
    theme: 'system',
    contrast: 'system',
    motion: 'system',
    transparency: 'normal'
  });
  assert.equal(root.attrs.has('data-theme'), false);
  assert.equal(root.attrs.has('data-contrast'), false);
  assert.equal(root.attrs.has('data-motion'), false);
  assert.equal(root.attrs.has('data-transparency'), false);

  applyPreferencesToRoot(root, {
    theme: 'dark',
    contrast: 'more',
    motion: 'reduce',
    transparency: 'reduce'
  });
  assert.equal(root.attrs.get('data-theme'), 'dark');
  assert.equal(root.attrs.get('data-contrast'), 'more');
  assert.equal(root.attrs.get('data-motion'), 'reduce');
  assert.equal(root.attrs.get('data-transparency'), 'reduce');

  applyPreferencesToRoot(root, {
    theme: 'light',
    contrast: 'normal',
    motion: 'normal',
    transparency: 'normal'
  });
  assert.equal(root.attrs.get('data-theme'), 'light');
  assert.equal(root.attrs.get('data-contrast'), 'normal');
  assert.equal(root.attrs.get('data-motion'), 'normal');
  assert.equal(root.attrs.has('data-transparency'), false);
});

