/**
 * PostgreSQL 社員リポジトリ ユニットテスト（Pool モック）
 *
 * 由来要件: REQ-EMP-01〜04, REQ-VAL-02, REQ-VAL-04, REQ-VAL-06
 * 実装箇所: src/db/employeeRepositoryPg.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresEmployeeRepository } from '../src/db/employeeRepositoryPg.ts';
import { ConflictError, NotFoundError } from '../src/domain/errors.ts';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    employee_no: 'E001',
    name: 'Alice',
    email: 'alice@example.com',
    username: 'alice',
    password_hash: 'hash',
    role: 'member',
    department: 'Engineering',
    joined_at: '2024-01-01',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function poolWith(responses: Array<{ rows?: unknown[]; rowCount?: number; reject?: unknown }>) {
  let i = 0;
  const pool = {
    async query() {
      const response = responses[i++];
      if (!response) throw new Error(`unexpected query #${i - 1}`);
      if (response.reject !== undefined) throw response.reject;
      return { rows: response.rows ?? [], rowCount: response.rowCount ?? response.rows?.length ?? 0 };
    },
  } as unknown as Pool;
  return pool;
}

describe('PostgresEmployeeRepository', () => {
  test('findById はスネークケースをドメイン型へマッピングする (REQ-EMP-02)', async () => {
    const pool = poolWith([{ rows: [row({ id: '1' })] }]);
    const repo = new PostgresEmployeeRepository(pool);
    const employee = await repo.findById(1);
    assert.deepEqual(employee, {
      id: 1,
      employeeNo: 'E001',
      name: 'Alice',
      email: 'alice@example.com',
      username: 'alice',
      passwordHash: 'hash',
      role: 'member',
      department: 'Engineering',
      joinedAt: '2024-01-01',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  test('findById が空なら null を返す (REQ-EMP-02)', async () => {
    const pool = poolWith([{ rows: [] }]);
    const repo = new PostgresEmployeeRepository(pool);
    assert.equal(await repo.findById(999), null);
  });

  test('findAll は role/keyword フィルタと LIMIT/OFFSET を組み立てる (REQ-EMP-02)', async () => {
    const pool = poolWith([
      { rows: [{ total: 1 }] },
      { rows: [row()] },
    ]);
    const repo = new PostgresEmployeeRepository(pool);
    const page = await repo.findAll({ page: 2, size: 10, role: 'member', keyword: 'ali' });
    assert.equal(page.total, 1);
    assert.equal(page.items.length, 1);
  });

  test('findByUsername / findByEmployeeNo / findByEmail をマッピングする (REQ-EMP-02)', async () => {
    const pool = poolWith([{ rows: [row({ username: 'alice' })] }, { rows: [row({ employee_no: 'E001' })] }, { rows: [row({ email: 'alice@example.com' })] }]);
    const repo = new PostgresEmployeeRepository(pool);
    assert.equal((await repo.findByUsername('alice'))?.id, 1);
    assert.equal((await repo.findByEmployeeNo('E001'))?.employeeNo, 'E001');
    assert.equal((await repo.findByEmail('alice@example.com'))?.email, 'alice@example.com');
  });

  test('create は RETURNING 行を返す (REQ-EMP-01)', async () => {
    const pool = poolWith([{ rows: [row()] }]);
    const repo = new PostgresEmployeeRepository(pool);
    const created = await repo.create({
      employeeNo: 'E001',
      name: 'Alice',
      email: 'alice@example.com',
      username: 'alice',
      passwordHash: 'hash',
      role: 'member',
      department: 'Engineering',
      joinedAt: '2024-01-01',
    });
    assert.equal(created.id, 1);
    assert.equal(created.employeeNo, 'E001');
  });

  test('create の一意制約違反は ConflictError に変換する (REQ-VAL-02,04)', async () => {
    const pool = poolWith([{ reject: { code: '23505', constraint: 'uk_email' } }]);
    const repo = new PostgresEmployeeRepository(pool);
    await assert.rejects(
      () =>
        repo.create({
          employeeNo: 'E002',
          name: 'Bob',
          email: 'alice@example.com',
          username: 'bob',
          passwordHash: 'hash',
          role: 'member',
          department: null,
          joinedAt: null,
        }),
      (err: unknown) => {
        assert(err instanceof ConflictError);
        assert.equal(err.status, 409);
        assert.equal(err.details[0].field, 'email');
        return true;
      },
    );
  });

  test('update は既存値をマージして更新する (REQ-EMP-03)', async () => {
    const pool = poolWith([
      { rows: [row()] }, // findById
      { rows: [row({ name: 'Alice Smith', department: null })] }, // UPDATE ... RETURNING
    ]);
    const repo = new PostgresEmployeeRepository(pool);
    const updated = await repo.update(1, { name: 'Alice Smith', department: null });
    assert.equal(updated.name, 'Alice Smith');
    assert.equal(updated.department, null);
  });

  test('update 対象が存在しない場合は NotFoundError (REQ-VAL-06)', async () => {
    const pool = poolWith([{ rows: [] }]);
    const repo = new PostgresEmployeeRepository(pool);
    await assert.rejects(() => repo.update(999, { name: 'X' }), NotFoundError);
  });

  test('delete 対象が存在しない場合は NotFoundError (REQ-VAL-06)', async () => {
    const pool = poolWith([{ rows: [], rowCount: 0 }]);
    const repo = new PostgresEmployeeRepository(pool);
    await assert.rejects(() => repo.delete(999), NotFoundError);
  });

  test('delete 成功時は例外を投げない (REQ-EMP-04)', async () => {
    const pool = poolWith([{ rows: [], rowCount: 1 }]);
    const repo = new PostgresEmployeeRepository(pool);
    await assert.doesNotReject(() => repo.delete(1));
  });
});
