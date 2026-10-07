import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  runReviewRules,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';
import type { CheckSummary, DeliveryProvider, PullRequestRef } from '../delivery.js';

/**
 * The two CI/CD steps (ADR-037).
 *
 * These drive the REAL engine, the way `repair-rounds.test.ts` and `publish-step.test.ts` do: a workflow
 * definition goes in, the engine dispatches the step, and what these tests read is what the step actually
 * did — the file it wrote, the summary it produced, and the verdict it reached. Nothing here asserts that a
 * step "would" fail: a red pipeline is a red run, a pending pipeline that times out is a failed run, and a
 * host that cannot report checks is a failure that says so.
 */

const DOC = [
  'requirements: []',
  'deliverable:',
  '  run: "bash summary.sh {csv}"',
  '  input_format:',
  '    columns: "date:date,station:id,temperature_c:measure"',
  '    sample: |',
  '      2024-01-01,ALPHA,10.4',
  '      2024-01-01,BRAVO,-2.5',
  '      2024-01-02,ALPHA,11.6',
  '',
].join('\n');

interface Project {
  dir: string;
  worktree: string;
  docRef: string;
  cleanup: () => void;
}

/** A project directory holding the requirement document, plus a SEPARATE delivery worktree. */
function fixture(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-ci-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(dir, 'docs', 'requirements', 'feature.yaml'), DOC);
  return {
    dir,
    worktree,
    docRef: 'docs/requirements/feature.yaml',
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A step whose `ref` field is read at runtime; the type carries it as an optional extra. */
type StepWithRef = WorkflowStep & { ref?: string };

interface StepResult {
  status: string;
  summary: string;
  artifacts: string[];
}

async function runStep(
  p: Project,
  step: StepWithRef,
  delivery?: DeliveryProvider,
): Promise<{ status: string; step: StepResult | undefined }> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-ci-artifacts-'));
  try {
    const wf: WorkflowDefinition = { name: 'ci-steps', version: '0.0.1', description: '', steps: [step] };
    const ctx: Parameters<typeof executeWorkflow>[1] = {
      cwd: p.dir,
      worktree: p.worktree,
      runtime: new TestRuntime(() => 'ok'),
      artifacts: new ArtifactStore(artifacts),
      onApproval: () => true,
      confirmedRequirement: { ref: p.docRef, digest: 'confirmed-digest' },
    };
    if (delivery !== undefined) ctx.delivery = delivery;
    const res = await executeWorkflow(wf, ctx, {});
    const s = res.steps.find((r) => r.stepId === step.id);
    return { status: res.status, step: s === undefined ? undefined : { status: s.status, summary: s.summary, artifacts: s.artifacts } };
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// (a) ci_config — write the host's pipeline into the delivery
// ---------------------------------------------------------------------------------------------

test('ci_config: writes the pipeline file with the DELIVERED project\'s own test command and the document\'s run command', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = {
      id: 'ci_config',
      type: 'ci_config',
      testCommand: 'node --test',
      dialect: 'github',
      requirementRef: p.docRef,
    };
    const r = await runStep(p, step);

    assert.equal(r.status, 'completed', r.step?.summary);
    assert.equal(r.step?.status, 'completed');

    // The file is a real file in the DELIVERY worktree — a human reads it and a repair round can fix it.
    const file = join(p.worktree, '.github', 'workflows', 'ci.yml');
    assert.ok(existsSync(file), `the pipeline file must exist in the delivery worktree (${file})`);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /node --test/, "the pipeline runs the DELIVERED project's own test command");
    assert.match(content, /bash summary\.sh takumi-sample\.csv/, 'the deliverable run from the document is in the pipeline');
    assert.match(content, /2024-01-01,ALPHA,10\.4/, 'the sample the document declares is embedded for the smoke run');
    assert.ok(!content.includes('{csv}'), 'the {csv} placeholder is resolved, never left in the pipeline');

    // The summary says out loud what the delivery now contains, and the protected-path consequence.
    assert.match(r.step?.summary ?? '', /the delivery now CONTAINS the pipeline that will judge it/);
    assert.match(r.step?.summary ?? '', /the DELIVERED project's own tests, not takumi's/);
    assert.match(r.step?.summary ?? '', /protected path: CI configuration is a protected path/);
    assert.ok((r.step?.artifacts.length ?? 0) > 0, 'the generated file is also recorded as a run artifact a human can read');
  } finally {
    p.cleanup();
  }
});

