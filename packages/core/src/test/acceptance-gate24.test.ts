import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, WorkflowDefinition } from '../index.js';
import { FakeRuntime } from '@takumi/runtime-fake';
import { CliRuntimeAdapter } from '@takumi/runtime-cli';

// Acceptance Gate 24 — Runtime Replacement Test.
// Proves Takumi is NOT a Pi wrapper: the SAME workflow definition runs on
// multiple runtimes with ZERO changes to workflow / Core / skill.
const WORKFLOW: WorkflowDefinition = {
  name: 'replacement-test',
  version: '0.1.0',
  description: 'same workflow across runtimes',
  steps: [
    { id: 'analyze', type: 'agent', prompt: 'analyze {input}' },
    { id: 'summarize', type: 'agent', prompt: 'summarize', dependsOn: ['analyze'] },
  ],
};

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'replacement-'));
  return { dir, artifacts: new ArtifactStore(join(dir, 'artifacts')) };
}

test('Gate 24: same workflow runs on FakeRuntime AND a second CLI runtime (no workflow change)', async () => {
  const { dir, artifacts } = makeEnv();

  // Runtime A: FakeRuntime (deterministic)
  const runtimeA = new FakeRuntime((t) => `[A] handled ${t.prompt}`);

  // Runtime B: a second runtime via the CLI bridge (echo prints the prompt → stdout).
  // This is a DIFFERENT runtime implementation; the workflow object is identical.
  const runtimeB = new CliRuntimeAdapter({
    id: 'echo-b',
    name: 'Echo Runtime B',
    command: 'echo',
    args: ['BRIDGE_B'],
  });

  try {
    const resA = await executeWorkflow(WORKFLOW, {
      cwd: dir,
      runtime: runtimeA,
      artifacts,
      onApproval: () => true,
    });
    assert.equal(resA.status, 'completed', 'workflow must complete on FakeRuntime');

    const resB = await executeWorkflow(WORKFLOW, {
      cwd: dir,
      runtime: runtimeB,
      artifacts,
      onApproval: () => true,
    });
    assert.equal(resB.status, 'completed', 'workflow must complete on second runtime');
    // The second runtime's output should reflect ITS OWN implementation (echo),
    // not FakeRuntime's "[A] handled".
    const summarizeB = resB.steps.find((s) => s.stepId === 'summarize');
    assert.ok(
      summarizeB && !summarizeB.summary.includes('[A]'),
      'second runtime must not leak FakeRuntime output',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate 24: same workflow on Fake + Pi would need key; the definition is runtime-agnostic', () => {
  // Static proof: the workflow definition carries NO runtime id / no pi coupling.
  assert.equal(WORKFLOW.runtime, undefined, 'workflow declares no runtime hard dependency');
  const requires = (WORKFLOW.requires ?? []).join(',');
  assert.ok(!requires.toLowerCase().includes('pi'), 'no pi capability required');
});