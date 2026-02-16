export type DesktopQualityProfile = 'low' | 'balanced' | 'high';

export interface DesktopQualityPolicy {
  profile: DesktopQualityProfile;
  backpressureHighBytes: number;
  backpressureLowBytes: number;
  drainCheckMs: number;
  connectTimeoutMs: number;
}

const DEFAULT_DESKTOP_QUALITY_PROFILE: DesktopQualityProfile = 'balanced';

const QUALITY_POLICIES: Record<DesktopQualityProfile, DesktopQualityPolicy> = {
  low: {
    profile: 'low',
    backpressureHighBytes: 512 * 1024,
    backpressureLowBytes: 128 * 1024,
    drainCheckMs: 8,
    connectTimeoutMs: 5_000
  },
  balanced: {
    profile: 'balanced',
    backpressureHighBytes: 1024 * 1024,
    backpressureLowBytes: 256 * 1024,
    drainCheckMs: 16,
    connectTimeoutMs: 6_000
  },
  high: {
    profile: 'high',
    backpressureHighBytes: 2 * 1024 * 1024,
    backpressureLowBytes: 512 * 1024,
    drainCheckMs: 24,
    connectTimeoutMs: 8_000
  }
};

function clonePolicy(policy: DesktopQualityPolicy): DesktopQualityPolicy {
  return { ...policy };
}

export function parseDesktopQualityProfile(value: string | null | undefined): DesktopQualityProfile {
  if (value === 'low' || value === 'balanced' || value === 'high') {
    return value;
  }
  return DEFAULT_DESKTOP_QUALITY_PROFILE;
}

export function getDesktopQualityPolicy(profile: DesktopQualityProfile): DesktopQualityPolicy {
  return clonePolicy(QUALITY_POLICIES[profile]);
}

export function resolveDesktopQualityPolicy(value: string | null | undefined): DesktopQualityPolicy {
  return getDesktopQualityPolicy(parseDesktopQualityProfile(value));
}

export function listDesktopQualityPolicies(): DesktopQualityPolicy[] {
  return [
    clonePolicy(QUALITY_POLICIES.low),
    clonePolicy(QUALITY_POLICIES.balanced),
    clonePolicy(QUALITY_POLICIES.high)
  ];
}