test('ci_config: the forgejo dialect writes .forgejo/workflows/ci.yml', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', testCommand: 'pnpm test', dialect: 'forgejo' };
    const r = await runStep(p, step);
    assert.equal(r.status, 'completed', r.step?.summary);
    const file = join(p.worktree, '.forgejo', 'workflows', 'ci.yml');
    assert.ok(existsSync(file), 'the forgejo dialect writes the forgejo path');
    assert.match(readFileSync(file, 'utf8'), /pnpm test/);
    assert.ok(!existsSync(join(p.worktree, '.github', 'workflows', 'ci.yml')), 'the forgejo dialect does not write the github path');
  } finally {
    p.cleanup();
  }
});

test('ci_config: REFUSES when the workflow declares no test command — a pipeline that runs no tests is decoration', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', requirementRef: p.docRef };
    const r = await runStep(p, step);
    assert.equal(r.status, 'failed');
    assert.equal(r.step?.status, 'failed');
    assert.match(r.step?.summary ?? '', /declares no testCommand/);
    assert.match(r.step?.summary ?? '', /refusing to write a CI file that judges nothing/);
    // Nothing was written: a refusal is not a file that merely fails to mention it.
    assert.ok(!existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')));
    assert.ok(!existsSync(join(p.worktree, '.github', 'workflows', 'ci.yml')));
  } finally {
    p.cleanup();
  }
});

test('ci_config: REFUSES when the named requirement document cannot be read, rather than guessing its run command', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', testCommand: 'node --test', requirementRef: 'docs/requirements/missing.yaml' };
    const r = await runStep(p, step);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /could not be read/);
  } finally {
    p.cleanup();
  }
});

test('ci_config: the deterministic reviewer reports the created pipeline as a NOTE, not a silent pass (ADR-032)', () => {
  const sha = (c: string): string => c.repeat(40);
  // `.github/workflows/` is protected by the reviewer's defaults; `.forgejo/workflows/` is added by the
  // workflow's rule_review step so the forgejo dialect is covered too. A CREATED protected path is a note.
  const findings = runReviewRules(
    {
      baseSha: sha('a'),
      headSha: sha('b'),
      changes: [
        { path: '.github/workflows/ci.yml', status: 'added', baseContent: null, headContent: 'name: ci' },
        { path: '.forgejo/workflows/ci.yml', status: 'added', baseContent: null, headContent: 'name: ci' },
      ],
    },
    { protectedPaths: ['(^|/)\\.forgejo/workflows/'] },
  );
  const github = findings.find((f) => f.rule === 'protected-path' && f.path === '.github/workflows/ci.yml');
  const forgejo = findings.find((f) => f.rule === 'protected-path' && f.path === '.forgejo/workflows/ci.yml');
  assert.equal(github?.severity, 'note', 'the created github pipeline is reported as a note');
  assert.equal(forgejo?.severity, 'note', 'the created forgejo pipeline is reported as a note');

  // The rule keeps its teeth where the path already existed: a CHANGE is still a human's call.
  const modified = runReviewRules({
    baseSha: sha('a'),
    headSha: sha('b'),
    changes: [{ path: '.github/workflows/ci.yml', status: 'modified', baseContent: 'name: ci', headContent: 'name: ci2' }],
  });
  assert.equal(modified.find((f) => f.rule === 'protected-path')?.severity, 'human');
});

// ---------------------------------------------------------------------------------------------
// (b) await_checks — wait for the host's pipeline on the delivered head, fail closed when it is not green
// ---------------------------------------------------------------------------------------------

interface CheckStub extends DeliveryProvider {
  calls: number;
}

