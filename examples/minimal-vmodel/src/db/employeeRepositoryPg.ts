/**
 * PostgresEmployeeRepository — 本番用 PostgreSQL 実装（基本設計書 5.2.1）
 */

import { ConflictError, NotFoundError } from '../domain/errors.ts';
import type { Employee, EmployeeQuery } from '../domain/types.ts';
import type { EmployeeRepository } from '../employees/employeeRepository.ts';
import type { Pool } from 'pg';

type DbRow = {
  id: number | string;
  employee_no: string;
  name: string;
  email: string;
  username: string;
  password_hash: string;
  role: string;
  department: string | null;
  joined_at: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapRow(row: DbRow): Employee {
  return {
    id: Number(row.id),
    employeeNo: row.employee_no,
    name: row.name,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role as Employee['role'],
    department: row.department,
    joinedAt: row.joined_at ? toDateString(row.joined_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDateString(value: string): string {
  // joined_at は DATE 型（YYYY-MM-DD）
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

const UNIQUE_FIELDS: Record<string, { field: string; message: string }> = {
  uk_employee_no: { field: 'employeeNo', message: '社員番号は既に使用されています' },
  employees_employee_no_key: { field: 'employeeNo', message: '社員番号は既に使用されています' },
  uk_email: { field: 'email', message: 'メールアドレスは既に使用されています' },
  employees_email_key: { field: 'email', message: 'メールアドレスは既に使用されています' },
  uk_username: { field: 'username', message: 'ユーザー名は既に使用されています' },
  employees_username_key: { field: 'username', message: 'ユーザー名は既に使用されています' },
};

export class PostgresEmployeeRepository implements EmployeeRepository {
  constructor(private readonly pool: Pool) {}

  private mapUniqueViolation(err: unknown): never | void {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') {
      const spec = (e.constraint && UNIQUE_FIELDS[e.constraint]) ?? {
        field: 'unknown',
        message: '一意制約に違反しています',
      };
      throw new ConflictError('一意制約に違反しています', [spec]);
    }
    throw err;
  }

  async findAll(query: EmployeeQuery): Promise<{ total: number; items: Employee[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    let n = 1;

    if (query.role) {
      params.push(query.role);
      where.push(`role = $${n++}`);
    }
    if (query.keyword) {
      params.push(`%${query.keyword}%`);
      where.push(`(name ILIKE $${n} OR employee_no ILIKE $${n++})`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::int AS total FROM employees ${whereClause}`;
    const countResult = await this.pool.query<{ total: number }>(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;

    const offset = (query.page - 1) * query.size;
    const listSql = `
      SELECT * FROM employees
      ${whereClause}
      ORDER BY id ASC
      LIMIT $${n++} OFFSET $${n}
    `;
    const listResult = await this.pool.query<DbRow>(listSql, [...params, query.size, offset]);

    return { total, items: listResult.rows.map(mapRow) };
  }

  async findById(id: number): Promise<Employee | null> {
    const result = await this.pool.query<DbRow>(`SELECT * FROM employees WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByUsername(username: string): Promise<Employee | null> {
    const result = await this.pool.query<DbRow>(`SELECT * FROM employees WHERE username = $1`, [username]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByEmployeeNo(employeeNo: string): Promise<Employee | null> {
    const result = await this.pool.query<DbRow>(`SELECT * FROM employees WHERE employee_no = $1`, [employeeNo]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    const result = await this.pool.query<DbRow>(`SELECT * FROM employees WHERE email = $1`, [email]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async create(input: {
    employeeNo: string;
    name: string;
    email: string;
    username: string;
    passwordHash: string;
    role: Employee['role'];
    department: string | null;
    joinedAt: string | null;
  }): Promise<Employee> {
    try {
      const result = await this.pool.query<DbRow>(
        `INSERT INTO employees
           (employee_no, name, email, username, password_hash, role, department, joined_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         RETURNING *`,
        [input.employeeNo, input.name, input.email, input.username, input.passwordHash, input.role, input.department, input.joinedAt],
      );
      return mapRow(result.rows[0]);
    } catch (err) {
      this.mapUniqueViolation(err);
      throw err;
    }
  }

  async update(
    id: number,
    input: {
      employeeNo?: string;
      name?: string;
      email?: string;
      username?: string;
      passwordHash?: string;
      role?: Employee['role'];
      department?: string | null;
      joinedAt?: string | null;
    },
  ): Promise<Employee> {
    try {
      const existing = await this.findById(id);
      if (!existing) {
        throw new NotFoundError('対象のリソースが見つかりません');
      }

      const merged = {
        employeeNo: input.employeeNo ?? existing.employeeNo,
        name: input.name ?? existing.name,
        email: input.email ?? existing.email,
        username: input.username ?? existing.username,
        passwordHash: input.passwordHash ?? existing.passwordHash,
        role: input.role ?? existing.role,
        department: input.department !== undefined ? input.department : existing.department,
        joinedAt: input.joinedAt !== undefined ? input.joinedAt : existing.joinedAt,
      };

      const result = await this.pool.query<DbRow>(
        `UPDATE employees SET
           employee_no = $1,
           name = $2,
           email = $3,
           username = $4,
           password_hash = $5,
           role = $6,
           department = $7,
           joined_at = $8,
           updated_at = NOW()
         WHERE id = $9
         RETURNING *`,
        [merged.employeeNo, merged.name, merged.email, merged.username, merged.passwordHash, merged.role, merged.department, merged.joinedAt, id],
      );
      return mapRow(result.rows[0]);
    } catch (err) {
      this.mapUniqueViolation(err);
      throw err;
    }
  }

  async delete(id: number): Promise<void> {
    const result = await this.pool.query(`DELETE FROM employees WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      throw new NotFoundError('対象のリソースが見つかりません');
    }
  }
}
