import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, WorkflowDefinition } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// Gate 9 — Tool Plugin: a `type: tool` step runs a REAL command in the project
// cwd, its stdout becomes the step summary, and is persisted as an artifact.
// This proves the Tool Plugin path is real, not a TODO.
test('Gate 9: tool step executes a real command and persists output as artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-'));
  try {
    const rt = new TestRuntime((t) => `done(${t.prompt})`, undefined, 'tooltest');
    const wf: WorkflowDefinition = {
      name: 'tool-plugin',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'greet', type: 'tool', prompt: 'echo "hello from tool {who}"' }],
    };
    const store = new ArtifactStore(join(dir, 'artifacts'));
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: store, onApproval: () => true }, { who: 'takumi' });
    assert.equal(res.status, 'completed');
    const step = res.steps.find((s) => s.stepId === 'greet');
    assert.ok(step && step.status === 'completed');
    assert.ok(step.summary.includes('hello from tool takumi'), `stdout surfaced in summary (got: ${step?.summary})`);
    assert.ok(step.artifacts.length === 1, 'tool output persisted as artifact');
    const artifacts = await store.list();
    assert.ok(artifacts.some((a) => a.path === 'greet/greet.output.txt'), 'artifact written');
    const saved = await store.read(artifacts.find((a) => a.path === 'greet/greet.output.txt')!);
    assert.ok(saved.toString().includes('hello from tool takumi'), 'artifact holds the command output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate 9: failing tool command → step failed with actionable message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-fail-'));
  try {
    const rt = new TestRuntime(() => 'ok', undefined, 'tooltest');
    const wf: WorkflowDefinition = {
      name: 'tool-fail',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'explode', type: 'tool', prompt: 'exit 7' }],
    };
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true });
    assert.equal(res.status, 'failed');
    const step = res.steps.find((s) => s.stepId === 'explode');
    assert.ok(step && step.status === 'failed');
    assert.ok(/tool failed/.test(step.summary), `failure is explicit (got: ${step?.summary})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
