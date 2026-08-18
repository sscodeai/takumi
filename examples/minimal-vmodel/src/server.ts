/**
 * サーバ起動（本番エントリポイント）
 *
 * 環境変数 DATABASE_URL が未設定、または接続できない場合は
 * インメモリ実装で起動する（デモ・単体実行用）。
 */

import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { PostgresEmployeeRepository } from './db/employeeRepositoryPg.ts';
import { PostgresOperationLogRepository } from './db/operationLogPg.ts';
import { InMemoryEmployeeRepository } from './db/inMemoryRepository.ts';
import { createSafeOperationLogger } from './logs/operationLog.ts';
import type { OperationLogRepository } from './logs/operationLog.ts';
import type { EmployeeRepository } from './employees/employeeRepository.ts';
import { createPool } from './db/pool.ts';

const config = loadConfig();

let logs: OperationLogRepository = {
  async record(entry) {
    console.log('[operation_log]', JSON.stringify(entry));
  },
};
let employees: EmployeeRepository;

if (process.env.DATABASE_URL) {
  const pool = createPool(config.databaseUrl);
  employees = new PostgresEmployeeRepository(pool);
  logs = createSafeOperationLogger(new PostgresOperationLogRepository(pool), (err) => {
    console.error('[operation_log] failed to record:', err);
  });
} else {
  // デモ用インメモリ実装（DB 不要）
  console.warn('DATABASE_URL が未設定のため、インメモリ実装で起動します');
  employees = new InMemoryEmployeeRepository();
}

const app = createApp({
  employees,
  logs,
  jwtSecret: config.jwtSecret,
  jwtExpiresIn: config.jwtExpiresIn,
});

app.listen(config.port, () => {
  console.log(`Employee Management System API listening on http://localhost:${config.port}`);
});
