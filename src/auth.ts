import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

const TOKEN_FILE = '.auth-token';

function isTokenFormat(value: string): boolean {
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

function extractToken(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

export function tokenFilePath(baseDir = process.cwd()): string {
  return path.resolve(baseDir, TOKEN_FILE);
}

export function ensureAuthToken(baseDir = process.cwd()): string {
  const filePath = tokenFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    const token = fs.readFileSync(filePath, 'utf8').trim();
    if (!isTokenFormat(token)) {
      throw new Error(`Invalid token format in ${filePath}`);
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

export function tokenFromRequest(req: Request): string | undefined {
  const fromQuery = extractToken(req.query.token);
  if (fromQuery) {
    return fromQuery;
  }

  const headerToken = extractToken(req.headers['x-auth-token']);
  if (headerToken) {
    return headerToken;
  }

  const authHeader = extractToken(req.headers.authorization);
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length).trim();
  }

  return undefined;
}

export function createAuthMiddleware(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = tokenFromRequest(req);
    if (!token || !secureEqual(token, expectedToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export function validateUpgradeToken(req: IncomingMessage, expectedToken: string): boolean {
  const host = req.headers.host ?? 'localhost';
  const parsed = new URL(req.url ?? '/', `http://${host}`);
  const token = parsed.searchParams.get('token');
  if (!token) {
    return false;
  }
  return secureEqual(token, expectedToken);
}
