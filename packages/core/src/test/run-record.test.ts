import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  readRunRecords,
  requirementDigest,
  RUN_RECORD_DIR,
  runRecordPath,
  summarizeRuns,
  type RunRecord,
  type SandboxRoots,
  type StepSandbox,
  type WorkflowDefinition,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

/** A minimal context that drives the REAL engine over a temp project directory. */
function ctx(onResult: (task: { prompt: string }) => string | void = () => 'done') {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-runrecord-'));
  return {
    dir,
    exec: {
      cwd: dir,
      runtime: new TestRuntime(onResult as never),
      artifacts: new ArtifactStore(join(dir, 'artifacts')),
      onApproval: () => true,
      onEvent: () => {},
    },
  };
}

/** Read the one record a run wrote in `dir`, and its file name. */
function readRecord(dir: string): { record: RunRecord; file: string } {
  const runsDir = join(dir, RUN_RECORD_DIR);
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, `exactly one run record was written (${files.join(', ')})`);
  const file = files[0]!;
  return { record: JSON.parse(readFileSync(join(runsDir, file), 'utf8')) as RunRecord, file };
}

test('run record: a completed run writes .takumi/runs/<run-id>.json with the expected fields', async () => {
  const c = ctx((task) => `did(${task.prompt})`);
  try {
    const wf: WorkflowDefinition = {
      name: 'record-shape',
      version: '0.1.0',
      description: 'two agent steps',
      steps: [
        { id: 'design', type: 'agent', prompt: 'design it' },
        { id: 'impl', type: 'agent', prompt: 'implement it', dependsOn: ['design'] },
      ],
    };
    const res = await executeWorkflow(wf, c.exec);
    assert.equal(res.status, 'completed');

    const { record, file } = readRecord(c.dir);
    // The file is named after the run id, and the record carries the same id.
    assert.equal(file, `${record.runId}.json`);
    assert.match(record.runId, /^wf-[0-9a-f]{8}$/);
    assert.equal(record.workflow, 'record-shape');
    assert.equal(record.requirement, null, 'no confirmed requirement was on record');
    assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(record.durationMs >= 0);

    // Per-step: id, kind, status, duration, summary.
    assert.deepEqual(
      record.steps.map((s) => [s.id, s.kind, s.status]),
      [
        ['design', 'agent', 'done'],
        ['impl', 'agent', 'done'],
      ],
    );
    for (const step of record.steps) {
      assert.ok(typeof step.durationMs === 'number' && step.durationMs >= 0, `${step.id} has a duration`);
      assert.ok(step.summary.length > 0, `${step.id} has a summary line`);
    }
    assert.equal(record.steps[1]?.summary, 'did(implement it)');

    assert.equal(record.outcome, 'completed');
    assert.equal(record.exitCode, 0);
    assert.equal(record.accepted, true);
    assert.equal(record.failure, null);
    assert.deepEqual(record.published, { pullRequest: null, issue: null, mergedSha: null });
    assert.equal(record.boardRowId, null);

    // COST: TestRuntime reports a usage for each agent task (2 tokens each), so the record
    // carries the runtime's own numbers — never an invented one.
    assert.equal(record.cost.available, true);
    if (record.cost.available) {
      assert.equal(record.cost.runtimeId, 'test');
      assert.equal(record.cost.totalTokens, 4);
      assert.equal(record.cost.stepsReporting, 2);
    }
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('run record: a failed run names the failing step and its own message', async () => {
  const c = ctx((task) => {
    if (task.prompt.includes('explode')) throw new Error('the implementer exploded');
    return 'ok';
  });
  try {
    const wf: WorkflowDefinition = {
      name: 'record-failure',
      version: '0.1.0',
      description: 'a step that fails',
      steps: [
        { id: 'design', type: 'agent', prompt: 'design it' },
        { id: 'impl', type: 'agent', prompt: 'explode now', dependsOn: ['design'] },
        { id: 'deliver', type: 'agent', prompt: 'ship it', dependsOn: ['impl'] },
      ],
    };
    const res = await executeWorkflow(wf, c.exec);
    assert.equal(res.status, 'failed');

    const { record } = readRecord(c.dir);
    assert.equal(record.outcome, 'failed');
    assert.equal(record.exitCode, 1);
    assert.equal(record.accepted, false);
    // The failure names WHICH step, and THAT step's own message.
    assert.equal(record.failure?.stepId, 'impl');
    assert.match(record.failure?.message ?? '', /the implementer exploded/);
    // The failing step is marked failed; its dependent was skipped, not run.
    assert.equal(record.steps.find((s) => s.id === 'impl')?.status, 'failed');
    assert.equal(record.steps.find((s) => s.id === 'deliver')?.status, 'skipped');
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('run record: cost says plainly when the runtime reports no token usage', async () => {
  const c = ctx();
  try {
    // A run with no agent step: the runtime reported no token usage at all. The field must say so
    // rather than carry a zero that would read as "free".
    const wf: WorkflowDefinition = {
      name: 'record-nocost',
      version: '0.1.0',
      description: 'a tool-only run',
      steps: [{ id: 'probe', type: 'tool', prompt: 'echo hello' }],
    };
    const res = await executeWorkflow(wf, c.exec);
    assert.equal(res.status, 'completed');

    const { record } = readRecord(c.dir);
    assert.equal(record.cost.available, false);
    if (!record.cost.available) {
      assert.match(record.cost.why, /no token usage/);
    }
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('run record: runRecordPath refuses an id that is not a legal file name', () => {
  assert.throws(() => runRecordPath('/tmp', '../escape'), /file name/);
});

test('run records: the aggregator folds three fixtures and names the malformed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-agg-'));
  try {
    const base = {
      requirement: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      published: { pullRequest: null, issue: null, mergedSha: null },
      boardRowId: null,
      exitCode: 0,
    };
    const success: RunRecord = {
      ...base,
      runId: 'wf-success',
      workflow: 'wf',
      durationMs: 1000,
      outcome: 'completed',
      accepted: true,
      failure: null,
      steps: [{ id: 'impl', kind: 'agent', status: 'done', durationMs: 1000, summary: 'ok' }],
      cost: { available: true, runtimeId: 'r', models: ['m'], promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.5, stepsReporting: 1 },
    };
    const failure: RunRecord = {
      ...base,
      runId: 'wf-failure',
      workflow: 'wf',
      durationMs: 3000,
      outcome: 'failed',
      accepted: false,
      exitCode: 1,
      failure: { stepId: 'quality_gate', message: 'quality_gate FAILED: 2 failing over 5 tests' },
      steps: [
        { id: 'impl', kind: 'agent', status: 'done', durationMs: 1000, summary: 'ok' },
        { id: 'quality_gate', kind: 'quality_gate', status: 'failed', durationMs: 2000, summary: 'quality_gate FAILED' },
      ],
      cost: { available: true, runtimeId: 'r', models: ['m'], promptTokens: 12, completionTokens: 8, totalTokens: 20, costUsd: 0.25, stepsReporting: 1 },
    };
    const noCost: RunRecord = {
      ...base,
      runId: 'wf-nocost',
      workflow: 'wf',
      durationMs: 2000,
      outcome: 'completed',
      accepted: true,
      failure: null,
      steps: [{ id: 'impl', kind: 'agent', status: 'done', durationMs: 2000, summary: 'ok' }],
      cost: { available: false, why: 'the runtime reports no token usage' },
    };
    const runsDir = join(dir, RUN_RECORD_DIR);
    writeFileSync(join(dir, 'placeholder'), '');
    fs.mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'wf-success.json'), JSON.stringify(success));
    writeFileSync(join(runsDir, 'wf-failure.json'), JSON.stringify(failure));
    writeFileSync(join(runsDir, 'wf-nocost.json'), JSON.stringify(noCost));
    writeFileSync(join(runsDir, 'broken.json'), '{ this is not json');

    const { records, unreadable } = readRunRecords(runsDir);
    assert.equal(records.length, 3);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0]?.file, 'broken.json');
    assert.match(unreadable[0]?.reason ?? '', /not valid JSON/);

    const agg = summarizeRuns(records, unreadable);
    assert.equal(agg.runs, 3);
    assert.equal(agg.succeeded, 2);
    assert.equal(agg.failed, 1);
    assert.equal(agg.cancelled, 0);
    assert.ok(Math.abs(agg.successRate - 2 / 3) < 1e-9);
    assert.equal(agg.medianDurationMs, 2000);
    assert.equal(agg.worstDurationMs, 3000);
    assert.equal(agg.worstRunId, 'wf-failure');
    assert.deepEqual(agg.mostFailingStep, { stepId: 'quality_gate', count: 1 });
    assert.equal(agg.cost.available, true);
    assert.equal(agg.cost.totalCostUsd, 0.75);
    assert.equal(agg.cost.totalTokens, 35);
    assert.equal(agg.cost.runsWithCost, 2);
    assert.equal(agg.cost.runsWithoutCost, 1);
    assert.match(agg.cost.why ?? '', /1 of 3/);
    assert.equal(agg.unreadable.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run records: a valid JSON file that is not a record is reported, not counted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-agg2-'));
  try {
    writeFileSync(join(dir, 'not-a-record.json'), JSON.stringify({ hello: 'world' }));
    const { records, unreadable } = readRunRecords(dir);
    assert.equal(records.length, 0);
    assert.equal(unreadable.length, 1);
    assert.match(unreadable[0]?.reason ?? '', /not a run record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The requirement binding says HOW it was confirmed (ADR-045 §4). Keeping the confirmation INSIDE the
// requirement binding is deliberate: it is impossible to read which document a run was bound to without
// also reading whether a human confirmed it or an authorization defaulted it — and, when it was an
// authorization, WHICH answers nobody read.

const CONFIRMED_DOC = [
  'requirements:',
  '  - id: REQ-001',
  '    title: "Summarise the readings"',
  '    description: "Print one aggregate line per station."',
  '    acceptance_criteria:',
  '      - "A third party can check the summary."',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: "How are unparseable rows handled?"',
  '    options: ["skip-count: skipped and counted", "stop-error: abort"]',
  '    default: "skip-count: skipped and counted"',
  '    chosen: "skip-count: skipped and counted"',
  '    checkedAs: skip-count',
  '    blocking: true',
  'confirmation:',
  '  by: "moon"',
  '  at: "2026-10-11T09:17:13.940Z"',
  '  method: standing-authorization',
  '  authorization:',
  '    ref: "docs/authorizations/SA-001.yaml"',
  '    digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"',
  '    signedBy: "moon"',
  '    signedAt: "2026-10-11T00:00:00Z"',
  '    expiresAt: "2026-11-11T00:00:00Z"',
  '  defaulted:',
  '    - id: AMB-001',
  '      question: "How are unparseable rows handled?"',
  '      chosen: "skip-count: skipped and counted"',
  '      class: malformed-row-accounting',
  '      policy: document-default',
  '      checkedAs: skip-count',
  '',
].join('\n');

test('run record: the requirement binding carries HOW it was confirmed, and what nobody read', async () => {
  const c = ctx();
  const ref = 'docs/requirements/feature.yaml';
  fs.mkdirSync(join(c.dir, 'docs/requirements'), { recursive: true });
  writeFileSync(join(c.dir, ref), CONFIRMED_DOC, 'utf8');
  try {
    const wf: WorkflowDefinition = {
      name: 'record-confirmation',
      version: '0.1.0',
      description: 'one agent step',
      steps: [{ id: 'impl', type: 'agent', prompt: 'implement it' }],
    };
    const res = await executeWorkflow(wf, {
      ...c.exec,
      confirmedRequirement: { ref, digest: requirementDigest(CONFIRMED_DOC) },
    });
    assert.equal(res.status, 'completed');

    const { record } = readRecord(c.dir);
    assert.equal(record.requirement?.ref, ref);
    const confirmation = record.requirement?.confirmation;
    assert.equal(confirmation?.mode, 'standing-authorization');
    assert.equal(confirmation?.by, 'moon', 'by is the SIGNER, not the process that ran the command');
    assert.equal(confirmation?.authorization?.signedBy, 'moon');
    assert.equal(confirmation?.authorization?.expiresAt, '2026-11-11T00:00:00Z');
    assert.deepEqual(confirmation?.defaulted.map((d) => [d.id, d.class, d.checkedAs]), [
      ['AMB-001', 'malformed-row-accounting', 'skip-count'],
    ]);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('run record: a document with no confirmation block reads as digest-only, not as one of the other two', async () => {
  const c = ctx();
  const ref = 'docs/requirements/feature.yaml';
  fs.mkdirSync(join(c.dir, 'docs/requirements'), { recursive: true });
  writeFileSync(join(c.dir, ref), 'requirements:\n  - id: REQ-001\n    title: "A thing"\n    acceptance_criteria:\n      - "checkable"\n', 'utf8');
  try {
    const wf: WorkflowDefinition = {
      name: 'record-digest-only',
      version: '0.1.0',
      description: 'one agent step',
      steps: [{ id: 'impl', type: 'agent', prompt: 'implement it' }],
    };
    const res = await executeWorkflow(wf, { ...c.exec, confirmedRequirement: { ref, digest: 'c'.repeat(64) } });
    assert.equal(res.status, 'completed');

    const { record } = readRecord(c.dir);
    const confirmation = record.requirement?.confirmation;
    assert.equal(confirmation?.mode, 'digest-only');
    assert.equal(confirmation?.by, null);
    assert.equal(confirmation?.method, null);
    assert.equal(confirmation?.authorization, null);
    assert.deepEqual(confirmation?.defaulted, []);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// WHICH BOUNDARY WAS IN FORCE (ledger #88)
//
// `sandbox: unshare` conflated three properties, and reading it as "the model's hands were
// contained" is exactly the mistake the stale pi artifact recorded. The AGENT's-tools boundary is
// DERIVED from what the runtime reports it did, never asserted from configuration — the engine
// supplies `sandbox` + `sandboxRoots`, but only the runtime turns them into confined tools.
// ---------------------------------------------------------------------------------------------

/** A runtime that reports it built a confined session — the pi adapter's contract, without importing pi. */
class ConfiningTestRuntime extends TestRuntime {
  agentToolBoundary(): 'confined' | 'open' {
    return 'confined';
  }
}

const STUB_SANDBOX: StepSandbox = {
  id: 'stub',
  runStep: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }),
  close: async () => {},
};

const ROOTS = (dir: string): SandboxRoots => ({ rw: [dir], ro: [], cwd: dir });

test('run record: a confined runtime names the agent-tools boundary, derived from what it reported', async () => {
  const c = ctx();
  try {
    const wf: WorkflowDefinition = {
      name: 'boundary-confined',
      version: '0.1.0',
      description: 'one agent step',
      steps: [{ id: 'impl', type: 'agent', prompt: 'implement it' }],
    };
    const res = await executeWorkflow(wf, {
      ...c.exec,
      runtime: new ConfiningTestRuntime(() => 'done', { capabilities: ['streaming'], maxParallelTasks: 4 }, 'pi'),
      sandbox: STUB_SANDBOX,
      sandboxRoots: ROOTS(c.dir),
    });
    assert.equal(res.status, 'completed');

    const { record } = readRecord(c.dir);
    assert.equal(record.boundaries?.agentTools, 'confined');
    assert.equal(record.boundaries?.agentRuntime, 'pi', 'the runtime that ran the agent step is named');
    assert.equal(record.boundaries?.stepCommands, 'none', "the platform's own commands are not confined (ledger #79)");
    assert.equal(record.boundaries?.acceptanceSubject, 'none', 'no acceptance step ran, so no subject was contained');
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test("run record: a runtime that cannot confine the agent's tools does NOT claim confinement", async () => {
  const c = ctx();
  try {
    const wf: WorkflowDefinition = {
      name: 'boundary-open',
      version: '0.1.0',
      description: 'one agent step',
      steps: [{ id: 'impl', type: 'agent', prompt: 'implement it' }],
    };
    // A boundary was SUPPLIED, but this runtime has no `agentToolBoundary`: it may not be recorded
    // as confined. `open` is the honest answer (a boundary was asked for and not confirmed).
    const res = await executeWorkflow(wf, {
      ...c.exec,
      sandbox: STUB_SANDBOX,
      sandboxRoots: ROOTS(c.dir),
    });
    assert.equal(res.status, 'completed');

    const { record } = readRecord(c.dir);
    assert.equal(record.boundaries?.agentTools, 'open');
    assert.notEqual(record.boundaries?.agentTools, 'confined');
    assert.equal(record.boundaries?.agentRuntime, 'test');
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('run record: with no boundary supplied there is no agent-tools boundary to claim', async () => {
  const c = ctx();
  try {
    const wf: WorkflowDefinition = {
      name: 'boundary-none',
      version: '0.1.0',
      description: 'one tool step, sandbox: none',
      steps: [{ id: 'probe', type: 'tool', prompt: 'echo hello' }],
    };
    const res = await executeWorkflow(wf, c.exec); // no sandbox/sandboxRoots/sandboxNote
    assert.equal(res.status, 'completed');

    const { record } = readRecord(c.dir);
    assert.equal(record.sandbox, 'none', 'the compatibility string is unchanged');
    assert.equal(record.boundaries?.agentTools, 'none');
    assert.equal(record.boundaries?.acceptanceSubject, 'none');
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});
