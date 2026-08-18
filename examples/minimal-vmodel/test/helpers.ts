/**
 * 単体テスト用ヘルパー
 *
 * テスト間で共通利用するインメモリリポジトリ・トークン・アプリ生成を集約する。
 */

import type { Express } from 'express';
import { createApp } from '../src/app.ts';
import { createTokenService } from '../src/auth/token.ts';
import { InMemoryEmployeeRepository } from '../src/db/inMemoryRepository.ts';
import { createSafeOperationLogger } from '../src/logs/operationLog.ts';
import type { OperationLogEntry } from '../src/domain/types.ts';
import type { OperationLogRepository } from '../src/logs/operationLog.ts';

export const TEST_JWT_SECRET = 'test-secret-with-sufficient-length';
export const TEST_JWT_EXPIRES_IN = '5m';

/** 操作ログを配列に保存するテスト用リポジトリ */
export class RecordingLogRepository implements OperationLogRepository {
  readonly entries: OperationLogEntry[] = [];

  async record(entry: OperationLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export function createTestLog(): RecordingLogRepository {
  return new RecordingLogRepository();
}

export function createTokens() {
  return createTokenService(TEST_JWT_SECRET, TEST_JWT_EXPIRES_IN);
}

/** ロール・社員 ID を指定してテスト用 JWT を発行する */
export function tokenFor(
  role: 'admin' | 'manager' | 'member',
  sub = 1,
  username = `user-${sub}`,
): string {
  return createTokens().sign({ sub, username, role });
}

/** インメモリリポジトリへ初期データを投入する（パスワードはすべて共通ハッシュ） */
export async function seedBaseEmployees(repo: InMemoryEmployeeRepository, passwordHash: string): Promise<void> {
  await repo.seed({
    employeeNo: 'E001',
    name: 'Admin User',
    email: 'admin@example.com',
    username: 'admin',
    passwordHash,
    role: 'admin',
    department: 'HQ',
    joinedAt: '2020-01-01',
  });
  await repo.seed({
    employeeNo: 'E002',
    name: 'Manager User',
    email: 'manager@example.com',
    username: 'manager',
    passwordHash,
    role: 'manager',
    department: 'Engineering',
    joinedAt: '2021-02-02',
  });
  await repo.seed({
    employeeNo: 'E003',
    name: 'Member One',
    email: 'member@example.com',
    username: 'member',
    passwordHash,
    role: 'member',
    department: 'Engineering',
    joinedAt: '2022-03-03',
  });
  await repo.seed({
    employeeNo: 'E004',
    name: 'Member Two',
    email: 'member2@example.com',
    username: 'member2',
    passwordHash,
    role: 'member',
    department: 'Sales',
    joinedAt: '2023-04-04',
  });
}

/** テスト用 Express アプリを生成する */
export function createTestApp() {
  const employees = new InMemoryEmployeeRepository();
  const logs = createTestLog();
  const safeLogs = createSafeOperationLogger(logs);

  const app = createApp({
    employees,
    logs: safeLogs,
    jwtSecret: TEST_JWT_SECRET,
    jwtExpiresIn: TEST_JWT_EXPIRES_IN,
    errorLogger: () => {
      /* テスト中はログ出力を抑止 */
    },
  });

  return { app, employees, logs };
}

/** アプリを一時ポートで起動し、テスト後に確実に終了させる */
export async function startApp(app: Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
