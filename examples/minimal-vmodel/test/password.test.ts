/**
 * パスワード ユニットテスト
 *
 * 由来要件: REQ-AUTH-03
 * 実装箇所: src/auth/password.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';

describe('password', () => {
  test('正常系: ハッシュは平文を含まず、bcrypt 形式である (REQ-AUTH-03)', async () => {
    const plain = 'Secret1234';
    const hash = await hashPassword(plain);
    assert.notEqual(hash, plain);
    assert.ok(!hash.includes(plain));
    assert.ok(hash.startsWith('$2'));
  });

  test('正常系: 正しい平文は検証に成功する (REQ-AUTH-03)', async () => {
    const hash = await hashPassword('Secret1234');
    assert.equal(await verifyPassword('Secret1234', hash), true);
  });

  test('異常系: 誤った平文は検証に失敗する (REQ-AUTH-03)', async () => {
    const hash = await hashPassword('Secret1234');
    assert.equal(await verifyPassword('Wrong1234', hash), false);
  });

  test('同じ平文でもソルトによりハッシュが異なる (REQ-AUTH-03)', async () => {
    const [a, b] = await Promise.all([hashPassword('Secret1234'), hashPassword('Secret1234')]);
    assert.notEqual(a, b);
  });

  test('bcrypt 形式として認識できる', async () => {
    const hash = await hashPassword('Secret1234');
    assert.equal(bcrypt.getRounds(hash), 10);
  });
});
