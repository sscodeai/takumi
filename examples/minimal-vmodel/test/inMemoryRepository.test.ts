/**
 * インメモリ社員リポジトリ ユニットテスト
 *
 * 由来要件: REQ-EMP-01 〜 REQ-EMP-04, REQ-VAL-02, REQ-VAL-04
 * 実装箇所: src/db/inMemoryRepository.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEmployeeRepository } from '../src/db/inMemoryRepository.ts';
import { ConflictError, NotFoundError } from '../src/domain/errors.ts';
import type { Employee } from '../src/domain/types.ts';

const PASSWORD_HASH = 'hashed-password';

function makeInput(overrides: Partial<Parameters<InMemoryEmployeeRepository['create']>[0]> = {}) {
  return {
    employeeNo: 'E001',
    name: 'Alice',
    email: 'alice@example.com',
    username: 'alice',
    passwordHash: PASSWORD_HASH,
    role: 'member' as const,
    department: 'Engineering',
    joinedAt: '2024-01-01',
    ...overrides,
  };
}

describe('InMemoryEmployeeRepository', () => {
  test('正常系: create で ID とタイムスタンプを採番して返す (REQ-EMP-01)', async () => {
    const repo = new InMemoryEmployeeRepository();
    const created = await repo.create(makeInput());
    assert.equal(created.id, 1);
    assert.equal(created.passwordHash, PASSWORD_HASH);
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);
  });

  test('正常系: 各一意キーで検索できる (REQ-EMP-02)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await repo.create(makeInput());
    assert.equal((await repo.findByUsername('alice'))?.id, 1);
    assert.equal((await repo.findByEmployeeNo('E001'))?.id, 1);
    assert.equal((await repo.findByEmail('alice@example.com'))?.id, 1);
    assert.equal(await repo.findById(1), (await repo.findById(1)));
  });

  test('正常系: findAll は role/keyword で絞り込み、ページングする (REQ-EMP-02)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await repo.create(makeInput({ employeeNo: 'E001', email: 'alice@example.com', username: 'alice', role: 'member', name: 'Alice' }));
    await repo.create(makeInput({ employeeNo: 'E002', email: 'bob@example.com', username: 'bob', role: 'member', name: 'Bob' }));
    await repo.create(makeInput({ employeeNo: 'E003', email: 'carol@example.com', username: 'carol', role: 'manager', name: 'Carol' }));

    const all = await repo.findAll({ page: 1, size: 2 });
    assert.equal(all.total, 3);
    assert.equal(all.items.length, 2);
    assert.deepEqual(all.items.map((e) => e.id), [1, 2]);

    const members = await repo.findAll({ page: 1, size: 10, role: 'member' });
    assert.equal(members.total, 2);

    const keyword = await repo.findAll({ page: 1, size: 10, keyword: 'ali' });
    assert.equal(keyword.total, 1);
    assert.equal(keyword.items[0].username, 'alice');
  });

  test('異常系: employeeNo / email / username の重複を ConflictError で拒否する (REQ-VAL-02,04)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await repo.create(makeInput());

    for (const dup of [
      makeInput({ employeeNo: 'E001', email: 'x@example.com', username: 'x' }),
      makeInput({ employeeNo: 'E100', email: 'alice@example.com', username: 'x' }),
      makeInput({ employeeNo: 'E101', email: 'x@example.com', username: 'alice' }),
    ]) {
      await assert.rejects(() => repo.create(dup), ConflictError);
    }
  });

  test('正常系: update は部分更新できる (REQ-EMP-03)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await repo.create(makeInput());
    const updated = await repo.update(1, { name: 'Alice Smith', department: null });
    assert.equal(updated.name, 'Alice Smith');
    assert.equal(updated.department, null);
    assert.equal(updated.username, 'alice');
  });

  test('異常系: 存在しない update は NotFoundError (REQ-EMP-03)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await assert.rejects(() => repo.update(99, { name: 'X' }), NotFoundError);
  });

  test('正常系: delete で削除し、以降の find は null (REQ-EMP-04)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await repo.create(makeInput());
    await repo.delete(1);
    assert.equal(await repo.findById(1), null);
  });

  test('異常系: 存在しない delete は NotFoundError (REQ-EMP-04)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await assert.rejects(() => repo.delete(99), NotFoundError);
  });

  test('正常系: update で自分自身の一意値は変更できる（同一レコードは除外） (REQ-VAL-02)', async () => {
    const repo = new InMemoryEmployeeRepository();
    await repo.create(makeInput());
    const updated = await repo.update(1, { username: 'alice' });
    assert.equal(updated.username, 'alice');
  });

  test('seed はテスト用に任意の初期データを投入する', async () => {
    const repo = new InMemoryEmployeeRepository();
    const row = (await repo.seed({
      employeeNo: 'E900',
      name: 'Seed',
      email: 'seed@example.com',
      username: 'seed',
      passwordHash: PASSWORD_HASH,
      role: 'admin',
      department: null,
      joinedAt: null,
    })) as Employee;
    assert.equal(row.id, 1);
    assert.equal((await repo.findById(1))?.name, 'Seed');
  });
});
