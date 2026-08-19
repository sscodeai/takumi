import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// Acceptance Gate 33 — Non-Japanese Workflow (rapid-mvp).
// Proves Takumi Core is a GENERAL platform: a workflow with NO Japanese-SI
// content runs successfully. Japanese enterprise development is a first-class
// distribution/extension, not Core hardcoding.
const RAPID_MVP: import('../workflow.js').WorkflowDefinition = {
  name: 'rapid-mvp',
  version: '0.1.0',
  description: 'Rapid MVP: plan → implement → test → review (no Japanese SI)',
  steps: [
    { id: 'plan', type: 'agent', prompt: 'Write an MVP plan for {input}' },
    { id: 'implementation', type: 'agent', prompt: 'Implement the MVP', dependsOn: ['plan'] },
    { id: 'test', type: 'agent', prompt: 'Write and run tests', dependsOn: ['implementation'] },
    { id: 'review', type: 'agent', prompt: 'Review the result', dependsOn: ['test'] },
  ],
};

test('Gate 33: rapid-mvp (non-Japanese) workflow runs to completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate33-'));
  try {
    const runtime = new TestRuntime((t) => `mvp-done(${t.prompt})`);
    const res = await executeWorkflow(
      RAPID_MVP,
      {
        cwd: dir,
        runtime,
        artifacts: new ArtifactStore(join(dir, 'artifacts')),
        onApproval: () => true,
      },
      { input: 'todo app' },
    );
    assert.equal(res.status, 'completed');
    const order = res.steps.map((s) => s.stepId);
    assert.deepEqual(order, ['plan', 'implementation', 'test', 'review']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (Second test removed in Test-Quality review M2: it asserted properties of a
// constant defined in this same file — tautological. The first test above is
// the real proof: the rapid-mvp workflow actually RAN to completion.)