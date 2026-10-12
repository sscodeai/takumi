/**
 * A STEP THAT DECLARES AN OUTPUT MUST PRODUCE IT.
 *
 * Found on a real machine (2026-10-11 17:56Z, run wf-5beb034f): `request-intake` ran unattended in 74
 * seconds and reported success — `req_intake` done, `intake_shape` PASSED 4/4, `ambiguity_confirmation`
 * approved — while the agent had produced NOTHING. The document the shape gate read
 * (docs/requirements/intake.yaml, 11553 bytes) was a COMMITTED file from an earlier session, written
 * six hours before the run. It was even about the same subject (station temperatures), because the
 * earlier request had been similar, so the gate's output read as plausible: `ok 1 - the intake wrote
 * docs/requirements/intake.yaml`.
 *
 * Nothing in the chain asked "was this written by THIS run?", so a run that produced nothing was
 * indistinguishable from a run that produced the document — and the approval step that follows would
 * have had a human confirm a document that predates their own request.
 *
 * Why the runtime was silent is a separate, also-real defect: the pi turn ended with stopReason
 * "length" (output 8192 tokens, reasoning 8192) — the model spent its entire output budget on
 * reasoning and never emitted an answer, and the adapter reported that as a finished turn. But the
 * engine's blindness is the one fixed here, because it is the one that lets ANY silent runtime pass:
 * an agent step whose result is empty is recorded as `completed`, and every check downstream then
 * reads whatever happens to be on disk.
 *
 * The rule pinned here: a step that declares `produces: [path]` fails unless that path was written
 * DURING the step. A file that was already there is not this step's output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ArtifactStore, createGitRunner, executeWorkflow, validateWorkflowManifest } from '../index.js';
import type { WorkflowDefinition } from '../workflow.js';
import { TestRuntime } from '../test-utils.js';

const DOC = 'docs/requirements/intake.yaml';

/** A runtime that does exactly what its callback says — including nothing at all. */
function runtimeDoing(work: (cwd: string) => void): TestRuntime {
  return new TestRuntime((task) => {
    work(task.cwd ?? '');
    return 'agent turn finished';
  });
}

function intakeWorkflow(): WorkflowDefinition {
  return {
    name: 'intake-produces',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'req_intake', type: 'agent', prompt: 'write the document', produces: [DOC] }],
  };
}

async function run(dir: string, runtime: TestRuntime, artifacts: string) {
  return executeWorkflow(intakeWorkflow(), {
    cwd: dir,
    runtime,
    artifacts: new ArtifactStore(artifacts),
    git: createGitRunner(),
    onApproval: () => true,
  });
}

function dirs(): { dir: string; artifacts: string } {
  return {
    dir: mkdtempSync(join(tmpdir(), 'takumi-produces-')),
    artifacts: mkdtempSync(join(tmpdir(), 'takumi-produces-artifacts-')),
  };
}

// ---------------------------------------------------------------------------------------------
// (a) the observed failure: the file was already there, and the runtime did not write it
// ---------------------------------------------------------------------------------------------

