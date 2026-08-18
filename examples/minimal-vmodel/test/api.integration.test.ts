/**
 * API 統合テスト（HTTP 経由）
 *
 * アプリ全体を一時ポートで起動し、認証・CRUD・RBAC・エラー応答を検証する。
 * 由来要件: REQ-AUTH-01,02,04, REQ-EMP-01〜06, REQ-RBAC-02,03,05, REQ-VAL-05,06
 * 実装箇所: src/app.ts / src/routes/*
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Express } from 'express';
import { hashPassword } from '../src/auth/password.ts';
import { createTestApp, seedBaseEmployees, startApp, tokenFor } from './helpers.ts';

const PASSWORD = 'Password1';
const passwordHash = await hashPassword(PASSWORD);

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function withServer(fn: (srv: TestServer & { app: Express }) => Promise<void> | void): Promise<void> {
  const { app, employees } = createTestApp();
  await seedBaseEmployees(employees, passwordHash);
  const server = await startApp(app);
  try {
    await fn({ ...server, app });
  } finally {
    await server.close();
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function newEmployee(overrides: Record<string, unknown> = {}) {
  return {
    employeeNo: 'E100',
    name: 'New Person',
    email: 'new@example.com',
    username: 'newperson',
    password: PASSWORD,
    role: 'member',
    department: 'Engineering',
    joinedAt: '2024-01-01',
    ...overrides,
  };
}

describe('API integration', () => {
  test('POST /api/auth/login 正常系: トークンを返す (REQ-AUTH-01)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: PASSWORD }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { token: string; employee: { id: number; employeeNo: string; name: string; role: string } };
      assert.ok(body.token);
      assert.equal(body.employee.id, 1);
      assert.equal(body.employee.employeeNo, 'E001');
      assert.equal(body.employee.name, 'Admin User');
      assert.equal(body.employee.role, 'admin');
      assert.ok(!('passwordHash' in body.employee));
    });
  });

  test('POST /api/auth/login 異常系: 資格情報誤りは 401 で同一メッセージ (REQ-AUTH-02)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Wrong1234' }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'UNAUTHORIZED');
      assert.equal(body.error.message, 'ユーザー名またはパスワードが正しくありません');
    });
  });

  test('POST /api/auth/logout 正常系: 204 を返す (REQ-AUTH-04)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(tokenFor('admin', 1, 'admin')),
      });
      assert.equal(res.status, 204);
    });
  });

  test('GET /api/employees 認証なしは 401 (REQ-AUTH-04)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees`);
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
    });
  });

  test('GET /api/employees: ロールに応じて一覧を絞り込む (REQ-RBAC-03,05)', async () => {
    await withServer(async ({ baseUrl }) => {
      const adminRes = await fetch(`${baseUrl}/api/employees`, { headers: authHeaders(tokenFor('admin', 1, 'admin')) });
      const adminBody = (await adminRes.json()) as { total: number };
      assert.equal(adminRes.status, 200);
      assert.equal(adminBody.total, 4);

      const managerRes = await fetch(`${baseUrl}/api/employees`, { headers: authHeaders(tokenFor('manager', 2, 'manager')) });
      const managerBody = (await managerRes.json()) as { total: number; items: Array<{ role: string }> };
      assert.equal(managerRes.status, 200);
      assert.equal(managerBody.total, 2);
      assert.ok(managerBody.items.every((e) => e.role === 'member'));

      const memberRes = await fetch(`${baseUrl}/api/employees`, { headers: authHeaders(tokenFor('member', 3, 'member')) });
      const memberBody = (await memberRes.json()) as { total: number; items: Array<{ id: number }> };
      assert.equal(memberRes.status, 200);
      assert.equal(memberBody.total, 1);
      assert.equal(memberBody.items[0].id, 3);
    });
  });

  test('GET /api/employees/:id: 自身参照と水平越権 (REQ-RBAC-05)', async () => {
    await withServer(async ({ baseUrl }) => {
      const ok = await fetch(`${baseUrl}/api/employees/3`, { headers: authHeaders(tokenFor('member', 3, 'member')) });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { id: number }).id, 3);

      const denied = await fetch(`${baseUrl}/api/employees/4`, { headers: authHeaders(tokenFor('member', 3, 'member')) });
      assert.equal(denied.status, 403);
      assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'FORBIDDEN');
    });
  });

  test('POST /api/employees: admin は作成でき、passwordHash を返さない (REQ-EMP-01, REQ-AUTH-03)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees`, {
        method: 'POST',
        headers: authHeaders(tokenFor('admin', 1, 'admin')),
        body: JSON.stringify(newEmployee({ role: 'manager' })),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.role, 'manager');
      assert.ok(!('passwordHash' in body));
      assert.ok(!('password' in body));
    });
  });

  test('POST /api/employees: manager は member のみ作成可能 (REQ-RBAC-03)', async () => {
    await withServer(async ({ baseUrl }) => {
      const ok = await fetch(`${baseUrl}/api/employees`, {
        method: 'POST',
        headers: authHeaders(tokenFor('manager', 2, 'manager')),
        body: JSON.stringify(newEmployee({ employeeNo: 'E101', username: 'm1' })),
      });
      assert.equal(ok.status, 201);

      const denied = await fetch(`${baseUrl}/api/employees`, {
        method: 'POST',
        headers: authHeaders(tokenFor('manager', 2, 'manager')),
        body: JSON.stringify(newEmployee({ employeeNo: 'E102', username: 'm2', role: 'admin' })),
      });
      assert.equal(denied.status, 403);
    });
  });

  test('POST /api/employees: member はルートガードで 403 (REQ-RBAC-02)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees`, {
        method: 'POST',
        headers: authHeaders(tokenFor('member', 3, 'member')),
        body: JSON.stringify(newEmployee()),
      });
      assert.equal(res.status, 403);
    });
  });

  test('POST /api/employees: 不正入力は 422 とフィールドエラー (REQ-VAL-01,05)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees`, {
        method: 'POST',
        headers: authHeaders(tokenFor('admin', 1, 'admin')),
        body: JSON.stringify(newEmployee({ email: 'bad-email', password: 'x' })),
      });
      assert.equal(res.status, 422);
      const body = (await res.json()) as { error: { code: string; details: Array<{ field: string }> } };
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(new Set(body.error.details.map((d) => d.field)), new Set(['email', 'password']));
    });
  });

  test('PUT /api/employees/:id: admin は更新できる (REQ-EMP-03)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees/3`, {
        method: 'PUT',
        headers: authHeaders(tokenFor('admin', 1, 'admin')),
        body: JSON.stringify({ name: 'Renamed', department: 'QA' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { name: string; department: string };
      assert.equal(body.name, 'Renamed');
      assert.equal(body.department, 'QA');
    });
  });

  test('PUT /api/employees/:id: member はルートガードで 403 (REQ-RBAC-02)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees/3`, {
        method: 'PUT',
        headers: authHeaders(tokenFor('member', 3, 'member')),
        body: JSON.stringify({ name: 'self' }),
      });
      assert.equal(res.status, 403);
    });
  });

  test('DELETE /api/employees/:id: admin は他社員を削除できる (REQ-EMP-04)', async () => {
    await withServer(async ({ baseUrl }) => {
      const del = await fetch(`${baseUrl}/api/employees/4`, {
        method: 'DELETE',
        headers: authHeaders(tokenFor('admin', 1, 'admin')),
      });
      assert.equal(del.status, 204);

      const get = await fetch(`${baseUrl}/api/employees/4`, { headers: authHeaders(tokenFor('admin', 1, 'admin')) });
      assert.equal(get.status, 404);
    });
  });

  test('DELETE /api/employees/:id: admin は自分自身を削除できない (REQ-EMP-06)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees/1`, {
        method: 'DELETE',
        headers: authHeaders(tokenFor('admin', 1, 'admin')),
      });
      assert.equal(res.status, 403);
    });
  });

  test('DELETE /api/employees/:id: manager は 403 (REQ-RBAC-02)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees/3`, {
        method: 'DELETE',
        headers: authHeaders(tokenFor('manager', 2, 'manager')),
      });
      assert.equal(res.status, 403);
    });
  });

  test('不正 JWT は 401 (REQ-AUTH-04)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/employees`, { headers: authHeaders('invalid-token') });
      assert.equal(res.status, 401);
    });
  });

  test('不正 JSON は 400 (REQ-VAL-06)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'BAD_REQUEST');
    });
  });

  test('未定義ルートは 404 と統一エラー形式 (REQ-VAL-05)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/unknown`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: { code: string; message: string; traceId: string } };
      assert.equal(body.error.code, 'NOT_FOUND');
      assert.equal(typeof body.error.traceId, 'string');
    });
  });

  test('エラーレスポンスはスタック等の内部情報を露出しない (REQ-VAL-08)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Wrong1234' }),
      });
      const text = await res.text();
      assert.ok(!text.includes('stack'));
      assert.ok(!text.includes('at '));
    });
  });
});
