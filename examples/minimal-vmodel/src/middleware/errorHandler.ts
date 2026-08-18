/**
 * グローバル例外ハンドラ（基本設計書 8章）
 *
 * 全例外を捕捉し、共通エラーフォーマットに変換して返却する。
 * traceId を発行し、ログとエラーレスポンスを紐付ける。
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, InternalError } from '../domain/errors.ts';
import type { FieldError } from '../domain/errors.ts';

export interface ErrorLogger {
  (traceId: string, err: unknown, req: Request): void;
}

export function createErrorHandler(log: ErrorLogger = defaultLogger) {
  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    const traceId = randomUUID();

    let appError: AppError;
    if (err instanceof AppError) {
      appError = err;
    } else if (isJsonParseError(err)) {
      appError = new AppError({ status: 400, code: 'BAD_REQUEST', message: 'リクエスト形式が不正です' });
    } else if (isJwtError(err)) {
      appError = new AppError({ status: 401, code: 'UNAUTHORIZED', message: '認証情報が無効です' });
    } else {
      appError = new InternalError('予期しないシステムエラーが発生しました', { cause: err });
    }

    log(traceId, err, req);

    const body = {
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details as FieldError[],
        traceId,
      },
    };

    // システム内部情報（スタックトレース等）はレスポンスに含めない
    res.status(appError.status).json(body);
  };
}

function isJsonParseError(err: unknown): boolean {
  const e = err as { type?: string; status?: number };
  return e?.type === 'entity.parse.failed' || e?.status === 400;
}

function isJwtError(err: unknown): boolean {
  const e = err as { name?: string };
  return e?.name === 'JsonWebTokenError' || e?.name === 'TokenExpiredError' || e?.name === 'NotBeforeError';
}

function defaultLogger(traceId: string, err: unknown, req: Request): void {
  // サーバログにのみ詳細を出力（レスポンスには含めない）
  console.error(
    JSON.stringify({
      level: 'error',
      traceId,
      method: req.method,
      path: req.originalUrl,
      name: err instanceof Error ? err.name : 'UnknownError',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}
