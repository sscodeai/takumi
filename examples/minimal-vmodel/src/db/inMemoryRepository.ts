/**
 * InMemoryEmployeeRepository — 単体テスト・デモ用のインメモリ実装
 *
 * Postgres 実装と同一の EmployeeRepository インターフェースを満たす。
 * 一意制約は employees テーブルと同等（employee_no / email / username）を再現する。
 */

import { ConflictError, NotFoundError } from '../domain/errors.ts';
import type { Employee, EmployeeQuery } from '../domain/types.ts';
import type { EmployeeRepository } from './employeeRepository.ts';

interface CreateParams {
  employeeNo: string;
  name: string;
  email: string;
  username: string;
  passwordHash: string;
  role: Employee['role'];
  department: string | null;
  joinedAt: string | null;
}

interface UpdateParams {
  employeeNo?: string;
  name?: string;
  email?: string;
  username?: string;
  passwordHash?: string;
  role?: Employee['role'];
  department?: string | null;
  joinedAt?: string | null;
}

export class InMemoryEmployeeRepository implements EmployeeRepository {
  private readonly rows: Employee[] = [];
  private nextId = 1;

  private now(): string {
    return new Date().toISOString();
  }

  private uniqueError(field: string, message: string): ConflictError {
    return new ConflictError('一意制約に違反しています', [{ field, message }]);
  }

  private checkUniqueness(excludeId: number | null, employeeNo?: string, email?: string, username?: string): void {
    if (employeeNo) {
      const dup = this.rows.find((r) => r.employeeNo === employeeNo && r.id !== excludeId);
      if (dup) throw this.uniqueError('employeeNo', '社員番号は既に使用されています');
    }
    if (email) {
      const dup = this.rows.find((r) => r.email === email && r.id !== excludeId);
      if (dup) throw this.uniqueError('email', 'メールアドレスは既に使用されています');
    }
    if (username) {
      const dup = this.rows.find((r) => r.username === username && r.id !== excludeId);
      if (dup) throw this.uniqueError('username', 'ユーザー名は既に使用されています');
    }
  }

  async findAll(query: EmployeeQuery): Promise<{ total: number; items: Employee[] }> {
    let filtered = [...this.rows];

    if (query.role) {
      filtered = filtered.filter((r) => r.role === query.role);
    }
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      filtered = filtered.filter(
        (r) => r.name.toLowerCase().includes(kw) || r.employeeNo.toLowerCase().includes(kw),
      );
    }

    // id 昇順で安定ソート
    filtered.sort((a, b) => a.id - b.id);

    const total = filtered.length;
    const start = (query.page - 1) * query.size;
    const items = filtered.slice(start, start + query.size);
    return { total, items };
  }

  async findById(id: number): Promise<Employee | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findByUsername(username: string): Promise<Employee | null> {
    return this.rows.find((r) => r.username === username) ?? null;
  }

  async findByEmployeeNo(employeeNo: string): Promise<Employee | null> {
    return this.rows.find((r) => r.employeeNo === employeeNo) ?? null;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    return this.rows.find((r) => r.email === email) ?? null;
  }

  async create(params: CreateParams): Promise<Employee> {
    this.checkUniqueness(null, params.employeeNo, params.email, params.username);
    const ts = this.now();
    const employee: Employee = {
      id: this.nextId++,
      employeeNo: params.employeeNo,
      name: params.name,
      email: params.email,
      username: params.username,
      passwordHash: params.passwordHash,
      role: params.role,
      department: params.department ?? null,
      joinedAt: params.joinedAt ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.push(employee);
    return employee;
  }

  async update(id: number, params: UpdateParams): Promise<Employee> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new NotFoundError('対象のリソースが見つかりません');
    }
    this.checkUniqueness(id, params.employeeNo, params.email, params.username);

    const current = this.rows[idx];
    const updated: Employee = {
      ...current,
      employeeNo: params.employeeNo ?? current.employeeNo,
      name: params.name ?? current.name,
      email: params.email ?? current.email,
      username: params.username ?? current.username,
      passwordHash: params.passwordHash ?? current.passwordHash,
      role: params.role ?? current.role,
      department: params.department !== undefined ? params.department : current.department,
      joinedAt: params.joinedAt !== undefined ? params.joinedAt : current.joinedAt,
      updatedAt: this.now(),
    };
    this.rows[idx] = updated;
    return updated;
  }

  async delete(id: number): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new NotFoundError('対象のリソースが見つかりません');
    }
    this.rows.splice(idx, 1);
  }

  /** テスト用ヘルパー：初期データ投入 */
  async seed(employee: Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>): Promise<Employee> {
    const ts = this.now();
    const row: Employee = { ...employee, id: this.nextId++, createdAt: ts, updatedAt: ts };
    this.rows.push(row);
    return row;
  }
}
