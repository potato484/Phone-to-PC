import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDesktopQualityPolicy,
  listDesktopQualityPolicies,
  parseDesktopQualityProfile,
  resolveDesktopQualityPolicy
} from '../../dist/ws/desktop-quality.js';

test('desktop quality policy defaults and threshold ordering are stable', () => {
  assert.equal(parseDesktopQualityProfile(undefined), 'balanced');
  assert.equal(parseDesktopQualityProfile('invalid'), 'balanced');
  assert.equal(parseDesktopQualityProfile('low'), 'low');
  assert.equal(parseDesktopQualityProfile('high'), 'high');

  const low = getDesktopQualityPolicy('low');
  const balanced = resolveDesktopQualityPolicy('balanced');
  const high = resolveDesktopQualityPolicy('high');

  assert.ok(low.backpressureHighBytes < balanced.backpressureHighBytes);
  assert.ok(balanced.backpressureHighBytes < high.backpressureHighBytes);
  assert.ok(low.connectTimeoutMs < balanced.connectTimeoutMs);
  assert.ok(balanced.connectTimeoutMs < high.connectTimeoutMs);
  assert.ok(low.drainCheckMs < high.drainCheckMs);
});

test('desktop quality policy list is immutable by callers', () => {
  const first = listDesktopQualityPolicies();
  assert.equal(first.length, 3);
  first[0].backpressureHighBytes = 1;

  const second = listDesktopQualityPolicies();
  assert.notEqual(second[0].backpressureHighBytes, 1);
});
