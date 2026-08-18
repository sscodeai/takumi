/**
 * 操作ログ ユニットテスト
 *
 * 由来要件: REQ-NFR-01
 * 実装箇所: src/logs/operationLog.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafeOperationLogger } from '../src/logs/operationLog.ts';
import type { OperationLogRepository } from '../src/logs/operationLog.ts';
import type { OperationLogEntry } from '../src/domain/types.ts';

describe('createSafeOperationLogger', () => {
  const entry: OperationLogEntry = { operatorId: 1, action: 'LOGIN', targetId: null, requestInfo: 'u=admin' };

  test('正常系: 配下のリポジトリへ記録する (REQ-NFR-01)', async () => {
    let recorded = false;
    const inner: OperationLogRepository = {
      async record(e: OperationLogEntry) {
        recorded = e === entry;
      },
    };
    const safe = createSafeOperationLogger(inner);
    await safe.record(entry);
    assert.equal(recorded, true);
  });

  test('異常系: 記録失敗でも主処理を継続する（例外を投げない） (REQ-NFR-01)', async () => {
    const inner: OperationLogRepository = {
      async record() {
        throw new Error('db down');
      },
    };
    const errors: unknown[] = [];
    const safe = createSafeOperationLogger(inner, (err) => errors.push(err));
    await assert.doesNotReject(() => safe.record(entry));
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /db down/);
  });
});
