/**
 * 社員管理サービス ユニットテスト
 *
 * 由来要件: REQ-EMP-01〜06, REQ-RBAC-02, REQ-RBAC-03, REQ-RBAC-05, REQ-AUTH-03
 * 実装箇所: src/employees/employeeService.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EmployeeService } from '../src/employees/employeeService.ts';
import { InMemoryEmployeeRepository } from '../src/db/inMemoryRepository.ts';
import { AuthorizationError, NotFoundError, ValidationError } from '../src/domain/errors.ts';
import { hashPassword } from '../src/auth/password.ts';
import { seedBaseEmployees } from './helpers.ts';
import { createTestLog } from './helpers.ts';
import type { AuthClaims, CreateEmployeeInput, UpdateEmployeeInput } from '../src/domain/types.ts';

const PASSWORD = 'Password1';
const passwordHash = await hashPassword(PASSWORD);

function actor(role: AuthClaims['role'], sub = 1): AuthClaims {
  return { sub, username: `u-${sub}`, role };
}

function validCreate(overrides: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput {
  return {
    employeeNo: 'E100',
    name: 'New Member',
    email: 'new@example.com',
    username: 'newmember',
    password: PASSWORD,
    role: 'member',
    department: 'Engineering',
    joinedAt: '2024-01-01',
    ...overrides,
  };
}

async function setup() {
  const repo = new InMemoryEmployeeRepository();
  const logs = createTestLog();
  await seedBaseEmployees(repo, passwordHash);
  const service = new EmployeeService(repo, logs);
  return { repo, logs, service };
}

describe('EmployeeService.list', () => {
  test('admin は全社員を取得できる (REQ-RBAC-03)', async () => {
    const { service } = await setup();
    const page = await service.list({ page: 1, size: 20 }, actor('admin', 1));
    assert.equal(page.total, 4);
  });

  test('manager は member のみ取得できる (REQ-RBAC-03)', async () => {
    const { service } = await setup();
    const page = await service.list({ page: 1, size: 20 }, actor('manager', 2));
    assert.equal(page.total, 2);
    assert.ok(page.items.every((e) => e.role === 'member'));
  });

  test('member は自身のみ取得できる (REQ-RBAC-03)', async () => {
    const { service } = await setup();
    const page = await service.list({ page: 1, size: 20 }, actor('member', 3));
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, 3);
  });
});

describe('EmployeeService.getById', () => {
  test('admin は任意の社員を参照できる (REQ-RBAC-03)', async () => {
    const { service } = await setup();
    const employee = await service.getById(2, actor('admin', 1));
    assert.equal(employee.role, 'manager');
  });

  test('manager は member を参照できる (REQ-RBAC-03)', async () => {
    const { service } = await setup();
    assert.equal((await service.getById(3, actor('manager', 2))).id, 3);
  });

  test('manager は admin/manager を参照できない（垂直越権） (REQ-RBAC-05)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.getById(1, actor('manager', 2)), AuthorizationError);
    await assert.rejects(() => service.getById(2, actor('manager', 2)), AuthorizationError);
  });

  test('member は自身のみ参照でき、他者は拒否する（水平越権） (REQ-RBAC-05)', async () => {
    const { service } = await setup();
    assert.equal((await service.getById(3, actor('member', 3))).id, 3);
    await assert.rejects(() => service.getById(4, actor('member', 3)), AuthorizationError);
  });

  test('存在しない ID は NotFoundError (REQ-VAL-06)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.getById(999, actor('admin', 1)), NotFoundError);
  });
});

describe('EmployeeService.create', () => {
  test('admin は任意のロールを作成できる (REQ-EMP-01, REQ-RBAC-03)', async () => {
    const { service, repo } = await setup();
    const created = await service.create(validCreate({ role: 'manager' }), actor('admin', 1));
    assert.equal(created.role, 'manager');
    const stored = await repo.findByUsername('newmember');
    assert.ok(stored);
    assert.notEqual(stored.passwordHash, PASSWORD); // 平文を保存しない
  });

  test('manager は member のみ作成できる (REQ-RBAC-03)', async () => {
    const { service } = await setup();
    assert.equal((await service.create(validCreate(), actor('manager', 2))).role, 'member');
    await assert.rejects(() => service.create(validCreate({ role: 'admin' }), actor('manager', 2)), AuthorizationError);
  });

  test('作成時に CREATE 操作ログを記録する (REQ-NFR-01)', async () => {
    const { service, logs } = await setup();
    const created = await service.create(validCreate(), actor('admin', 1));
    assert.equal(logs.entries.length, 1);
    assert.deepEqual(logs.entries[0], { operatorId: 1, action: 'CREATE', targetId: created.id });
  });

  test('不正入力は ValidationError (REQ-VAL-01)', async () => {
    const { service } = await setup();
    await assert.rejects(
      () => service.create(validCreate({ email: 'bad' }), actor('admin', 1)),
      ValidationError,
    );
  });
});

describe('EmployeeService.update', () => {
  test('admin は任意の社員を更新できる (REQ-EMP-03)', async () => {
    const { service, repo } = await setup();
    const updated = await service.update(3, { name: 'Updated Member', role: 'manager' }, actor('admin', 1));
    assert.equal(updated.name, 'Updated Member');
    assert.equal((await repo.findById(3))?.role, 'manager');
  });

  test('manager は member のみ更新でき、ロール変更は不可 (REQ-RBAC-03,04)', async () => {
    const { service } = await setup();
    assert.equal((await service.update(3, { name: 'M1' }, actor('manager', 2))).name, 'M1');
    await assert.rejects(() => service.update(2, { name: 'self' }, actor('manager', 2)), AuthorizationError);
    await assert.rejects(() => service.update(3, { role: 'admin' }, actor('manager', 2)), AuthorizationError);
  });

  test('member は自身の更新も禁止される（実装上の制約） (REQ-EMP-03)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.update(3, { name: 'self' }, actor('member', 3)), AuthorizationError);
  });

  test('password 指定時はハッシュ化して保存する (REQ-AUTH-03)', async () => {
    const { service, repo } = await setup();
    const updated = await service.update(3, { password: 'NewPassword1' }, actor('admin', 1));
    const stored = await repo.findById(3);
    assert.ok(stored);
    assert.notEqual(stored.passwordHash, passwordHash);
    assert.notEqual(stored.passwordHash, 'NewPassword1');
    assert.equal(updated.id, 3);
  });

  test('password 未指定なら既存ハッシュを維持する (REQ-EMP-03)', async () => {
    const { service, repo } = await setup();
    await service.update(3, { name: 'No Password Change' }, actor('admin', 1));
    assert.equal((await repo.findById(3))?.passwordHash, passwordHash);
  });

  test('更新時に UPDATE 操作ログを記録する (REQ-NFR-01)', async () => {
    const { service, logs } = await setup();
    await service.update(3, { name: 'logged' }, actor('admin', 1));
    assert.equal(logs.entries.length, 1);
    assert.deepEqual(logs.entries[0], { operatorId: 1, action: 'UPDATE', targetId: 3 });
  });

  test('存在しない ID は NotFoundError (REQ-VAL-06)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.update(999, { name: 'x' }, actor('admin', 1)), NotFoundError);
  });

  test('不正入力は ValidationError (REQ-VAL-01)', async () => {
    const { service } = await setup();
    const input = { email: 'bad' } satisfies UpdateEmployeeInput;
    await assert.rejects(() => service.update(3, input, actor('admin', 1)), ValidationError);
  });
});

describe('EmployeeService.remove', () => {
  test('admin は他社員を削除できる (REQ-EMP-04, REQ-RBAC-03)', async () => {
    const { service, repo } = await setup();
    await service.remove(3, actor('admin', 1));
    assert.equal(await repo.findById(3), null);
  });

  test('admin は自分自身を削除できない (REQ-EMP-06)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.remove(1, actor('admin', 1)), AuthorizationError);
  });

  test('manager / member は削除できない (REQ-RBAC-02)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.remove(3, actor('manager', 2)), AuthorizationError);
    await assert.rejects(() => service.remove(3, actor('member', 3)), AuthorizationError);
  });

  test('存在しない ID は NotFoundError (REQ-VAL-06)', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.remove(999, actor('admin', 1)), NotFoundError);
  });

  test('削除時に DELETE 操作ログを記録する (REQ-NFR-01)', async () => {
    const { service, logs } = await setup();
    await service.remove(3, actor('admin', 1));
    assert.deepEqual(logs.entries[0], { operatorId: 1, action: 'DELETE', targetId: 3 });
  });
});
