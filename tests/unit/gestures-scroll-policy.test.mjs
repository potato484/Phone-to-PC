import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeHorizontalScrollUpdate,
  resolveDirectionLock
} from '../../public/lib/gesture-scroll-policy.js';

function createScroller({ scrollWidth = 1000, clientWidth = 400, scrollLeft = 0 } = {}) {
  return {
    scrollWidth,
    clientWidth,
    scrollLeft
  };
}

test('computeHorizontalScrollUpdate consumes horizontal movement when scroller can move', () => {
  const scroller = createScroller();
  const update = computeHorizontalScrollUpdate(scroller, 0, -120);

  assert.equal(update.maxScrollLeft, 600);
  assert.equal(update.nextScrollLeft, 120);
  assert.equal(update.shouldConsume, true);
});

test('computeHorizontalScrollUpdate does not consume movement when pushing at boundary', () => {
  const scroller = createScroller({ scrollLeft: 600 });
  const update = computeHorizontalScrollUpdate(scroller, 0, -900);

  assert.equal(update.nextScrollLeft, 600);
  assert.equal(update.shouldConsume, false);
});

test('computeHorizontalScrollUpdate resumes consuming when user drags back from boundary', () => {
  const scroller = createScroller({ scrollLeft: 600 });
  const update = computeHorizontalScrollUpdate(scroller, 0, -500);

  assert.equal(update.nextScrollLeft, 500);
  assert.equal(update.shouldConsume, true);
});

test('computeHorizontalScrollUpdate does not consume when there is no horizontal overflow', () => {
  const scroller = createScroller({ scrollWidth: 480, clientWidth: 480, scrollLeft: 0 });
  const update = computeHorizontalScrollUpdate(scroller, 0, -200);

  assert.equal(update.maxScrollLeft, 0);
  assert.equal(update.shouldConsume, false);
});

test('resolveDirectionLock prefers vertical when horizontal cannot be consumed', () => {
  const directionLock = resolveDirectionLock({
    currentLock: '',
    absDx: 28,
    absDy: 6,
    thresholdPx: 8,
    hasHorizontalTarget: true,
    canConsumeHorizontal: false,
    horizontalIntentRatio: 1.35,
    verticalRecoverRatio: 1.15
  });

  assert.equal(directionLock, 'y');
});

test('resolveDirectionLock allows horizontal lock when horizontal movement is consumable', () => {
  const directionLock = resolveDirectionLock({
    currentLock: '',
    absDx: 28,
    absDy: 6,
    thresholdPx: 8,
    hasHorizontalTarget: true,
    canConsumeHorizontal: true,
    horizontalIntentRatio: 1.35,
    verticalRecoverRatio: 1.15
  });

  assert.equal(directionLock, 'x');
});

test('resolveDirectionLock recovers from horizontal to vertical when vertical intent dominates', () => {
  const directionLock = resolveDirectionLock({
    currentLock: 'x',
    absDx: 18,
    absDy: 26,
    thresholdPx: 8,
    hasHorizontalTarget: true,
    canConsumeHorizontal: true,
    horizontalIntentRatio: 1.35,
    verticalRecoverRatio: 1.15
  });

  assert.equal(directionLock, 'y');
});

test('resolveDirectionLock recovers from horizontal to vertical when horizontal movement is blocked', () => {
  const directionLock = resolveDirectionLock({
    currentLock: 'x',
    absDx: 24,
    absDy: 4,
    thresholdPx: 8,
    hasHorizontalTarget: true,
    canConsumeHorizontal: false,
    horizontalIntentRatio: 1.35,
    verticalRecoverRatio: 1.15
  });

  assert.equal(directionLock, 'y');
});
