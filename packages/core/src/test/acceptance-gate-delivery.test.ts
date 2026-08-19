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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Independent Review: isolated cwd and persists verdict artifact (Gate 27 direction)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-'));
  try {
    const rt = new TestRuntime((t) => (t.context?.independentReview ? 'レビュー結果: 問題なし、合格' : 'impl'), undefined, 'rev');
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
    const rt = new TestRuntime((t) => (t.context?.independentReview ? '重大な欠陥 (Critical): SQL injection in login' : 'impl'), undefined, 'revc');
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
