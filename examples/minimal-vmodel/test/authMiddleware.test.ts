/**
 * 認証・認可ミドルウェア ユニットテスト
 *
 * 由来要件: REQ-AUTH-04, REQ-RBAC-02, REQ-RBAC-05
 * 実装箇所: src/middleware/authMiddleware.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMiddleware, requireRoles } from '../src/middleware/authMiddleware.ts';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware.ts';
import { createTokenService } from '../src/auth/token.ts';
import { AuthenticationError, AuthorizationError } from '../src/domain/errors.ts';

const tokens = createTokenService('middleware-secret', '1h');

interface NextState {
  error?: unknown;
  called: boolean;
}

function fakeNext() {
  const state: NextState = { called: false };
  const next = (err?: unknown) => {
    state.error = err;
    state.called = true;
  };
  return Object.assign(next, { state });
}

describe('createAuthMiddleware', () => {
  test('正常系: Bearer トークンから認証済みクレームを付与する (REQ-AUTH-04)', () => {
    const middleware = createAuthMiddleware(tokens);
    const req = { headers: { authorization: `Bearer ${tokens.sign({ sub: 1, username: 'admin', role: 'admin' })}` } } as AuthenticatedRequest;
    const next = fakeNext();
    middleware(req, {} as never, next as never);
    assert.equal(next.state.called, true);
    assert.equal(next.state.error, undefined);
    assert.deepEqual(req.auth, { sub: 1, username: 'admin', role: 'admin' });
  });

  test('異常系: ヘッダー未指定は 401 (REQ-AUTH-04)', () => {
    const middleware = createAuthMiddleware(tokens);
    const req = { headers: {} } as AuthenticatedRequest;
    const next = fakeNext();
    middleware(req, {} as never, next as never);
    assert.ok(next.state.error instanceof AuthenticationError);
    assert.equal((next.state.error as AuthenticationError).status, 401);
  });

  test('異常系: Bearer スキーム以外は 401 (REQ-AUTH-04)', () => {
    const middleware = createAuthMiddleware(tokens);
    const req = { headers: { authorization: `Basic ${tokens.sign({ sub: 1, username: 'x', role: 'member' })}` } } as AuthenticatedRequest;
    const next = fakeNext();
    middleware(req, {} as never, next as never);
    assert.ok(next.state.error instanceof AuthenticationError);
  });

  test('異常系: 不正トークンは 401 (REQ-AUTH-04)', () => {
    const middleware = createAuthMiddleware(tokens);
    const req = { headers: { authorization: 'Bearer not-a-token' } } as AuthenticatedRequest;
    const next = fakeNext();
    middleware(req, {} as never, next as never);
    assert.ok(next.state.error instanceof AuthenticationError);
    assert.equal((next.state.error as AuthenticationError).message, '認証情報が無効です');
  });
});

describe('requireRoles', () => {
  test('正常系: 許可されたロールは next() を通す (REQ-RBAC-02)', () => {
    const guard = requireRoles('admin', 'manager');
    const req = { auth: { sub: 1, username: 'x', role: 'admin' as const } } as AuthenticatedRequest;
    const next = fakeNext();
    guard(req, {} as never, next as never);
    assert.equal(next.state.called, true);
    assert.equal(next.state.error, undefined);
  });

  test('異常系: 未認証は 401 (REQ-AUTH-04)', () => {
    const guard = requireRoles('admin');
    const req = {} as AuthenticatedRequest;
    const next = fakeNext();
    guard(req, {} as never, next as never);
    assert.ok(next.state.error instanceof AuthenticationError);
  });

  test('異常系: 許可されないロールは 403 (REQ-RBAC-02)', () => {
    const guard = requireRoles('admin');
    const req = { auth: { sub: 3, username: 'm', role: 'member' as const } } as AuthenticatedRequest;
    const next = fakeNext();
    guard(req, {} as never, next as never);
    assert.ok(next.state.error instanceof AuthorizationError);
    assert.equal((next.state.error as AuthorizationError).status, 403);
  });
});
