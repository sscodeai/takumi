/**
 * 認証サービス ユニットテスト
 *
 * 由来要件: REQ-AUTH-01 〜 REQ-AUTH-05, REQ-NFR-01
 * 実装箇所: src/auth/authService.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/auth/authService.ts';
import { EmployeeService } from '../src/employees/employeeService.ts';
import { InMemoryEmployeeRepository } from '../src/db/inMemoryRepository.ts';
import { createTokenService } from '../src/auth/token.ts';
import { hashPassword } from '../src/auth/password.ts';
import { AuthenticationError, ValidationError } from '../src/domain/errors.ts';
import { createTestLog, seedBaseEmployees } from './helpers.ts';

const PASSWORD = 'Password1';
const passwordHash = await hashPassword(PASSWORD);

async function setup() {
  const repo = new InMemoryEmployeeRepository();
  const logs = createTestLog();
  await seedBaseEmployees(repo, passwordHash);
  const tokens = createTokenService('auth-test-secret', '1h');
  const authService = new AuthService(repo, tokens, logs);
  const employeeService = new EmployeeService(repo, logs);
  return { repo, logs, tokens, authService, employeeService };
}

describe('AuthService.login', () => {
  test('正常系: 正しい資格情報でトークンと安全なユーザー情報を返す (REQ-AUTH-01)', async () => {
    const { authService, tokens, logs } = await setup();
    const result = await authService.login('admin', PASSWORD);
    assert.equal(typeof result.token, 'string');
    assert.deepEqual(tokens.verify(result.token), { sub: 1, username: 'admin', role: 'admin' });
    assert.deepEqual(result.employee, { id: 1, employeeNo: 'E001', name: 'Admin User', role: 'admin' });
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].action, 'LOGIN');
  });

  test('正常系: username 前後の空白はトリムする (REQ-AUTH-01)', async () => {
    const { authService } = await setup();
    const result = await authService.login('  admin  ', PASSWORD);
    assert.equal(result.employee.id, 1);
  });

  test('異常系: 存在しないユーザー名は 401 を投げ、どちらが誤りか特定しない (REQ-AUTH-02)', async () => {
    const { authService } = await setup();
    await assert.rejects(
      () => authService.login('nobody', PASSWORD),
      (err: unknown) => {
        assert(err instanceof AuthenticationError);
        assert.equal(err.status, 401);
        assert.equal(err.message, 'ユーザー名またはパスワードが正しくありません');
        return true;
      },
    );
  });

  test('異常系: 誤ったパスワードも同一メッセージで 401 (REQ-AUTH-02)', async () => {
    const { authService } = await setup();
    await assert.rejects(
      () => authService.login('admin', 'Wrong1234'),
      (err: unknown) => {
        assert(err instanceof AuthenticationError);
        assert.equal(err.message, 'ユーザー名またはパスワードが正しくありません');
        return true;
      },
    );
  });

  test('異常系: 未入力・非文字列は ValidationError (REQ-VAL-01)', async () => {
    const { authService } = await setup();
    await assert.rejects(() => authService.login('', PASSWORD), ValidationError);
    await assert.rejects(() => authService.login(123, PASSWORD), ValidationError);
    await assert.rejects(() => authService.login('admin', ''), ValidationError);
  });

  test('失敗時はログインログを記録しない (REQ-NFR-01)', async () => {
    const { authService, logs } = await setup();
    await assert.rejects(() => authService.login('admin', 'bad12345'), AuthenticationError);
    assert.equal(logs.entries.length, 0);
  });
});

describe('AuthService.logout', () => {
  test('正常系: LOGOUT 操作ログを記録する (REQ-AUTH-04, REQ-NFR-01)', async () => {
    const { authService, logs } = await setup();
    await authService.logout({ sub: 1, username: 'admin' });
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].operatorId, 1);
    assert.equal(logs.entries[0].action, 'LOGOUT');
  });
});
