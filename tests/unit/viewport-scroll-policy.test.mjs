import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampScrollDeltaToRemaining,
  shouldAutoAlignKeyboardViewport
} from '../../public/lib/viewport-scroll-policy.js';

test('clampScrollDeltaToRemaining returns zero when already at bottom', () => {
  const clamped = clampScrollDeltaToRemaining(96, {
    scrollTop: 900,
    scrollHeight: 1200,
    clientHeight: 300
  });

  assert.equal(clamped, 0);
});

test('clampScrollDeltaToRemaining clamps to remaining scroll distance', () => {
  const clamped = clampScrollDeltaToRemaining(120, {
    scrollTop: 640,
    scrollHeight: 1200,
    clientHeight: 500
  });

  assert.equal(clamped, 60);
});

test('clampScrollDeltaToRemaining keeps original delta when enough room exists', () => {
  const clamped = clampScrollDeltaToRemaining(80, {
    scrollTop: 120,
    scrollHeight: 1200,
    clientHeight: 500
  });

  assert.equal(clamped, 80);
});

test('shouldAutoAlignKeyboardViewport aligns when keyboard visibility changes', () => {
  const shouldAlign = shouldAutoAlignKeyboardViewport({
    keyboardVisible: true,
    keyboardChanged: true,
    reason: 'viewport-resize',
    activeScope: 'other',
    lastAlignedScope: 'terminal'
  });

  assert.equal(shouldAlign, true);
});

test('shouldAutoAlignKeyboardViewport aligns once when focus enters a new keyboard scope', () => {
  const shouldAlign = shouldAutoAlignKeyboardViewport({
    keyboardVisible: true,
    keyboardChanged: false,
    reason: 'focusin',
    activeScope: 'terminal',
    lastAlignedScope: 'dock-input'
  });

  assert.equal(shouldAlign, true);
});

test('shouldAutoAlignKeyboardViewport does not align repeatedly for same focus scope', () => {
  const shouldAlign = shouldAutoAlignKeyboardViewport({
    keyboardVisible: true,
    keyboardChanged: false,
    reason: 'focusin',
    activeScope: 'terminal',
    lastAlignedScope: 'terminal'
  });

  assert.equal(shouldAlign, false);
});

test('shouldAutoAlignKeyboardViewport skips alignment for non-focus events', () => {
  const shouldAlign = shouldAutoAlignKeyboardViewport({
    keyboardVisible: true,
    keyboardChanged: false,
    reason: 'pointerup',
    activeScope: 'terminal',
    lastAlignedScope: 'dock-input'
  });

  assert.equal(shouldAlign, false);
});