/** A provider whose `checks()` returns a scripted sequence (the last entry repeats). */
function checkProvider(sequence: CheckSummary[][], opts: { canRunChecks?: boolean; throwOnChecks?: boolean } = {}): CheckStub {
  const provider: CheckStub = {
    calls: 0,
    metadata: () => ({ id: 'stub', name: 'stub', version: '0' }),
    capabilities: () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: opts.canRunChecks !== false, canMerge: false }),
    async deliver() {
      return { created: true, push: { mode: 'plain', branch: 'task', head: 'head1' }, notes: [] };
    },
    async status() {
      return { state: 'open', headSha: 'head1', baseSha: 'base1', mergeable: true };
    },
    async checks(): Promise<CheckSummary[]> {
      if (opts.throwOnChecks === true) throw new Error('the host answered 500');
      const at = Math.min(provider.calls, sequence.length - 1);
      provider.calls += 1;
      return sequence[at] ?? [];
    },
    async merge(_ref: PullRequestRef) {
      return { merged: true, method: 'merge', headSha: 'head1', url: 'https://host/pulls/7' };
    },
  };
  return provider;
}

const awaitStep = (waitSeconds?: number): StepWithRef => ({
  id: 'await_checks',
  type: 'await_checks',
  ref: 'https://host/pulls/7',
  ...(waitSeconds === undefined ? {} : { waitSeconds }),
});

test('await_checks: every check success is the only pass', async () => {
  const p = fixture();
  const provider = checkProvider([[{ name: 'build', conclusion: 'success', url: 'https://host/checks/1' }, { name: 'tests', conclusion: 'success' }]]);
  try {
    const r = await runStep(p, awaitStep(), provider);
    assert.equal(r.status, 'completed', r.step?.summary);
    assert.match(r.step?.summary ?? '', /all 2 check\(s\) succeeded/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a RED pipeline fails the run, naming the failing check and its URL', async () => {
  const p = fixture();
  const provider = checkProvider([[{ name: 'build', conclusion: 'failure', url: 'https://host/checks/1' }, { name: 'tests', conclusion: 'success' }]]);
  try {
    const r = await runStep(p, awaitStep(), provider);
    assert.equal(r.status, 'failed');
    assert.equal(r.step?.status, 'failed');
    assert.match(r.step?.summary ?? '', /1 check\(s\) FAILED/);
    assert.match(r.step?.summary ?? '', /build \(https:\/\/host\/checks\/1\)/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a pipeline still PENDING at the timeout fails, naming the checks still pending', async () => {
  const p = fixture();
  // Always pending: the budget (1s) runs out and the step must not call that a pass.
  const provider = checkProvider([[{ name: 'build', conclusion: 'pending', url: 'https://host/checks/1' }]]);
  try {
    const r = await runStep(p, awaitStep(1), provider);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /still PENDING after 1s/);
    assert.match(r.step?.summary ?? '', /build \(https:\/\/host\/checks\/1\)/);
    assert.ok(provider.calls >= 2, 'the step polls until the budget is spent, not once');
  } finally {
    p.cleanup();
  }
});

test('await_checks: a pipeline that settles from pending to success passes (the wait is real)', async () => {
  const p = fixture();
  const provider = checkProvider([[{ name: 'build', conclusion: 'pending' }], [{ name: 'build', conclusion: 'success' }]]);
  try {
    const r = await runStep(p, awaitStep(2), provider);
    assert.equal(r.status, 'completed', r.step?.summary);
    assert.match(r.step?.summary ?? '', /all 1 check\(s\) succeeded/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a host that cannot report checks at all fails LOUDLY, never a pass by default', async () => {
  const p = fixture();
  const provider = checkProvider([[]], { canRunChecks: false });
  try {
    const r = await runStep(p, awaitStep(), provider);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /cannot report checks \(capabilities\.canRunChecks is false\)/);
    assert.match(r.step?.summary ?? '', /refusing to report a green pipeline that was never read/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a host that reports NO checks fails — "no checks" is not a pass', async () => {
  const p = fixture();
  const provider = checkProvider([[]]);
  try {
    const r = await runStep(p, awaitStep(), provider);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /reported NO checks/);
    assert.match(r.step?.summary ?? '', /"no checks" is not a pass/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a checks() that throws fails, saying what the host said', async () => {
  const p = fixture();
  const provider = checkProvider([[]], { throwOnChecks: true });
  try {
    const r = await runStep(p, awaitStep(), provider);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /could not report checks/);
    assert.match(r.step?.summary ?? '', /the host answered 500/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a run with no delivery provider fails — a pipeline nobody could read is not green', async () => {
  const p = fixture();
  try {
    const r = await runStep(p, awaitStep(), undefined);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /no delivery provider \(ctx\.delivery\)/);
  } finally {
    p.cleanup();
  }
});
