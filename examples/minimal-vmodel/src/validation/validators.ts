/**
 * 入力値検証（基本設計書 第7章）
 */

import { ValidationError } from '../domain/errors.ts';
import type { FieldError } from '../domain/errors.ts';
import { ROLES } from '../domain/types.ts';
import type { CreateEmployeeInput, Role, UpdateEmployeeInput } from '../domain/types.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,50}$/;
const EMPLOYEE_NO_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

/** パスワード強度（8〜64 文字、英大文字・英小文字・数字を各1種以上） */
export function isValidPassword(password: string): boolean {
  if (password.length < 8 || password.length > 64) return false;
  return /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

export function isIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function validateField(errors: FieldError[], field: string, condition: boolean, message: string): void {
  if (!condition) errors.push({ field, message });
}

/** 社員登録入力の検証（7.2 項目別検証ルール） */
export function validateCreate(input: CreateEmployeeInput): void {
  const errors: FieldError[] = [];

  validateField(errors, 'employeeNo', !isBlank(input.employeeNo), '社員番号を入力してください');
  if (!isBlank(input.employeeNo)) {
    validateField(errors, 'employeeNo', EMPLOYEE_NO_PATTERN.test(input.employeeNo), '社員番号は半角英数字で1〜20文字で入力してください');
  }

  validateField(errors, 'name', !isBlank(input.name), '氏名を入力してください');
  if (!isBlank(input.name)) {
    validateField(errors, 'name', input.name.trim().length <= 100, '氏名は100文字以内で入力してください');
  }

  validateField(errors, 'email', !isBlank(input.email), 'メールアドレスを入力してください');
  if (!isBlank(input.email)) {
    validateField(errors, 'email', input.email.length <= 255, 'メールアドレスは255文字以内で入力してください');
    validateField(errors, 'email', EMAIL_PATTERN.test(input.email), 'メールアドレスの形式が正しくありません');
  }

  validateField(errors, 'username', !isBlank(input.username), 'ユーザー名を入力してください');
  if (!isBlank(input.username)) {
    validateField(errors, 'username', USERNAME_PATTERN.test(input.username), 'ユーザー名は半角英数字・-_・.で1〜50文字で入力してください');
  }

  validateField(errors, 'password', !isBlank(input.password), 'パスワードを入力してください');
  if (!isBlank(input.password)) {
    validateField(errors, 'password', isValidPassword(input.password), 'パスワードは8文字以上64文字以下で英大文字・英小文字・数字を各1種以上含めてください');
  }

  validateField(errors, 'role', ROLES.includes(input.role), '不正なロールが指定されました');

  if (input.department !== undefined && input.department !== null && !isBlank(input.department)) {
    validateField(errors, 'department', input.department.length <= 100, '所属部署は100文字以内で入力してください');
  }

  if (input.joinedAt !== undefined && input.joinedAt !== null && !isBlank(input.joinedAt)) {
    validateField(errors, 'joinedAt', isIsoDate(input.joinedAt), '日付の形式が正しくありません');
  }

  if (errors.length > 0) {
    throw new ValidationError('入力内容に誤りがあります', errors);
  }
}

/** 社員更新入力の検証（password は任意、指定された項目のみ検証） */
export function validateUpdate(input: UpdateEmployeeInput): void {
  const errors: FieldError[] = [];

  if (input.employeeNo !== undefined) {
    if (isBlank(input.employeeNo)) {
      errors.push({ field: 'employeeNo', message: '社員番号を入力してください' });
    } else if (!EMPLOYEE_NO_PATTERN.test(input.employeeNo)) {
      errors.push({ field: 'employeeNo', message: '社員番号は半角英数字で1〜20文字で入力してください' });
    }
  }

  if (input.name !== undefined) {
    if (isBlank(input.name)) {
      errors.push({ field: 'name', message: '氏名を入力してください' });
    } else if (input.name.trim().length > 100) {
      errors.push({ field: 'name', message: '氏名は100文字以内で入力してください' });
    }
  }

  if (input.email !== undefined) {
    if (isBlank(input.email)) {
      errors.push({ field: 'email', message: 'メールアドレスを入力してください' });
    } else {
      if (input.email.length > 255) errors.push({ field: 'email', message: 'メールアドレスは255文字以内で入力してください' });
      if (!EMAIL_PATTERN.test(input.email)) errors.push({ field: 'email', message: 'メールアドレスの形式が正しくありません' });
    }
  }

  if (input.username !== undefined) {
    if (isBlank(input.username)) {
      errors.push({ field: 'username', message: 'ユーザー名を入力してください' });
    } else if (!USERNAME_PATTERN.test(input.username)) {
      errors.push({ field: 'username', message: 'ユーザー名は半角英数字・-_・.で1〜50文字で入力してください' });
    }
  }

  if (input.password !== undefined && !isBlank(input.password)) {
    if (!isValidPassword(input.password)) {
      errors.push({ field: 'password', message: 'パスワードは8文字以上64文字以下で英大文字・英小文字・数字を各1種以上含めてください' });
    }
  }

  if (input.role !== undefined) {
    if (!ROLES.includes(input.role)) {
      errors.push({ field: 'role', message: '不正なロールが指定されました' });
    }
  }

  if (input.department !== undefined && input.department !== null && !isBlank(input.department)) {
    if (input.department.length > 100) {
      errors.push({ field: 'department', message: '所属部署は100文字以内で入力してください' });
    }
  }

  if (input.joinedAt !== undefined && input.joinedAt !== null && !isBlank(input.joinedAt)) {
    if (!isIsoDate(input.joinedAt)) {
      errors.push({ field: 'joinedAt', message: '日付の形式が正しくありません' });
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('入力内容に誤りがあります', errors);
  }
}

/** ログイン入力の検証（username / password 必須のみ） */
export function validateLogin(username: unknown, password: unknown): void {
  const errors: FieldError[] = [];
  if (typeof username !== 'string' || isBlank(username)) {
    errors.push({ field: 'username', message: 'ユーザー名を入力してください' });
  }
  if (typeof password !== 'string' || password.length === 0) {
    errors.push({ field: 'password', message: 'パスワードを入力してください' });
  }
  if (errors.length > 0) {
    throw new ValidationError('入力内容に誤りがあります', errors);
  }
}

/** 一覧クエリパラメータの検証（page/size の範囲制限） */
export function validateListQuery(query: { page?: unknown; size?: unknown; role?: unknown; keyword?: unknown }): {
  page: number;
  size: number;
  role?: Role;
  keyword?: string;
} {
  const errors: FieldError[] = [];

  const page = Number(query.page ?? 1);
  const size = Number(query.size ?? 20);

  if (!Number.isInteger(page) || page < 1) {
    errors.push({ field: 'page', message: 'page は1以上の整数で指定してください' });
  }
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    errors.push({ field: 'size', message: 'size は1〜100の整数で指定してください' });
  }

  let role: Role | undefined;
  if (query.role !== undefined && query.role !== '') {
    const raw = String(query.role);
    if (ROLES.includes(raw as Role)) {
      role = raw as Role;
    } else {
      errors.push({ field: 'role', message: '不正なロールが指定されました' });
    }
  }

  const keyword = typeof query.keyword === 'string' && query.keyword.trim() !== '' ? query.keyword.trim() : undefined;

  if (errors.length > 0) {
    throw new ValidationError('入力内容に誤りがあります', errors);
  }

  return { page, size, role, keyword };
}
