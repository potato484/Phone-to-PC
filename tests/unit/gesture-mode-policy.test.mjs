import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePinchScale,
  shouldAllowSingleFingerTerminalScroll,
  shouldApplyPinchScale
} from '../../public/lib/gesture-mode-policy.js';

test('shouldAllowSingleFingerTerminalScroll always allows single-finger scroll', () => {
  assert.equal(shouldAllowSingleFingerTerminalScroll(true), true);
  assert.equal(shouldAllowSingleFingerTerminalScroll(false), true);
  assert.equal(shouldAllowSingleFingerTerminalScroll(), true);
});

test('computePinchScale returns relative distance ratio', () => {
  assert.equal(computePinchScale(100, 150), 1.5);
});

test('computePinchScale returns default scale when distances are invalid', () => {
  assert.equal(computePinchScale(0, 150), 1);
  assert.equal(computePinchScale(100, Number.NaN), 1);
});

test('shouldApplyPinchScale returns true when scale delta and interval both satisfy threshold', () => {
  const shouldApply = shouldApplyPinchScale({
    scale: 1.2,
    lastScale: 1,
    nowMs: 120,
    lastAppliedAtMs: 0,
    scaleEpsilon: 0.015,
    minIntervalMs: 24
  });

  assert.equal(shouldApply, true);
});

test('shouldApplyPinchScale returns false when scale delta is below epsilon', () => {
  const shouldApply = shouldApplyPinchScale({
    scale: 1.01,
    lastScale: 1,
    nowMs: 120,
    lastAppliedAtMs: 0,
    scaleEpsilon: 0.015,
    minIntervalMs: 24
  });

  assert.equal(shouldApply, false);
});

test('shouldApplyPinchScale returns false when updates are too frequent', () => {
  const shouldApply = shouldApplyPinchScale({
    scale: 1.2,
    lastScale: 1,
    nowMs: 10,
    lastAppliedAtMs: 0,
    scaleEpsilon: 0.015,
    minIntervalMs: 24
  });

  assert.equal(shouldApply, false);
});
