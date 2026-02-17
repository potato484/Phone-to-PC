import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccessTokenService } from '../../dist/auth.js';
import { C2PStore } from '../../dist/store.js';

test('AccessTokenService issues, verifies and revokes tokens', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'c2p-auth-'));
  const dbPath = path.join(tempDir, 'store.sqlite');
  const store = new C2PStore(dbPath);
  const tokenService = new AccessTokenService({
    store,
    signingSecret: 'test-signing-secret-for-unit-tests-0123456789',
    ttlSeconds: 3600
  });

  try {
    const issuedA = tokenService.issueAccessToken('unit-test');
    const issuedB = tokenService.issueAccessToken('unit-test');
    const readonly = tokenService.issueAccessToken('unit-test', 'readonly');

    assert.equal(issuedA.claims.exp - issuedA.claims.iat, 3600);
    assert.notEqual(issuedA.claims.jti, issuedB.claims.jti);

    const ok = tokenService.verifyAccessToken(issuedA.token);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.claims.scope, 'admin');
      assert.equal(ok.claims.jti, issuedA.claims.jti);
    }

    const readonlyCheck = tokenService.verifyAccessToken(readonly.token);
    assert.equal(readonlyCheck.ok, true);
    if (readonlyCheck.ok) {
      assert.equal(readonlyCheck.claims.scope, 'readonly');
    }

    const refreshed = tokenService.refreshAccessToken(readonly.token, 'unit-test');
    assert.equal(refreshed.ok, true);
    if (refreshed.ok) {
      assert.equal(refreshed.previousClaims.scope, 'readonly');
      assert.notEqual(refreshed.previousClaims.jti, refreshed.issued.claims.jti);
      assert.equal(refreshed.issued.claims.scope, 'readonly');
    }

    const readonlyAfterRefresh = tokenService.verifyAccessToken(readonly.token);
    assert.equal(readonlyAfterRefresh.ok, false);
    if (!readonlyAfterRefresh.ok) {
      assert.equal(readonlyAfterRefresh.code, 'revoked');
    }

    const tampered = `${issuedA.token.slice(0, -1)}x`;
    const tamperedResult = tokenService.verifyAccessToken(tampered);
    assert.equal(tamperedResult.ok, false);
    if (!tamperedResult.ok) {
      assert.equal(tamperedResult.code, 'signature_mismatch');
    }

    const revokeResult = tokenService.revokeAccessToken(issuedA.token, 'unit-test');
    assert.equal(revokeResult.ok, true);

    const revokedCheck = tokenService.verifyAccessToken(issuedA.token);
    assert.equal(revokedCheck.ok, false);
    if (!revokedCheck.ok) {
      assert.equal(revokedCheck.code, 'revoked');
    }
  } finally {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
