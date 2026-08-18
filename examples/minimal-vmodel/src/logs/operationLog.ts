/**
 * 操作ログ記録インターフェース（基本設計書 5.2.2 operation_logs）
 */

import type { OperationLogEntry } from '../domain/types.ts';

export interface OperationLogRepository {
  record(entry: OperationLogEntry): Promise<void>;
}

/** ログ記録に失敗しても主処理は継続するラッパー */
export function createSafeOperationLogger(repo: OperationLogRepository, onError?: (err: unknown) => void): OperationLogRepository {
  return {
    async record(entry: OperationLogEntry): Promise<void> {
      try {
        await repo.record(entry);
      } catch (err) {
        onError?.(err);
      }
    },
  };
}
