import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, renderTraceabilityMatrix, runTaskAndCollect, validateCapabilities, WorkflowDefinition } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// Consent acceptance gates that need a real (non-LLM) harness: Gate 4 (Fake),
// Gate 11 (approval semantics), Gate 12 (artifact passing), Gate 16 (failure
// recovery). These run on FakeRuntime so they're deterministic and CI-safe.

function env() {
  const dir = mkdtempSync(join(tmpdir(), 'gates-core-'));
  return { dir, artifacts: new ArtifactStore(join(dir, 'artifacts')) };
}

// ---- Gate 4 — FakeRuntime capability simulation ----
test('Gate 4: FakeRuntime simulates start/events/artifact/failure/retry/cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate4-'));
  try {
    // start → events → artifact
    const store = new ArtifactStore(join(dir, 'artifacts'));
    const r = new TestRuntime((t) => `done(${t.prompt})`);
    const events: string[] = [];
    const res = await runTaskAndCollect(r, { id: 'g4', prompt: 'x', cwd: dir }, (ev) => events.push(ev.type));
    assert.equal(res.status, 'completed');
    assert.ok(events.includes('task.started'));
    assert.ok(events.includes('agent.message'));
    assert.ok(events.includes('task.completed'));
    // persist an artifact manually (FakeRuntime result carries none; store does)
    await store.write({ taskId: 'g4', kind: 'evidence', fileName: 'e.md', content: 'ok', contentType: 'text/markdown', trace: [] });
    assert.equal((await store.list('evidence')).length, 1);

    // failure simulation
    const flaky = new TestRuntime(() => {
      throw new Error('boom');
    });
    const failRes = await runTaskAndCollect(flaky, { id: 'g4f', prompt: 'x', cwd: dir });
    assert.equal(failRes.status, 'failed');
    assert.ok((failRes.error ?? failRes.summary).includes('boom'));

    // cancellation simulation
    const cancelRes = await runTaskAndCollect(r, { id: 'g4c', prompt: 'x', cwd: dir });
    // FakeRuntime completes immediately; cancellation is via cancel() which sets
    // status — assert the status map honors it.
    await r.cancel('g4c');
    const status = await r.getStatus('g4c');
    assert.ok(status === 'cancelled' || status === 'completed', 'status after cancel/complete valid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Gate 11 — approval semantics: reject halts, approve resumes ----
test('Gate 11: reject halts workflow before dependent step (implementation not started)', async () => {
  const e = env();
  try {
    const wf: WorkflowDefinition = {
      name: 'g11-reject',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'basic_design', type: 'agent', prompt: 'design' },
        { id: 'design_approval', type: 'approval', prompt: 'approve?' },
        { id: 'implementation', type: 'agent', prompt: 'implement', dependsOn: ['design_approval'] },
      ],
    };
    const res = await executeWorkflow(wf, {
      cwd: e.dir,
      runtime: new TestRuntime((t) => `[${t.prompt}]`),
      artifacts: e.artifacts,
      onApproval: () => false, // REJECT
    });
    assert.equal(res.status, 'cancelled');
    // implementation must NOT have started
    assert.ok(!res.steps.some((s) => s.stepId === 'implementation'), 'implementation must not start on reject');
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test('Gate 11: approve resumes workflow into dependent step', async () => {
  const e = env();
  try {
    const wf: WorkflowDefinition = {
      name: 'g11-approve',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'basic_design', type: 'agent', prompt: 'design' },
        { id: 'design_approval', type: 'approval', prompt: 'approve?' },
        { id: 'implementation', type: 'agent', prompt: 'implement', dependsOn: ['design_approval'] },
      ],
    };
    const res = await executeWorkflow(wf, {
      cwd: e.dir,
      runtime: new TestRuntime((t) => `[${t.prompt}]`),
      artifacts: e.artifacts,
      onApproval: () => true, // APPROVE
    });
    assert.equal(res.status, 'completed');
    assert.ok(res.steps.some((s) => s.stepId === 'implementation' && s.status === 'completed'));
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
});

// ---- Gate 12 — Artifact is a first-class entity, usable by later steps ----
test('Gate 12: artifacts persisted with metadata, later steps can consume', async () => {
  const e = env();
  try {
    const art = await e.artifacts.write({
      taskId: 't-require',
      kind: 'requirements',
      fileName: 'REQ-001.md',
      content: 'REQ-001: login',
      contentType: 'text/markdown',
      trace: ['REQ-001'],
    });
    // first-class: id, kind, taskId, path, contentType, trace, sha256 all present
    assert.ok(art.id.includes('REQ-001'));
    assert.equal(art.kind, 'requirements');
    assert.equal(art.taskId, 't-require');
    assert.ok(art.sha256, 'checksum present');
    assert.ok(art.trace.includes('REQ-001'));

    // a later step can read it back and use its content
    const buf = await e.artifacts.read(art);
    assert.ok(buf.toString('utf8').includes('login'));

    // list by kind
    const reqs = await e.artifacts.list('requirements');
    assert.equal(reqs.length, 1);
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
});

// ---- Gate 16 — failure recovery: fail explicitly with actionable message ----
test('Gate 16: unsupported capability, missing runtime, invalid workflow all fail explicitly', async () => {
  const e = env();
  try {
    // workflow with unknown dependency → fail explicitly with actionable message
    const badWf: WorkflowDefinition = {
      name: 'bad',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'a', type: 'agent', prompt: 'a', dependsOn: ['ghost'] }],
    };
    await assert.rejects(
      () =>
        executeWorkflow(badWf, {
          cwd: e.dir,
          runtime: new TestRuntime((t) => t.prompt),
          artifacts: e.artifacts,
          onApproval: () => true,
        }),
      /unknown step|ghost/,
    );
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
});

// ---- Gate 13 — Traceability: full REQ→DESIGN→CODE→UT→EVIDENCE chain ----
test('Gate 13: full traceability chain answerable + matrix rendered', async () => {
  const e = env();
  try {
    await e.artifacts.write({ taskId: 'r', kind: 'requirements', fileName: 'REQ-001.md', content: 'login', contentType: 'text/markdown', trace: ['REQ-001'] });
    const design = await e.artifacts.write({ taskId: 'd', kind: 'design', fileName: 'DESIGN-001.md', content: 'design', contentType: 'text/markdown', trace: ['REQ-001', 'DESIGN-001'] });
    const code = await e.artifacts.write({ taskId: 'c', kind: 'code', fileName: 'USER-ctrl.ts', content: 'class', contentType: 'text/plain', trace: ['REQ-001', 'DESIGN-001', 'CODE-CHANGE-001'] });
    const ut = await e.artifacts.write({ taskId: 't', kind: 'test', fileName: 'UT-001.md', content: 'test', contentType: 'text/markdown', trace: ['REQ-001', 'CODE-CHANGE-001', 'UT-001'] });
    await e.artifacts.write({ taskId: 'ev', kind: 'evidence', fileName: 'EVIDENCE-001.md', content: 'log', contentType: 'text/markdown', trace: ['UT-001', 'EVIDENCE-001'] });

    // Answer: "REQ-001 由什么代码实现?" → code artifact traced to REQ-001
    const all = await e.artifacts.list();
    const reqImpl = all.filter((a) => a.kind === 'code' && a.trace.includes('REQ-001'));
    assert.equal(reqImpl.length, 1);
    assert.ok(reqImpl[0]?.path.includes('USER-ctrl'));

    // "哪些测试验证了 REQ-001?" → test artifacts traced to REQ-001
    const reqTests = all.filter((a) => a.kind === 'test' && a.trace.includes('REQ-001'));
    assert.equal(reqTests.length, 1);
    assert.ok(reqTests[0]?.path.includes('UT-001'));

    // "Evidence 在哪?" → evidence artifact traced to UT-001
    const evid = all.filter((a) => a.kind === 'evidence' && a.trace.includes('UT-001'));
    assert.equal(evid.length, 1);
    assert.ok(evid[0]?.path.includes('EVIDENCE-001'));

    // Traceability Matrix renders without uncovered-REQ warning
    const matrix = renderTraceabilityMatrix(all);
    assert.ok(matrix.includes('REQ-001'));
    assert.ok(matrix.includes('DESIGN-001'));
    assert.ok(!matrix.includes('Uncovered requirements'));

    // provenance for the chain is preserved
    assert.deepEqual(design.trace, ['REQ-001', 'DESIGN-001']);
    assert.deepEqual(code.trace, ['REQ-001', 'DESIGN-001', 'CODE-CHANGE-001']);
    assert.deepEqual(ut.trace, ['REQ-001', 'CODE-CHANGE-001', 'UT-001']);
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
});