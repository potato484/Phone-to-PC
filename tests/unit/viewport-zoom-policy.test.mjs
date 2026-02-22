import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldScheduleZoomResize } from '../../public/lib/viewport-zoom-policy.js';

test('shouldScheduleZoomResize returns true when scale changes beyond epsilon', () => {
  const shouldResize = shouldScheduleZoomResize({
    currentScale: 1.24,
    previousScale: 1,
    viewportWidth: 880,
    viewportHeight: 1720,
    previousViewportWidth: 1080,
    previousViewportHeight: 1920
  });

  assert.equal(shouldResize, true);
});

test('shouldScheduleZoomResize returns false when scale and viewport deltas are within tolerance', () => {
  const shouldResize = shouldScheduleZoomResize({
    currentScale: 1.009,
    previousScale: 1,
    viewportWidth: 1080,
    viewportHeight: 1920,
    previousViewportWidth: 1080,
    previousViewportHeight: 1920,
    scaleEpsilon: 0.02
  });

  assert.equal(shouldResize, false);
});

test('shouldScheduleZoomResize returns true when viewport size changes even if scale delta is small', () => {
  const shouldResize = shouldScheduleZoomResize({
    currentScale: 1.01,
    previousScale: 1,
    viewportWidth: 1040,
    viewportHeight: 1920,
    previousViewportWidth: 1080,
    previousViewportHeight: 1920,
    scaleEpsilon: 0.02
  });

  assert.equal(shouldResize, true);
});

test('shouldScheduleZoomResize returns true when there is no previous viewport sample', () => {
  const shouldResize = shouldScheduleZoomResize({
    currentScale: 1,
    previousScale: 1,
    viewportWidth: 1080,
    viewportHeight: 1920,
    previousViewportWidth: 0,
    previousViewportHeight: 0
  });

  assert.equal(shouldResize, true);
});

test('shouldScheduleZoomResize ignores invalid numeric inputs', () => {
  const shouldResize = shouldScheduleZoomResize({
    currentScale: 'not-a-number',
    previousScale: 1,
    viewportWidth: '1080',
    viewportHeight: 1920,
    previousViewportWidth: 1080,
    previousViewportHeight: 1920
  });

  assert.equal(shouldResize, false);
});
