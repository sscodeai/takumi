/**
 * JWT トークン ユニットテスト
 *
 * 由来要件: REQ-AUTH-04
 * 実装箇所: src/auth/token.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenService } from '../src/auth/token.ts';
import type { AuthClaims } from '../src/domain/types.ts';

describe('token service', () => {
  const service = createTokenService('unit-test-secret', '1h');
  const claims: AuthClaims = { sub: 7, username: 'alice', role: 'admin' };

  test('正常系: sign/verify でクレームを復元する (REQ-AUTH-04)', () => {
    const token = service.sign(claims);
    assert.equal(typeof token, 'string');
    assert.deepEqual(service.verify(token), claims);
  });

  test('異常系: 異なる秘密鍵では検証できない (REQ-AUTH-04)', () => {
    const token = service.sign(claims);
    const other = createTokenService('another-secret', '1h');
    assert.throws(() => other.verify(token));
  });

  test('異常系: 不正なトークンでは検証できない (REQ-AUTH-04)', () => {
    assert.throws(() => service.verify('not-a-jwt'));
  });

  test('異常系: 期限切れトークンでは検証できない (REQ-AUTH-04)', async () => {
    const expired = createTokenService('unit-test-secret', '-1s');
    const token = expired.sign(claims);
    assert.throws(() => service.verify(token));
  });

  test('異常系: sub を持たないトークンは拒否する (REQ-AUTH-04)', () => {
    const t = createTokenService('unit-test-secret', '1h');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用に sub を省略
    const token = t.sign({ username: 'alice', role: 'admin' } as any);
    assert.throws(() => t.verify(token));
  });
});
