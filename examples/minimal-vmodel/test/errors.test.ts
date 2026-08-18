/**
 * ドメイン例外クラス ユニットテスト
 *
 * 由来要件: REQ-VAL-05, REQ-VAL-06
 * 実装箇所: src/domain/errors.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../src/domain/errors.ts';

describe('domain errors', () => {
  test('各例外は HTTP ステータス・エラーコード・メッセージ・details を保持する (REQ-VAL-05)', () => {
    const cases: Array<[() => AppError, number, string]> = [
      [() => new BadRequestError(), 400, 'BAD_REQUEST'],
      [() => new AuthenticationError(), 401, 'UNAUTHORIZED'],
      [() => new AuthorizationError(), 403, 'FORBIDDEN'],
      [() => new NotFoundError(), 404, 'NOT_FOUND'],
      [() => new ConflictError(), 409, 'CONFLICT'],
      [() => new ValidationError(), 422, 'VALIDATION_ERROR'],
      [() => new InternalError(), 500, 'INTERNAL_ERROR'],
    ];

    for (const [factory, status, code] of cases) {
      const err = factory();
      assert.ok(err instanceof AppError);
      assert.ok(err instanceof Error);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      assert.equal(typeof err.message, 'string');
      assert.deepEqual(err.details, []);
    }
  });

  test('ValidationError は fieldErrors 相当の details を保持する (REQ-VAL-01)', () => {
    const err = new ValidationError('入力内容に誤りがあります', [
      { field: 'email', message: 'メールアドレスの形式が正しくありません。' },
    ]);
    assert.deepEqual(err.details, [{ field: 'email', message: 'メールアドレスの形式が正しくありません。' }]);
  });

  test('InternalError は cause を保持する (REQ-VAL-08)', () => {
    const cause = new Error('db down');
    const err = new InternalError('予期しないシステムエラーが発生しました', { cause });
    assert.equal(err.cause, cause);
    assert.equal(err.details.length, 0);
  });

  test('AppError は name を具象クラス名にする', () => {
    const err = new NotFoundError();
    assert.equal(err.name, 'NotFoundError');
  });
});
