import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, createGitRunner, executeWorkflow, WorkflowDefinition } from '../index.js';
import { TestRuntime } from '../test-utils.js';

/**
 * `{requirement}` in a PROMPT.
 *
 * A step that carries a `requirementRef` is already held to the document a human confirmed (ADR-025).
 * A step that carries a prompt is the same promise written differently: an implementer told to read
 * `{requirement}` must be handed the path of THAT document. It was not — the name was only filled for
 * `requirementRef`, so the implementer's prompt kept the literal `{requirement}`, the agent went
 * looking for a requirement on its own, and the run delivered a different document than the one a human
 * confirmed (docs/bugs-fixed.md, 34).
 *
 * What these tests prove: the name is filled for prompts too, no placeholder survives into an agent's
 * context, and a workflow that names it in a run with nothing confirmed is refused BEFORE any agent
 * runs — rather than after it has been paid to guess.
 */

const DIGEST = 'a'.repeat(64);

function harness(steps: WorkflowDefinition['steps']): { seen: string[]; runtime: TestRuntime; artifacts: string } {
  const seen: string[] = [];
  const runtime = new TestRuntime((task) => {
    seen.push(task.prompt ?? '');
    return 'done';
  });
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-req-prompt-artifacts-'));
  return { seen, runtime, artifacts };
}

test('a prompt naming {requirement} is handed the document the run was confirmed against', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-req-prompt-'));
  const h = harness([]);
  try {
    const wf: WorkflowDefinition = {
      name: 'prompt-binding',
      version: '0.1.0',
      description: '',
      steps: [
        {
          id: 'implement',
          type: 'agent',
          prompt: 'The confirmed requirement document is at {requirement} — read it and implement it.',
        },
      ],
    };
    const res = await executeWorkflow(wf, {
      cwd: dir,
      runtime: h.runtime,
      artifacts: new ArtifactStore(h.artifacts),
      git: createGitRunner(),
      onApproval: () => true,
      confirmedRequirement: { ref: 'docs/requirements/intake.yaml', digest: DIGEST },
    });

    assert.equal(res.status, 'completed');
    assert.equal(h.seen.length, 1);
    assert.match(h.seen[0] ?? '', /The confirmed requirement document is at docs\/requirements\/intake\.yaml/);
    assert.ok(!(h.seen[0] ?? '').includes('{requirement}'), 'no placeholder may reach the agent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(h.artifacts, { recursive: true, force: true });
  }
});

test('a workflow naming {requirement} with nothing confirmed is refused before any step runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-req-prompt-'));
  const h = harness([]);
  try {
    const wf: WorkflowDefinition = {
      name: 'prompt-binding',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'implement', type: 'agent', prompt: 'Read {requirement} and implement it.' }],
    };
    await assert.rejects(
      () =>
        executeWorkflow(wf, {
          cwd: dir,
          runtime: h.runtime,
          artifacts: new ArtifactStore(h.artifacts),
          git: createGitRunner(),
          onApproval: () => true,
        }),
      /names \{requirement\} in step\(s\) \[implement\].*no confirmed requirement on record/,
    );
    assert.equal(h.seen.length, 0, 'no agent may be started for a prompt the run cannot fill');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(h.artifacts, { recursive: true, force: true });
  }
});

test('a workflow that never names {requirement} runs with no confirmation on record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-req-prompt-'));
  const h = harness([]);
  try {
    const wf: WorkflowDefinition = {
      name: 'no-binding',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'implement', type: 'agent', prompt: 'Implement the request: {prompt}' }],
    };
    const res = await executeWorkflow(wf, {
      cwd: dir,
      runtime: h.runtime,
      artifacts: new ArtifactStore(h.artifacts),
      git: createGitRunner(),
      onApproval: () => true,
    });
    assert.equal(res.status, 'completed');
    assert.equal(h.seen.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(h.artifacts, { recursive: true, force: true });
  }
});
