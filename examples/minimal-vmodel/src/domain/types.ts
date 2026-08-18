/**
 * ドメイン型定義（基本設計書 第3章・第4章・第6章 に対応）
 */

export type Role = 'admin' | 'manager' | 'member';

export const ROLES: readonly Role[] = ['admin', 'manager', 'member'] as const;

/** 認証トークンに含めるクレーム */
export interface AuthClaims {
  sub: number; // employees.id
  username: string;
  role: Role;
}

/** 社員エンティティ（DB の employees テーブルに対応） */
export interface Employee {
  id: number;
  employeeNo: string;
  name: string;
  email: string;
  username: string;
  /** 平文は保持しない（passwordHash のみ） */
  passwordHash: string;
  role: Role;
  department: string | null;
  joinedAt: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
}

/** レスポンスに含める安全な社員表現（パスワードハッシュを含まない） */
export interface EmployeeView {
  id: number;
  employeeNo: string;
  name: string;
  email: string;
  username: string;
  role: Role;
  department: string | null;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 社員登録リクエスト（POST /api/employees） */
export interface CreateEmployeeInput {
  employeeNo: string;
  name: string;
  email: string;
  username: string;
  password: string;
  role: Role;
  department?: string | null;
  joinedAt?: string | null;
}

/** 社員更新リクエスト（PUT /api/employees/{id}）。password は任意更新。 */
export interface UpdateEmployeeInput {
  employeeNo?: string;
  name?: string;
  email?: string;
  username?: string;
  password?: string;
  role?: Role;
  department?: string | null;
  joinedAt?: string | null;
}

/** 一覧取得結果（GET /api/employees） */
export interface EmployeePage {
  total: number;
  page: number;
  size: number;
  items: EmployeeView[];
}

/** 一覧検索条件 */
export interface EmployeeQuery {
  keyword?: string;
  role?: Role;
  page: number;
  size: number;
}

/** ログイン結果 */
export interface AuthResult {
  token: string;
  employee: Pick<EmployeeView, 'id' | 'employeeNo' | 'name' | 'role'>;
}

/** 操作ログ種別（基本設計書 5.2.2） */
export type OperationAction = 'LOGIN' | 'LOGOUT' | 'CREATE' | 'UPDATE' | 'DELETE';

/** 操作ログ記録要求 */
export interface OperationLogEntry {
  operatorId: number;
  action: OperationAction;
  targetId?: number | null;
  requestInfo?: string | null;
}
