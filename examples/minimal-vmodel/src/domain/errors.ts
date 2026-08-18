/**
 * 共通例外クラス（基本設計書 8.3 例外処理方針）
 *
 * 認証・認可・バリデーション等は共通例外クラスを定義し、
 * グローバルハンドラが HTTP ステータスを決定する。
 */

/** 項目単位のエラー詳細（基本設計書 8.1 details） */
export interface FieldError {
  field: string;
  message: string;
}

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR';

/** HTTP ステータスとエラーコードの対応（基本設計書 8.2） */
export interface ErrorSpec {
  status: number;
  code: ErrorCode;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: FieldError[];

  constructor(spec: ErrorSpec, details: FieldError[] = [], options?: { cause?: unknown }) {
    super(spec.message);
    this.name = new.target.name;
    this.status = spec.status;
    this.code = spec.code;
    this.details = details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'リクエスト形式が不正です', details: FieldError[] = []) {
    super({ status: 400, code: 'BAD_REQUEST', message }, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = '認証に失敗しました', details: FieldError[] = []) {
    super({ status: 401, code: 'UNAUTHORIZED', message }, details);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'この操作を実行する権限がありません', details: FieldError[] = []) {
    super({ status: 403, code: 'FORBIDDEN', message }, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = '対象のリソースが見つかりません', details: FieldError[] = []) {
    super({ status: 404, code: 'NOT_FOUND', message }, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = '一意制約に違反しています', details: FieldError[] = []) {
    super({ status: 409, code: 'CONFLICT', message }, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = '入力内容に誤りがあります', details: FieldError[] = []) {
    super({ status: 422, code: 'VALIDATION_ERROR', message }, details);
  }
}

export class InternalError extends AppError {
  constructor(message = '予期しないシステムエラーが発生しました', options?: { cause?: unknown }) {
    super({ status: 500, code: 'INTERNAL_ERROR', message }, [], options);
  }
}
