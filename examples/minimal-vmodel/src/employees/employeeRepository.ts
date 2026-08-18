/**
 * 社員リポジトリ インターフェース（基本設計書 5.2.1 employees）
 *
 * 実装は PostgreSQL（本番）と InMemory（単体テスト用）の2種を用意する。
 */

import type { Employee, EmployeeQuery, EmployeeView } from '../domain/types.ts';

export interface EmployeeRepository {
  findAll(query: EmployeeQuery): Promise<{ total: number; items: Employee[] }>;
  findById(id: number): Promise<Employee | null>;
  findByUsername(username: string): Promise<Employee | null>;
  findByEmployeeNo(employeeNo: string): Promise<Employee | null>;
  findByEmail(email: string): Promise<Employee | null>;
  create(input: {
    employeeNo: string;
    name: string;
    email: string;
    username: string;
    passwordHash: string;
    role: Employee['role'];
    department: string | null;
    joinedAt: string | null;
  }): Promise<Employee>;
  update(id: number, input: {
    employeeNo?: string;
    name?: string;
    email?: string;
    username?: string;
    passwordHash?: string;
    role?: Employee['role'];
    department?: string | null;
    joinedAt?: string | null;
  }): Promise<Employee>;
  delete(id: number): Promise<void>;
}

/** DB エンティティをレスポンス用（View）へ変換 */
export function toView(employee: Employee): EmployeeView {
  const { passwordHash: _passwordHash, ...view } = employee;
  void _passwordHash;
  return view;
}
