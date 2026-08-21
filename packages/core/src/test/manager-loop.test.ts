import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runManagerLoop, LoopHost, TaskState, AuditResult } from '../manager-loop.js';

// Deterministic fake host: manager decides done after 2 rounds,
// audit always passes records.
function fakeHost(opts: { doneAfter?: number; auditFail?: string[] } = {}): { host: LoopHost; calls: { execute: number; audit: number } } {
  const calls = { execute: 0, audit: 0 };
  const doneAfter = opts.doneAfter ?? 2;
  const auditFail = opts.auditFail ?? [];
  const host: LoopHost = {
    async execute(contract, state) {
      calls.execute++;
      return { summary: `executed ${contract.recordIds.join(',')} (round ${state.rounds})` };
    },
    async audit(contract, state, executorSummary) {
      calls.audit++;
      const statuses = contract.recordIds.map((recordId) => ({
        recordId,
        status: auditFail.includes(recordId) ? ('untrusted' as const) : ('completed' as const),
        evidence: `verified ${recordId} by fake audit`,
      }));
      return { recordStatuses: statuses, report: `audit round ${state.rounds}: ${statuses.map((s) => `${s.recordId}=${s.status}`).join(', ')}` };
    },
    async manage(state, auditHistory) {
      const unresolved = state.records.filter((r) => r.status === 'pending' || r.status === 'untrusted');
      if (unresolved.length === 0 || state.rounds >= doneAfter) {
        return { decision: 'done' as const, note: 'all records resolved' };
      }
      const first = unresolved[0]!;
      return {
        decision: 'execute' as const,
        contract: { recordIds: [first.id], instruction: `work on ${first.id}` },
      };
    },
  };
  return { host, calls };
}

test('manager loop: executes rounds until all records done', async () => {
  const { host, calls } = fakeHost();
  const res = await runManagerLoop(host, 'build a thing', { maxRounds: 5 });
  assert.equal(res.decision, 'done');
  assert.ok(calls.execute >= 1, `executor called ${calls.execute} times`);
  assert.equal(calls.execute, calls.audit, 'every execute has an audit');
  assert.equal(res.state.records[0]!.status, 'completed');
  assert.ok(res.state.records[0]!.evidence, 'evidence attached from audit');
  assert.equal(res.auditHistory.length, calls.audit);
});

test('manager loop: respects maxRounds (blocked)', async () => {
  // Manager never says done because audit NEVER completes the record.
  const { host, calls } = fakeHost({ auditFail: ['r1'], doneAfter: 99 });
  const res = await runManagerLoop(host, 'never done', { maxRounds: 3 });
  assert.equal(res.decision, 'blocked');
  assert.equal(calls.execute, 3);
  assert.equal(res.rounds, 3);
  assert.match(res.finalNote ?? '', /maxRounds/);
});

test('manager loop: untrusted audit keeps record pending (no state change from claim)', async () => {
  const { host, calls } = fakeHost({ auditFail: ['r1'], doneAfter: 5 });
  const res = await runManagerLoop(host, 'task', { maxRounds: 4 });
  // r1 never completed because audit kept marking it untrusted.
  assert.notEqual(res.state.records[0]!.status, 'completed');
  assert.ok(calls.execute >= 2, 'kept executing because record stayed pending');
});
