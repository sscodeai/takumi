import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, WorkflowDefinition } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// Extended Japanese-SI delivery gates:
// quality_gate (enforced threshold), independent_review (isolated context +
// critical-finding abort), delivery (manifest of all artifacts).

test('Gate 10: quality_gate passes when tests are green, fails + aborts when red', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qg-'));
  try {
    // Deterministic test runner: a shell script that echoes "# tests 1 / # pass 1 / # fail 0" and exits 0.
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 't.sh'), '#!/bin/sh\necho "# tests 1"\necho "# pass 1"\necho "# fail 0"\nexit 0\n');
    // red run: always reports 1 failing and exits non-zero
    writeFileSync(join(projectDir, 'r.sh'), '#!/bin/sh\necho "# tests 1"\necho "# pass 0"\necho "# fail 1"\nexit 1\n');
    chmodSync(projectDir + '/t.sh', 0o755);
    chmodSync(projectDir + '/r.sh', 0o755);

    const rt = new TestRuntime(() => 'ok', undefined, 'qg');

    const runStep = async (cmd: string) => {
      const wf: WorkflowDefinition = {
        name: 'qg', version: '0.1.0', description: '',
        steps: [
          { id: 'gate', type: 'quality_gate', prompt: `cd ${projectDir} && ${cmd}` },
          { id: 'shipped', type: 'agent', prompt: 'ship it', dependsOn: ['gate'] },
        ],
      };
      return executeWorkflow(wf, { cwd: projectDir, runtime: rt, artifacts: new ArtifactStore(join(projectDir, '.takumi/a')), onApproval: () => true });
    };

    // green gate passes
    const green = await runStep('sh t.sh');
    assert.equal(green.status, 'completed', 'green gate passes');
    assert.ok(green.steps.find((s) => s.stepId === 'gate')?.status === 'completed');

    // red gate (fail count 1, exit 1) fails + aborts; 'shipped' must not be completed
    const red = await runStep('sh r.sh');
    const gateRes = red.steps.find((s) => s.stepId === 'gate');
    assert.ok(gateRes && gateRes.status === 'failed', 'gate step is failed');
    assert.ok(/quality_gate FAILED/i.test(gateRes.summary), `summary flags FAILED (got: ${gateRes.summary.slice(0, 60)})`);

    // ZERO tests = NOT green (quality gate must not pass vacuously).
    writeFileSync(join(projectDir, 'z.sh'), '#!/bin/sh\necho "# tests 0"\necho "# pass 0"\necho "# fail 0"\nexit 0\n');
    chmodSync(projectDir + '/z.sh', 0o755);
    const zero = await runStep('sh z.sh');
    const zeroRes = zero.steps.find((s) => s.stepId === 'gate');
    assert.ok(zeroRes && zeroRes.status === 'failed', 'zero tests must NOT pass the gate');
    assert.ok(/0 failing over 0 tests/.test(zeroRes.summary), `summary shows zero tests (got: ${zeroRes.summary.slice(0, 60)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Independent Review: isolated cwd and persists verdict artifact (Gate 27 direction)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-'));
  try {
    const rt = new TestRuntime(
      (t) => (t.context?.independentReview ? 'レビュー結果: 問題なし、合格\nREVIEW_VERDICT: pass' : 'impl'),
      undefined,
      'rev',
    );
    let seenCwd: string | undefined;
    const orig = rt.run.bind(rt);
    rt.run = async function* (task: any) {
      if (task.context?.independentReview) seenCwd = task.cwd;
      yield* orig(task);
    };
    const wf: WorkflowDefinition = {
      name: 'review', version: '0.1.0', description: '',
      steps: [
        { id: 'impl', type: 'agent', prompt: 'x' },
        { id: 'review', type: 'independent_review', prompt: 'review', dependsOn: ['impl'] },
      ],
    };
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true });
    assert.equal(res.status, 'completed', 'review passes when no critical finding');
    assert.ok(seenCwd && seenCwd.endsWith('review'), `review ran in isolated dir (${seenCwd})`);
    assert.ok(res.steps.find((s) => s.stepId === 'review')?.artifacts.length === 1, 'review verdict persisted as artifact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Independent Review: critical finding → workflow aborts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revc-'));
  try {
    const rt = new TestRuntime(
      (t) => (t.context?.independentReview ? '重大な欠陥 (Critical): SQL injection in login\nREVIEW_VERDICT: findings' : 'impl'),
      undefined,
      'revc',
    );
    const wf: WorkflowDefinition = {
      name: 'review', version: '0.1.0', description: '',
      steps: [
        { id: 'impl', type: 'agent', prompt: 'x' },
        { id: 'review', type: 'independent_review', prompt: 'review', dependsOn: ['impl'] },
      ],
    };
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true });
    assert.equal(res.status, 'failed', 'critical finding aborts workflow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The verdict is a structured marker, so the prose can say anything and change
 * nothing. Each case here was wrong under the old word-list regex: it passed a
 * defect it could not name, or failed a clean review for matching "Critical".
 */
async function reviewWith(summary: string): Promise<{ status: string; step?: { status: string; summary: string } }> {
  const dir = mkdtempSync(join(tmpdir(), 'revv-'));
  try {
    const rt = new TestRuntime((t) => (t.context?.independentReview ? summary : 'impl'), undefined, 'revv');
    const wf: WorkflowDefinition = {
      name: 'review', version: '0.1.0', description: '',
      steps: [{ id: 'review', type: 'independent_review', prompt: 'review' }],
    };
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true });
    return { status: res.status, step: res.steps.find((s) => s.stepId === 'review') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Independent Review: marker pass → completed even with warnings in the prose', async () => {
  const res = await reviewWith('No Critical or High issues found. Warnings: none.\nREVIEW_VERDICT: pass');
  assert.equal(res.status, 'completed');
  assert.equal(res.step?.status, 'completed');
});

test('Independent Review: marker findings → failed', async () => {
  const res = await reviewWith('Looks fine to me.\nREVIEW_VERDICT: findings');
  assert.equal(res.status, 'failed');
  assert.equal(res.step?.status, 'failed');
});

test('Independent Review: marker blocked → failed', async () => {
  const res = await reviewWith('I could not read the diff.\nREVIEW_VERDICT: blocked');
  assert.equal(res.status, 'failed');
});

test('Independent Review: marker accepted case-insensitively and with "="', async () => {
  const res = await reviewWith('review_verdict = PASS');
  assert.equal(res.status, 'completed');
});

test('Independent Review: missing marker → failed even when the prose looks clean', async () => {
  // The old regex accepted "all tests passing" because `ng` had no word boundary.
  const res = await reviewWith('All tests passing. No issues. This change is good.');
  assert.equal(res.status, 'failed');
  assert.match(res.step?.summary ?? '', /verdict marker .*missing|REVIEW_VERDICT: \(none/);
});

test('Independent Review: missing marker → failed even when the prose names a real defect', async () => {
  // The old regex had no word for this defect, so the workflow continued.
  const res = await reviewWith('脆弱性があります: authentication bypass in login');
  assert.equal(res.status, 'failed');
  assert.match(res.step?.summary ?? '', /verdict marker .*missing|REVIEW_VERDICT: \(none/);
});

test('Independent Review: conflicting markers → failed as ambiguous', async () => {
  const res = await reviewWith('REVIEW_VERDICT: pass\nREVIEW_VERDICT: findings');
  assert.equal(res.status, 'failed');
  assert.match(res.step?.summary ?? '', /ambiguous/i);
});

test('Independent Review: unknown marker value → failed closed', async () => {
  const res = await reviewWith('REVIEW_VERDICT: maybe');
  assert.equal(res.status, 'failed');
  assert.match(res.step?.summary ?? '', /unrecognised REVIEW_VERDICT/);
});

test('Delivery: manifest lists all artifacts, workflow completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'del-'));
  try {
    const store = new ArtifactStore(join(dir, 'a'));
    await store.write({ taskId: 't1', kind: 'req', fileName: 'r.md', content: '# REQ', contentType: 'text/markdown', trace: ['REQ-001'] });
    const rt = new TestRuntime(() => 'ok', undefined, 'del');
    const wf: WorkflowDefinition = {
      name: 'del', version: '0.1.0', description: '',
      steps: [
        { id: 'impl', type: 'agent', prompt: 'x' },
        { id: 'deliver', type: 'delivery', prompt: 'deliver', dependsOn: ['impl'] },
      ],
    };
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: store, onApproval: () => true });
    assert.equal(res.status, 'completed');
    const del = res.steps.find((s) => s.stepId === 'deliver');
    assert.ok(del && del.status === 'completed');
    const all = await store.list();
    const manifest = all.find((a) => a.path.startsWith('delivery/'));
    assert.ok(manifest, 'delivery manifest artifact written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
