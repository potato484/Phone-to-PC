import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { C2PStore, IssuedTokenRecord } from './store.js';

const BOOTSTRAP_TOKEN_FILE = '.auth-token';
const SIGNING_SECRET_FILE = '.auth-signing-secret';
const ACCESS_TOKEN_VERSION = 'v1';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface AccessTokenClaims {
  jti: string;
  iat: number;
  exp: number;
  scope: 'admin';
}

export interface AccessTokenIssueResult {
  token: string;
  claims: AccessTokenClaims;
  expiresAt: string;
}

export type AccessTokenVerifyFailureCode =
  | 'missing'
  | 'invalid_format'
  | 'invalid_payload'
  | 'signature_mismatch'
  | 'expired'
  | 'revoked';

export type AccessTokenVerifyResult =
  | {
      ok: true;
      claims: AccessTokenClaims;
      expiresAt: string;
    }
  | {
      ok: false;
      code: AccessTokenVerifyFailureCode;
    };

export interface AccessAuthContext {
  token: string;
  claims: AccessTokenClaims;
  expiresAt: string;
}

export interface AccessTokenServiceOptions {
  store: C2PStore;
  signingSecret: string;
  ttlSeconds?: number;
}

export interface AccessAuthMiddlewareHooks {
  onFailure?: (req: Request, reason: AccessTokenVerifyFailureCode | 'missing') => void;
  onSuccess?: (req: Request, context: AccessAuthContext) => void;
}

function isBootstrapTokenFormat(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function createSignature(payloadBase64Url: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret).update(payloadBase64Url).digest('base64url');
}

function extractBearerToken(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const prefix = 'bearer ';
  if (value.toLowerCase().startsWith(prefix)) {
    const token = value.slice(prefix.length).trim();
    return token || null;
  }
  return null;
}

function createJti(): string {
  return randomBytes(16).toString('hex');
}

function normalizeTtlSeconds(input: number | undefined): number {
  if (!Number.isFinite(input)) {
    return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  }
  return Math.max(60, Math.min(Math.trunc(input as number), 7 * 24 * 60 * 60));
}

export function tokenFilePath(baseDir = process.cwd()): string {
  return path.resolve(baseDir, BOOTSTRAP_TOKEN_FILE);
}

export function signingSecretFilePath(baseDir = process.cwd()): string {
  return path.resolve(baseDir, SIGNING_SECRET_FILE);
}

export function ensureAuthToken(baseDir = process.cwd()): string {
  const filePath = tokenFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    const token = fs.readFileSync(filePath, 'utf8').trim();
    if (!isBootstrapTokenFormat(token)) {
      throw new Error(`Invalid bootstrap token format in ${filePath}`);
    }
    return token;
  }

  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(filePath, `${token}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return token;
}

export function ensureAccessSigningSecret(baseDir = process.cwd()): string {
  const filePath = signingSecretFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    const secret = fs.readFileSync(filePath, 'utf8').trim();
    if (secret.length < 32) {
      throw new Error(`Invalid signing secret format in ${filePath}`);
    }
    return secret;
  }

  const secret = randomBytes(48).toString('base64url');
  fs.writeFileSync(filePath, `${secret}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return secret;
}

export class AccessTokenService {
  private readonly store: C2PStore;
  private readonly signingSecret: string;
  private readonly ttlSeconds: number;

  constructor(options: AccessTokenServiceOptions) {
    this.store = options.store;
    this.signingSecret = options.signingSecret;
    this.ttlSeconds = normalizeTtlSeconds(options.ttlSeconds);
  }

  getAccessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }

  issueAccessToken(actor: string): AccessTokenIssueResult {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: AccessTokenClaims = {
      jti: createJti(),
      iat: nowSec,
      exp: nowSec + this.ttlSeconds,
      scope: 'admin'
    };

    const payloadBase64Url = base64UrlEncode(JSON.stringify(claims));
    const signature = createSignature(payloadBase64Url, this.signingSecret);
    const token = `${ACCESS_TOKEN_VERSION}.${payloadBase64Url}.${signature}`;

    const record: IssuedTokenRecord = {
      jti: claims.jti,
      scope: claims.scope,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      actor
    };
    this.store.recordIssuedToken(record);

    return {
      token,
      claims,
      expiresAt: record.expiresAt
    };
  }

  verifyAccessToken(token: string): AccessTokenVerifyResult {
    if (!token) {
      return { ok: false, code: 'missing' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { ok: false, code: 'invalid_format' };
    }

    const [version, payloadBase64Url, signature] = parts;
    if (version !== ACCESS_TOKEN_VERSION || !payloadBase64Url || !signature) {
      return { ok: false, code: 'invalid_format' };
    }

    const expectedSignature = createSignature(payloadBase64Url, this.signingSecret);
    if (!secureEqual(signature, expectedSignature)) {
      return { ok: false, code: 'signature_mismatch' };
    }

    let claims: AccessTokenClaims;
    try {
      const parsed = JSON.parse(base64UrlDecode(payloadBase64Url)) as Partial<AccessTokenClaims>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.jti !== 'string' ||
        !Number.isFinite(parsed.iat) ||
        !Number.isFinite(parsed.exp) ||
        parsed.scope !== 'admin'
      ) {
        return { ok: false, code: 'invalid_payload' };
      }
      claims = {
        jti: parsed.jti,
        iat: Math.trunc(parsed.iat as number),
        exp: Math.trunc(parsed.exp as number),
        scope: 'admin'
      };
    } catch {
      return { ok: false, code: 'invalid_payload' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSec) {
      return { ok: false, code: 'expired' };
    }

    if (this.store.isTokenRevoked(claims.jti)) {
      return { ok: false, code: 'revoked' };
    }

    return {
      ok: true,
      claims,
      expiresAt: new Date(claims.exp * 1000).toISOString()
    };
  }

  revokeAccessToken(token: string, reason = ''): AccessTokenVerifyResult {
    const result = this.verifyAccessToken(token);
    if (!result.ok) {
      return result;
    }
    this.store.revokeToken(result.claims.jti, reason);
    return result;
  }
}

export function readBearerTokenFromRequest(req: Request): string | null {
  return extractBearerToken(req.headers.authorization);
}

export function readBootstrapTokenFromRequest(req: Request): string | null {
  return extractBearerToken(req.headers.authorization);
}

export function createAccessAuthMiddleware(
  accessTokenService: AccessTokenService,
  hooks: AccessAuthMiddlewareHooks = {}
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearerTokenFromRequest(req);
    if (!token) {
      hooks.onFailure?.(req, 'missing');
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }

    const verdict = accessTokenService.verifyAccessToken(token);
    if (!verdict.ok) {
      hooks.onFailure?.(req, verdict.code);
      res.status(401).json({ error: 'unauthorized', reason: verdict.code });
      return;
    }

    const authContext: AccessAuthContext = {
      token,
      claims: verdict.claims,
      expiresAt: verdict.expiresAt
    };
    res.locals.auth = authContext;
    hooks.onSuccess?.(req, authContext);
    next();
  };
}

export function validateBootstrapToken(candidate: string | null, bootstrapToken: string): boolean {
  if (!candidate) {
    return false;
  }
  return secureEqual(candidate, bootstrapToken);
}

export function getRemoteAddress(req: Request): string {
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
  if (req.ip) {
    return req.ip;
  }
  return req.socket.remoteAddress || 'unknown';
}
