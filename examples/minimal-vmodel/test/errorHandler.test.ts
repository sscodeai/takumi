/**
 * グローバル例外ハンドラ ユニットテスト
 *
 * 由来要件: REQ-VAL-05, REQ-VAL-06, REQ-VAL-08
 * 実装箇所: src/middleware/errorHandler.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorHandler } from '../src/middleware/errorHandler.ts';
import { AuthenticationError, BadRequestError, InternalError, NotFoundError } from '../src/domain/errors.ts';
import type { Request, Response } from 'express';

function mockRes() {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

const req = {
  method: 'POST',
  originalUrl: '/api/employees',
  headers: {},
} as Request;

describe('createErrorHandler', () => {
  test('AppError は対応する status/code/message/details を返す (REQ-VAL-05,06)', () => {
    const logCalls: Array<[string, unknown, Request]> = [];
    const handler = createErrorHandler((traceId, err, req) => logCalls.push([traceId, err, req]));
    const { res, state } = mockRes();
    const err = new BadRequestError('リクエスト形式が不正です', [{ field: 'id', message: '不正' }]);

    handler(err, req, res, () => {});

    assert.equal(state.status, 400);
    const body = state.body as { error: { code: string; message: string; details: unknown; traceId: string } };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(body.error.message, 'リクエスト形式が不正です');
    assert.deepEqual(body.error.details, [{ field: 'id', message: '不正' }]);
    assert.equal(typeof body.error.traceId, 'string');
    assert.equal(logCalls.length, 1);
  });

  test('JSON parse エラーは 400 に変換する (REQ-VAL-06)', () => {
    const handler = createErrorHandler(() => {});
    const { res, state } = mockRes();
    const err = Object.assign(new Error('invalid json'), { type: 'entity.parse.failed' });
    handler(err, req, res, () => {});
    assert.equal(state.status, 400);
    assert.equal((state.body as { error: { code: string } }).error.code, 'BAD_REQUEST');
  });

  test('JWT エラーは 401 に変換する (REQ-AUTH-04)', () => {
    const handler = createErrorHandler(() => {});
    const { res, state } = mockRes();
    const err = Object.assign(new Error('invalid signature'), { name: 'JsonWebTokenError' });
    handler(err, req, res, () => {});
    assert.equal(state.status, 401);
    assert.equal((state.body as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  });

  test('未捕捉例外は 500 INTERNAL_ERROR に変換し、スタックを露出しない (REQ-VAL-08)', () => {
    const handler = createErrorHandler(() => {});
    const { res, state } = mockRes();
    const err = new Error('secret stack info');
    err.stack = 'Error: secret stack info\n    at file.ts:1:1';

    handler(err, req, res, () => {});

    assert.equal(state.status, 500);
    const body = JSON.stringify(state.body);
    assert.equal((state.body as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
    assert.ok(!body.includes('secret stack info'));
    assert.ok(!body.includes('at file.ts'));
  });

  test('認証エラー等の AppError も共通形式で返す (REQ-VAL-05)', () => {
    const handler = createErrorHandler(() => {});
    const { res, state } = mockRes();
    handler(new AuthenticationError(), req, res, () => {});
    assert.equal(state.status, 401);
    assert.equal((state.body as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  });

  test('InternalError は details を空で返す', () => {
    const handler = createErrorHandler(() => {});
    const { res, state } = mockRes();
    handler(new InternalError(), req, res, () => {});
    assert.deepEqual((state.body as { error: { details: unknown[] } }).error.details, []);
  });

  test('NotFoundException は 404 を返す', () => {
    const handler = createErrorHandler(() => {});
    const { res, state } = mockRes();
    handler(new NotFoundError(), req, res, () => {});
    assert.equal(state.status, 404);
    assert.equal((state.body as { error: { code: string } }).error.code, 'NOT_FOUND');
  });
});
