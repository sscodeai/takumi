/**
 * 操作ログの PostgreSQL 実装（基本設計書 5.2.2）
 */

import type { OperationLogEntry } from '../domain/types.ts';
import type { OperationLogRepository } from './operationLog.ts';
import type { Pool } from 'pg';

export class PostgresOperationLogRepository implements OperationLogRepository {
  constructor(private readonly pool: Pool) {}

  async record(entry: OperationLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO operation_logs (operator_id, action, target_id, operated_at, request_info)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [entry.operatorId, entry.action, entry.targetId ?? null, entry.requestInfo ?? null],
    );
  }
}
