import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  lockMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAt: number;
  locked: boolean;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
  lockUntil: number;
}

function normalizeRateLimitWindow(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1000, Math.floor(value));
}

function normalizeRateLimitMax(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeRateLimitLock(value: number | undefined): number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return 0;
  }
  return Math.floor(value as number);
}

export class MemoryRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly lockMs: number;
  private readonly buckets = new Map<string, RateLimitBucket>();
  private lastSweep = 0;

  constructor(options: RateLimitOptions) {
    this.windowMs = normalizeRateLimitWindow(options.windowMs, 60_000);
    this.max = normalizeRateLimitMax(options.max, 100);
    this.lockMs = normalizeRateLimitLock(options.lockMs);
  }

  hit(key: string): RateLimitResult {
    const now = Date.now();
    this.sweep(now);

    const normalizedKey = key || 'unknown';
    const existing = this.buckets.get(normalizedKey);
    const bucket: RateLimitBucket =
      existing && existing.resetAt > now
        ? existing
        : {
            count: 0,
            resetAt: now + this.windowMs,
            lockUntil: 0
          };

    if (bucket.lockUntil > now) {
      this.buckets.set(normalizedKey, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: bucket.lockUntil - now,
        resetAt: bucket.resetAt,
        locked: true
      };
    }

    bucket.count += 1;
    if (bucket.count > this.max) {
      if (this.lockMs > 0) {
        bucket.lockUntil = now + this.lockMs;
      }
      this.buckets.set(normalizedKey, bucket);
      const retryAfterMs = bucket.lockUntil > now ? bucket.lockUntil - now : bucket.resetAt - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, retryAfterMs),
        resetAt: bucket.resetAt,
        locked: bucket.lockUntil > now
      };
    }

    this.buckets.set(normalizedKey, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.max - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - now),
      resetAt: bucket.resetAt,
      locked: false
    };
  }

  peek(key: string): RateLimitResult {
    const now = Date.now();
    this.sweep(now);

    const normalizedKey = key || 'unknown';
    const bucket = this.buckets.get(normalizedKey);
    if (!bucket) {
      return {
        allowed: true,
        remaining: this.max,
        retryAfterMs: 0,
        resetAt: now + this.windowMs,
        locked: false
      };
    }

    if (bucket.lockUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: bucket.lockUntil - now,
        resetAt: bucket.resetAt,
        locked: true
      };
    }

    if (bucket.resetAt <= now) {
      return {
        allowed: true,
        remaining: this.max,
        retryAfterMs: 0,
        resetAt: now + this.windowMs,
        locked: false
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.max - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - now),
      resetAt: bucket.resetAt,
      locked: false
    };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) {
      return;
    }
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now && bucket.lockUntil <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

function parseCsvSet(rawValue: string | undefined): Set<string> {
  const output = new Set<string>();
  if (!rawValue) {
    return output;
  }
  for (const segment of rawValue.split(',')) {
    const item = segment.trim().toLowerCase();
    if (!item) {
      continue;
    }
    output.add(item);
  }
  return output;
}

function normalizeHost(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end >= 0) {
      return trimmed.slice(0, end + 1);
    }
    return trimmed;
  }
  const idx = trimmed.indexOf(':');
  if (idx >= 0) {
    return trimmed.slice(0, idx);
  }
  return trimmed;
}

function normalizeOrigin(rawOrigin: string): { origin: string; host: string } | null {
  try {
    const parsed = new URL(rawOrigin);
    return {
      origin: parsed.origin.toLowerCase(),
      host: normalizeHost(parsed.host)
    };
  } catch {
    return null;
  }
}

export interface OriginHostPolicy {
  enforceHosts: boolean;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  allowedOriginHosts: Set<string>;
  allowNoOrigin: boolean;
}

export function createOriginHostPolicyFromEnv(): OriginHostPolicy {
  const allowedHosts = parseCsvSet(process.env.C2P_ALLOWED_HOSTS);
  allowedHosts.add('localhost');
  allowedHosts.add('127.0.0.1');
  allowedHosts.add('[::1]');

  const allowedOrigins = new Set<string>();
  const allowedOriginHosts = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  for (const entry of parseCsvSet(process.env.C2P_ALLOWED_ORIGINS)) {
    if (entry.includes('://')) {
      const normalized = normalizeOrigin(entry);
      if (!normalized) {
        continue;
      }
      allowedOrigins.add(normalized.origin);
      allowedOriginHosts.add(normalized.host);
      continue;
    }
    allowedOriginHosts.add(normalizeHost(entry));
  }

  const allowNoOrigin = !/^(0|false|off|no)$/i.test((process.env.C2P_ALLOW_EMPTY_ORIGIN ?? '1').trim());

  return {
    enforceHosts: parseCsvSet(process.env.C2P_ALLOWED_HOSTS).size > 0,
    allowedHosts,
    allowedOrigins,
    allowedOriginHosts,
    allowNoOrigin
  };
}

export interface OriginHostCheckResult {
  ok: boolean;
  reason: string;
  host: string;
  origin: string;
}

export function checkOriginAndHost(req: IncomingMessage, policy: OriginHostPolicy): OriginHostCheckResult {
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';
  const host = normalizeHost(hostHeader);
  if (!host) {
    return {
      ok: false,
      reason: 'missing host',
      host: '',
      origin: ''
    };
  }

  if (policy.enforceHosts && !policy.allowedHosts.has(host)) {
    return {
      ok: false,
      reason: 'host not allowed',
      host,
      origin: ''
    };
  }

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!originHeader) {
    return {
      ok: policy.allowNoOrigin,
      reason: policy.allowNoOrigin ? 'ok' : 'origin required',
      host,
      origin: ''
    };
  }

  const origin = normalizeOrigin(originHeader);
  if (!origin) {
    return {
      ok: false,
      reason: 'invalid origin',
      host,
      origin: originHeader
    };
  }

  if (origin.host === host || policy.allowedOrigins.has(origin.origin) || policy.allowedOriginHosts.has(origin.host)) {
    return {
      ok: true,
      reason: 'ok',
      host,
      origin: origin.origin
    };
  }

  return {
    ok: false,
    reason: 'origin not allowed',
    host,
    origin: origin.origin
  };
}

export function getClientIp(req: IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    const first = forwardedFor[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createRateLimitMiddleware(
  limiter: MemoryRateLimiter,
  options: {
    key?: (req: Request) => string;
    message: string;
    statusCode?: number;
  }
) {
  const statusCode = Number.isFinite(options.statusCode) ? Number(options.statusCode) : 429;
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.key ? options.key(req) : getClientIp(req);
    const verdict = limiter.hit(key);
    if (verdict.allowed) {
      next();
      return;
    }

    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
    res.status(statusCode).json({
      error: options.message,
      retryAfterSec: Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))
    });
  };
}

export function createOriginHostMiddleware(policy: OriginHostPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = checkOriginAndHost(req, policy);
    if (!verdict.ok) {
      res.status(403).json({ error: 'forbidden origin/host', reason: verdict.reason });
      return;
    }
    next();
  };
}