test('a declared output that the step did not write FAILS the step, even though the file exists', async () => {
  const { dir, artifacts } = dirs();
  try {
    // The document a previous session left behind — valid, on disk, and NOT this run's work.
    mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
    writeFileSync(join(dir, DOC), 'requirements:\n  - id: REQ-001\n');
    // Make it unmistakably older than the run, as the real one was (six hours).
    const old = new Date(Date.now() - 6 * 3600 * 1000);
    utimesSync(join(dir, DOC), old, old);

    // The runtime produces nothing at all — the observed silent agent turn.
    const res = await run(dir, runtimeDoing(() => {}), artifacts);

    assert.equal(res.status, 'failed', 'a step that produced nothing is not a completed step');
    const step = res.steps.find((s) => s.stepId === 'req_intake');
    assert.equal(step?.status, 'failed');
    assert.match(
      step?.summary ?? '',
      /docs\/requirements\/intake\.yaml/,
      'the refusal names the path that was not produced',
    );
    assert.match(
      step?.summary ?? '',
      /was not written during this step/,
      'the refusal says the file was not written during THIS step',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

test('a declared output that does not exist at all also FAILS the step', async () => {
  const { dir, artifacts } = dirs();
  try {
    const res = await run(dir, runtimeDoing(() => {}), artifacts);
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'req_intake')?.summary ?? '', /was not written during this step/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// (b) no false red: a runtime that writes the document is a completed step
// ---------------------------------------------------------------------------------------------

test('a declared output the step DID write is a completed step', async () => {
  const { dir, artifacts } = dirs();
  try {
    const res = await run(
      dir,
      runtimeDoing((cwd) => {
        mkdirSync(join(cwd, dirname(DOC)), { recursive: true });
        writeFileSync(join(cwd, DOC), 'requirements:\n  - id: REQ-001\n    title: from this run\n');
      }),
      artifacts,
    );
    assert.equal(res.status, 'completed');
    assert.equal(res.steps.find((s) => s.stepId === 'req_intake')?.status, 'completed');
    assert.match(readFileSync(join(dir, DOC), 'utf8'), /from this run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// (c) the real manifest: the intake's agent step declares the document it must produce
// ---------------------------------------------------------------------------------------------

test('the REAL intake manifests declare the document its agent step must produce, and a repair round around it', () => {
  // The intake is a `repair` round over its own sub-workflow (ADR-057): the agent that writes the
  // document and the gate that reads it live together in `intake-attempt`, so a document the gate refuses
  // gets a SECOND attempt told exactly what was refused, instead of the run being thrown away (measured
  // 2026-10-12: three of four unattended chains lost the whole run at the gate for three different reasons
  // — docs/bugs-fixed.md #69, #70).
  const parent = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/request-intake/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  assert.deepEqual(validateWorkflowManifest(parent), [], 'the shipped manifest passes its own validator');

  const attempt = (parent.steps ?? []).find((s) => s.id === 'intake_attempt');
  assert.equal(attempt?.type, 'repair', 'the intake runs one repairable attempt, not a bare agent step');
  assert.equal(attempt?.repairRef, 'intake-attempt');
  assert.equal(attempt?.maxRounds, 2, 'a bad sample is repaired once rather than losing the run');
  const confirmation = (parent.steps ?? []).find((s) => s.id === 'ambiguity_confirmation');
  assert.ok(
    (confirmation?.dependsOn ?? []).includes('intake_attempt'),
    'the confirmation happens after the attempt that owns the gate, not after a bare agent step',
  );

  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  assert.deepEqual(validateWorkflowManifest(def), [], 'the attempt manifest passes its own validator');

  const agent = (def.steps ?? []).find((s) => s.type === 'agent');
  assert.ok(agent, 'the attempt has an agent step');
  assert.deepEqual(
    agent?.produces,
    ['docs/requirements/intake.yaml'],
    'the agent step declares the document it must write, so an intake that writes nothing is refused instead of graded on a file it did not produce',
  );
  assert.equal(agent?.timeoutMs, 900_000, 'the bound per attempt stays where it is: 15 minutes');
  assert.match(
    String(agent?.prompt ?? ''),
    /\{repairFailures\}/,
    'the next attempt is handed the failing checks the gate reported — the whole point of the repair round',
  );

  // The gate that reads the document must depend on the step that produces it, or the declaration
  // is checked after something has already read the stale file.
  const gate = (def.steps ?? []).find((s) => s.type === 'acceptance');
  assert.ok((gate?.dependsOn ?? []).includes(agent?.id ?? ''), 'the shape gate depends on the agent step');
});

// ---------------------------------------------------------------------------------------------
// (d) the declaration is only honoured where it is executed — elsewhere it is refused by name
// ---------------------------------------------------------------------------------------------

test('a manifest declaring produces on a step type whose output is NOT checked is refused by name', () => {
  const def: WorkflowDefinition = {
    name: 'produces-on-a-gate',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'shape', type: 'quality_gate', prompt: 'npm test', produces: [DOC] }],
  };
  const issues = validateWorkflowManifest(def);
  const refusal = issues.find((i) => /produces/.test(i.message));
  assert.ok(refusal, `expected a refusal naming produces, got: ${JSON.stringify(issues)}`);
  assert.equal(refusal?.stepId, 'shape');
  assert.match(
    refusal?.message ?? '',
    /only an agent step/,
    'the refusal says where a declared output is actually checked',
  );
});
