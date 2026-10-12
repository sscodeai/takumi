import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ArtifactStore,
  executeWorkflow,
  runReviewRules,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';
import { dialectForDeliveryProvider, renderCiConfig, type CiDialect } from '../ci-pipeline.js';
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

/**
 * Run several steps through the REAL engine, seeding the run vars (so `vars.deliveryRef`, which the
 * `publish` step normally sets, can be present without a publish step). This is what the host-report
 * tests need: a red pipeline AND a published reference, driven by the engine, not simulated.
 */
async function runSteps(
  p: Project,
  steps: StepWithRef[],
  delivery: DeliveryProvider | undefined,
  vars: Record<string, string>,
): Promise<{ status: string; steps: Array<{ stepId: string; status: string; summary: string }> }> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-ci-artifacts-'));
  try {
    const wf: WorkflowDefinition = { name: 'ci-steps', version: '0.0.1', description: '', steps };
    const ctx: Parameters<typeof executeWorkflow>[1] = {
      cwd: p.dir,
      worktree: p.worktree,
      runtime: new TestRuntime(() => 'ok'),
      artifacts: new ArtifactStore(artifacts),
      onApproval: () => true,
      confirmedRequirement: { ref: p.docRef, digest: 'confirmed-digest' },
    };
    if (delivery !== undefined) ctx.delivery = delivery;
    const res = await executeWorkflow(wf, ctx, vars);
    return { status: res.status, steps: res.steps.map((s) => ({ stepId: s.stepId, status: s.status, summary: s.summary })) };
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

test('ci_config: the gitlab dialect writes .gitlab-ci.yml as GitLab CI YAML, derived the same way', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = {
      id: 'ci_config',
      type: 'ci_config',
      testCommand: 'node --test',
      dialect: 'gitlab',
      requirementRef: p.docRef,
    };
    const r = await runStep(p, step);
    assert.equal(r.status, 'completed', r.step?.summary);

    // The file is the delivery's own pipeline, at GitLab's single root path.
    const file = join(p.worktree, '.gitlab-ci.yml');
    assert.ok(existsSync(file), `the gitlab dialect writes .gitlab-ci.yml (${file})`);
    const content = readFileSync(file, 'utf8');
    // It is GitLab CI YAML — a DIFFERENT language from the GitHub-Actions dialects.
    assert.match(content, /^stages:/m, 'GitLab CI declares stages');
    assert.match(content, /^tests:/m, 'the tests job exists');
    assert.match(content, /^  stage: test$/m);
    assert.doesNotMatch(content, /runs-on:/, 'a GitLab pipeline has no GitHub Actions runner key');
    // Derived the same way: the DELIVERED project's own test command and the document's run.
    assert.match(content, /node --test/, "the pipeline runs the DELIVERED project's own test command");
    assert.match(content, /bash summary\.sh takumi-sample\.csv/, 'the deliverable run from the document is in the pipeline');
    assert.match(content, /2024-01-01,ALPHA,10\.4/, 'the sample the document declares is embedded for the smoke run');
    assert.ok(!content.includes('{csv}'), 'the {csv} placeholder is resolved, never left in the pipeline');
    // It is a REAL GitLab CI file: the stages list and the tests job are there.
    assert.match(content, /^stages:\n  - test\n  - deliverable$/m, 'the stages are GitLab CI stages');
    assert.match(content, /^    - \|$/m, 'the script is a YAML block scalar');

    // The dialect is recorded in the summary, and the protected-path consequence holds by default.
    assert.match(r.step?.summary ?? '', /wrote \.gitlab-ci\.yml \(gitlab dialect, declared by the step\)/);
    assert.match(r.step?.summary ?? '', /protected path: CI configuration is a protected path/);

    // The gitlab dialect touches NEITHER of the GitHub-Actions paths.
    assert.ok(!existsSync(join(p.worktree, '.github', 'workflows', 'ci.yml')));
    assert.ok(!existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')));
  } finally {
    p.cleanup();
  }
});

test('ci_config: the existing forgejo/github dialects are untouched by the gitlab addition', async () => {
  const p = fixture();
  try {
    // forgejo → .forgejo/workflows/ci.yml, and NOT .gitlab-ci.yml.
    const forgejo = await runStep(p, { id: 'ci_config', type: 'ci_config', testCommand: 'pnpm test', dialect: 'forgejo' });
    assert.equal(forgejo.status, 'completed', forgejo.step?.summary);
    assert.ok(existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')));
    assert.ok(!existsSync(join(p.worktree, '.gitlab-ci.yml')), 'forgejo must not write the gitlab path');
    // The GitHub-Actions content is unchanged: `name: ci`, `on:`, `jobs:`.
    const forgejoText = readFileSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml'), 'utf8');
    assert.match(forgejoText, /^name: ci$/m);
    assert.match(forgejoText, /^on:$/m);
    assert.match(forgejoText, /runs-on: ubuntu-latest/);

    // github → .github/workflows/ci.yml, and NOT .gitlab-ci.yml.
    const github = await runStep(p, { id: 'ci_config', type: 'ci_config', testCommand: 'npm test', dialect: 'github' });
    assert.equal(github.status, 'completed', github.step?.summary);
    assert.ok(existsSync(join(p.worktree, '.github', 'workflows', 'ci.yml')));
    assert.ok(!existsSync(join(p.worktree, '.gitlab-ci.yml')), 'github must not write the gitlab path');
  } finally {
    p.cleanup();
  }
});

test('ci_config: the gitlab dialect is REFUSED with no test command, and writes nothing', async () => {
  const p = fixture();
  try {
    const r = await runStep(p, { id: 'ci_config', type: 'ci_config', dialect: 'gitlab', requirementRef: p.docRef });
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /declares no testCommand/);
    assert.ok(!existsSync(join(p.worktree, '.gitlab-ci.yml')), 'a refusal writes no file');
  } finally {
    p.cleanup();
  }
});

test('ci_config: the deterministic reviewer reports a CREATED .gitlab-ci.yml as a NOTE (ADR-032)', () => {
  const sha = (c: string): string => c.repeat(40);
  // `.gitlab-ci.yml` is a DEFAULT protected path (packages/core/src/review-rules.ts), so a created
  // one is a note; a CHANGE to one is still a human's call.
  const findings = runReviewRules({
    baseSha: sha('a'),
    headSha: sha('b'),
    changes: [{ path: '.gitlab-ci.yml', status: 'added', baseContent: null, headContent: 'stages: [test]' }],
  });
  assert.equal(findings.find((f) => f.rule === 'protected-path' && f.path === '.gitlab-ci.yml')?.severity, 'note');

  const modified = runReviewRules({
    baseSha: sha('a'),
    headSha: sha('b'),
    changes: [{ path: '.gitlab-ci.yml', status: 'modified', baseContent: 'stages: [test]', headContent: 'stages: [lint]' }],
  });
  assert.equal(modified.find((f) => f.rule === 'protected-path')?.severity, 'human');
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
// (a2) the dialect is DERIVED from the delivery provider unless the step declares one (bug #48)
// ---------------------------------------------------------------------------------------------

/**
 * A provider that only has to NAME its host: `metadata().id` is what the dialect is derived from, and
 * `ci_config` reads nothing else off the provider. The other methods are present because the port
 * requires them; a `ci_config` run never calls them.
 */
function hostProvider(id: string): DeliveryProvider {
  return {
    metadata: () => ({ id, name: id, version: '0' }),
    capabilities: () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: false }),
    async deliver() {
      return { created: true, push: { mode: 'plain', branch: 'task', head: 'head1' }, notes: [] };
    },
    async status() {
      return { state: 'open', headSha: 'head1', baseSha: 'base1', mergeable: true };
    },
    async checks(): Promise<CheckSummary[]> {
      return [];
    },
    async merge() {
      return { merged: true, method: 'merge', headSha: 'head1', url: 'https://host/pulls/7' };
    },
  };
}

test('ci_config: with NO dialect declared, a github delivery DERIVES the github dialect and writes the file GitHub runs', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', testCommand: 'node --test', requirementRef: p.docRef };
    const r = await runStep(p, step, hostProvider('github'));
    assert.equal(r.status, 'completed', r.step?.summary);
    assert.ok(
      existsSync(join(p.worktree, '.github', 'workflows', 'ci.yml')),
      'a `provider: github` run must write .github/workflows/ci.yml',
    );
    assert.ok(
      !existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')),
      'and NOT the forgejo path the old hard-coded default would have written (a file GitHub never runs)',
    );
    // The summary says WHY this path was chosen — the derivation is invisible otherwise.
    assert.match(
      r.step?.summary ?? '',
      /wrote \.github\/workflows\/ci\.yml \(github dialect, derived from the delivery provider "github"\)/,
    );
  } finally {
    p.cleanup();
  }
});

test('ci_config: a gitlab delivery derives .gitlab-ci.yml and a forgejo delivery derives .forgejo/workflows/ci.yml', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', testCommand: 'node --test' };

    const gitlab = await runStep(p, step, hostProvider('gitlab'));
    assert.equal(gitlab.status, 'completed', gitlab.step?.summary);
    assert.ok(existsSync(join(p.worktree, '.gitlab-ci.yml')), 'a gitlab delivery derives the GitLab CI dialect');
    assert.match(gitlab.step?.summary ?? '', /derived from the delivery provider "gitlab"/);
    rmSync(join(p.worktree, '.gitlab-ci.yml'), { force: true });

    const forgejo = await runStep(p, step, hostProvider('forgejo'));
    assert.equal(forgejo.status, 'completed', forgejo.step?.summary);
    assert.ok(existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')), 'a forgejo delivery derives the forgejo dialect');
    assert.match(forgejo.step?.summary ?? '', /derived from the delivery provider "forgejo"/);
  } finally {
    p.cleanup();
  }
});

test('ci_config: an EXPLICIT dialect declaration WINS over the delivery provider', async () => {
  const p = fixture();
  try {
    // The provider says github; the step says forgejo. The step's own declaration is the authority.
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', testCommand: 'node --test', dialect: 'forgejo' };
    const r = await runStep(p, step, hostProvider('github'));
    assert.equal(r.status, 'completed', r.step?.summary);
    assert.ok(existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')), 'the declared dialect is written');
    assert.ok(!existsSync(join(p.worktree, '.github', 'workflows', 'ci.yml')), 'the provider does NOT override an explicit declaration');
    assert.match(r.step?.summary ?? '', /\(forgejo dialect, declared by the step\)/);
  } finally {
    p.cleanup();
  }
});

test('ci_config: a provider that names no host (git / fake), or none at all, derives NOTHING and the default stands', async () => {
  const p = fixture();
  try {
    const step: StepWithRef = { id: 'ci_config', type: 'ci_config', testCommand: 'node --test' };

    // A bare git remote is not a host takumi writes a pipeline for: never invent a dialect for it.
    const bare = await runStep(p, step, hostProvider('git'));
    assert.equal(bare.status, 'completed', bare.step?.summary);
    assert.ok(existsSync(join(p.worktree, '.forgejo', 'workflows', 'ci.yml')), 'the historical forgejo default stands');
    assert.match(bare.step?.summary ?? '', /the default: the step declares no dialect and the delivery provider names no host/);

    // No provider at all is the same story: the default, said out loud.
    const none = await runStep(p, step, undefined);
    assert.equal(none.status, 'completed', none.step?.summary);
    assert.match(none.step?.summary ?? '', /the default: the step declares no dialect and the delivery provider names no host/);
  } finally {
    p.cleanup();
  }
});

test('dialectForDeliveryProvider: the provider id IS the dialect, and an unknown id derives nothing', () => {
  assert.equal(dialectForDeliveryProvider('github'), 'github');
  assert.equal(dialectForDeliveryProvider('gitlab'), 'gitlab');
  assert.equal(dialectForDeliveryProvider('forgejo'), 'forgejo');
  // Not dialects: a bare git remote, the fake provider, an absent provider.
  assert.equal(dialectForDeliveryProvider('git'), undefined);
  assert.equal(dialectForDeliveryProvider('fake'), undefined);
  assert.equal(dialectForDeliveryProvider(undefined), undefined);
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

test('await_checks: a host that reports NO checks fails at the DEADLINE — "no checks" is not a pass', async () => {
  const p = fixture();
  const provider = checkProvider([[]]);
  try {
    // The bound is what tells "no checks YET" from "no checks": an empty answer is only a verdict once
    // waitSeconds has elapsed.
    const r = await runStep(p, awaitStep(2), provider);
    assert.equal(r.status, 'failed');
    assert.match(r.step?.summary ?? '', /reported NO checks/);
    assert.match(r.step?.summary ?? '', /after 2s/);
    assert.match(r.step?.summary ?? '', /"no checks" is not a pass/);
    assert.ok(provider.calls > 1, `the step must POLL until the bound, not judge the first empty answer (calls: ${provider.calls})`);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a pipeline the host registers a moment LATE still passes (no checks YET is not no checks)', async () => {
  const p = fixture();
  // The measured case (run wf-8edeac75, 2026-10-12): a PR whose pipeline PASSED was refused after TWO
  // SECONDS because the host had not registered the workflow run yet; the checks appeared ~10-20s later.
  const provider = checkProvider([[], [{ name: 'tests', conclusion: 'success', url: 'https://host/checks/1' }]]);
  try {
    const r = await runStep(p, awaitStep(3), provider);
    assert.equal(r.status, 'completed', r.step?.summary);
    assert.match(r.step?.summary ?? '', /all 1 check\(s\) succeeded/);
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

// ---------------------------------------------------------------------------------------------
// (c) reporting a RED pipeline to the host (ADR-037): one issue + a pull-request comment, ONLY for
// a genuine pipeline failure with a published reference, and never able to change the run's outcome.
// ---------------------------------------------------------------------------------------------

interface ReportingStub extends DeliveryProvider {
  calls: number;
  issues: Array<{ title: string; body: string }>;
  comments: Array<{ number: string; body: string }>;
  openIssue?: (req: { title: string; body: string; labels?: string[] }) => Promise<{ number: string; url: string }>;
  commentOnPullRequest?: (ref: PullRequestRef, body: string) => Promise<unknown>;
}

/** A provider that reads a scripted pipeline AND records the issue/comment it is asked to file. */
function reportingProvider(
  sequence: CheckSummary[][],
  opts: { canRunChecks?: boolean; issueThrows?: boolean; noIssue?: boolean; noComment?: boolean } = {},
): ReportingStub {
  const provider: ReportingStub = {
    calls: 0,
    issues: [],
    comments: [],
    metadata: () => ({ id: 'stub', name: 'stub', version: '0' }),
    capabilities: () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: opts.canRunChecks !== false, canMerge: false }),
    async deliver() {
      return { created: true, push: { mode: 'plain', branch: 'task', head: 'head1' }, notes: [] };
    },
    async status() {
      return { state: 'open', headSha: 'head1', baseSha: 'base1', mergeable: true };
    },
    async checks(): Promise<CheckSummary[]> {
      const at = Math.min(provider.calls, sequence.length - 1);
      provider.calls += 1;
      return sequence[at] ?? [];
    },
    async merge() {
      return { merged: true, method: 'merge', headSha: 'head1', url: 'https://host/pulls/7' };
    },
  };
  if (opts.noIssue !== true) {
    provider.openIssue = async (req) => {
      if (opts.issueThrows === true) throw new Error('the host refused the issue (403)');
      provider.issues.push({ title: req.title, body: req.body });
      const number = String(20 + provider.issues.length);
      return { number, url: `https://host/issues/${number}` };
    };
  }
  if (opts.noComment !== true) {
    provider.commentOnPullRequest = async (ref, body) => {
      provider.comments.push({ number: String(ref.number), body });
    };
  }
  return provider;
}

test('await_checks: a RED pipeline opens ONE issue and comments on the pull request with the failing checks', async () => {
  const p = fixture();
  const provider = reportingProvider([
    [{ name: 'build', conclusion: 'failure', url: 'https://host/checks/1' }, { name: 'tests', conclusion: 'success' }],
  ]);
  try {
    const r = await runSteps(p, [awaitStep()], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    const step = r.steps[0];
    assert.match(step?.summary ?? '', /1 check\(s\) FAILED/);
    assert.equal(provider.issues.length, 1, 'exactly one issue records the failure');
    assert.equal(provider.comments.length, 1, 'the pull request carries the same list');
    assert.match(provider.issues[0]?.title ?? '', /Pipeline not green on pull request 7: 1 check\(s\)/);
    assert.match(provider.issues[0]?.body ?? '', /- build: failure \(https:\/\/host\/checks\/1\)/);
    assert.ok(!(provider.issues[0]?.body ?? '').includes('tests: success'), 'a passing check is not part of the failure list');
    assert.match(provider.comments[0]?.body ?? '', /- build: failure \(https:\/\/host\/checks\/1\)/);
    // The step summary says what was reported, so a reader of the run knows an issue exists.
    assert.match(step?.summary ?? '', /issue 21 opened \(https:\/\/host\/issues\/21\)/);
    assert.match(step?.summary ?? '', /commented on pull request 7/);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a pipeline still PENDING at the timeout is reported to the host too', async () => {
  const p = fixture();
  const provider = reportingProvider([[{ name: 'build', conclusion: 'pending', url: 'https://host/checks/1' }]]);
  try {
    const r = await runSteps(p, [awaitStep(1)], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.match(r.steps[0]?.summary ?? '', /still PENDING after 1s/);
    assert.equal(provider.issues.length, 1, 'a pending-at-timeout pipeline is a genuine failure to report');
    assert.match(provider.issues[0]?.body ?? '', /- build: pending \(https:\/\/host\/checks\/1\)/);
    assert.equal(provider.comments.length, 1);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a RED pipeline with NO published reference reports nothing — there is nothing to report to', async () => {
  const p = fixture();
  const provider = reportingProvider([[{ name: 'build', conclusion: 'failure' }]]);
  try {
    const r = await runSteps(p, [awaitStep()], provider, {});
    assert.equal(r.status, 'failed');
    assert.equal(provider.issues.length, 0, 'no issue without a published pull request');
    assert.equal(provider.comments.length, 0);
    assert.ok(!(r.steps[0]?.summary ?? '').includes('host report:'), 'the summary claims no report');
  } finally {
    p.cleanup();
  }
});

test('await_checks: a host that cannot report checks is NOT reported as a pipeline failure (nothing was read)', async () => {
  const p = fixture();
  const provider = reportingProvider([[]], { canRunChecks: false });
  try {
    const r = await runSteps(p, [awaitStep()], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.match(r.steps[0]?.summary ?? '', /cannot report checks/);
    assert.equal(provider.issues.length, 0, 'a read failure is not a pipeline failure');
    assert.equal(provider.comments.length, 0);
  } finally {
    p.cleanup();
  }
});

test('await_checks: a failure to open the issue is LOUD, never claims an issue, and keeps the run RED', async () => {
  const p = fixture();
  const provider = reportingProvider([[{ name: 'build', conclusion: 'failure' }]], { issueThrows: true });
  try {
    const r = await runSteps(p, [awaitStep()], provider, { deliveryRef: '7' });
    // The run was failed by the PIPELINE and stays failed by the pipeline: a host that cannot record
    // the failure must not turn it into a different kind of failure.
    assert.equal(r.status, 'failed');
    assert.match(
      r.steps[0]?.summary ?? '',
      /issue COULD NOT be opened \(the host refused the issue \(403\)\) — the pull request exists; the failure record does not/,
    );
    assert.equal(provider.issues.length, 0, 'no issue is claimed when none was opened');
    assert.equal(provider.comments.length, 1, 'the pull-request comment still happens');
  } finally {
    p.cleanup();
  }
});

test('await_checks: two red steps file at most ONE issue per run (comments still reach the host)', async () => {
  const p = fixture();
  const provider = reportingProvider([[{ name: 'build', conclusion: 'failure' }]]);
  const first: StepWithRef = { id: 'await_checks', type: 'await_checks', ref: 'https://host/pulls/7' };
  const second: StepWithRef = { id: 'await_checks_again', type: 'await_checks', ref: 'https://host/pulls/7' };
  try {
    const r = await runSteps(p, [first, second], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.equal(provider.issues.length, 1, 'never more than one issue per run');
    assert.equal(provider.comments.length, 2, 'each genuine failure still reaches the pull request');
    assert.match(r.steps[1]?.summary ?? '', /issue not opened \(one pipeline-failure issue per run was already filed\)/);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// (c) the generated pipeline FAILS when the delivered tests fail (docs/bugs-fixed.md #49)
//
// GitHub Actions runs a `run:` block with `bash -e`, which does NOT set `pipefail`, so a pipeline's
// exit status is the LAST command's. Every branch of the delivered test command ends in `| tail -60`
// (so the log stays readable), so a FAILING suite read GREEN. These tests run the GENERATED script
// through the same shell the host uses, so what they assert is the artifact's behaviour, not a
// paraphrase of it: a red suite is a red job.
// ---------------------------------------------------------------------------------------------

/**
 * The exact shell script the generated pipeline's `tests` job runs — extracted from the YAML, the way
 * the host reads it. Handles both dialects: the GitHub-Actions jobs (`jobs.tests.steps[].run`) and
 * GitLab CI's single `tests.script` block.
 */
function generatedTestScript(yaml: string): string {
  const doc = parseYaml(yaml) as {
    jobs?: { tests?: { steps?: Array<{ run?: unknown }> } };
    tests?: { script?: unknown };
  };
  const stepRuns = (doc.jobs?.tests?.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === 'string');
  if (stepRuns.length > 0) return stepRuns[stepRuns.length - 1]!;
  const script = doc.tests?.script;
  if (Array.isArray(script)) {
    const parts = script.filter((s): s is string => typeof s === 'string');
    if (parts.length > 0) return parts.join('\n');
  }
  throw new Error('the generated pipeline has no tests-job script to run');
}

/**
 * Render a pipeline for `testCommand` and run its tests job the way the host does: a non-interactive
 * `bash -e` in the delivery worktree. Returns the exit status and the combined output.
 */
function runGeneratedTestsJob(p: Project, testCommand: string, dialect: CiDialect): { status: number; output: string } {
  const script = generatedTestScript(renderCiConfig({ dialect, testCommand }));
  const res = spawnSync('bash', ['-e', '-c', script], { cwd: p.worktree, encoding: 'utf8' });
  return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

test('ci_config: the generated tests job is NON-ZERO when the delivered suite FAILS (a red suite is never a green pipeline)', () => {
  const p = fixture();
  try {
    // The delivered project's own failing suite, piped through `tail` exactly as the workflow declares.
    writeFileSync(join(p.worktree, 'run-tests.sh'), '#!/usr/bin/env bash\necho "not ok 1 - the delivered suite failed"\nexit 1\n');
    const testCommand = 'bash run-tests.sh 2>&1 | tail -60';
    for (const dialect of ['github', 'forgejo', 'gitlab'] as const) {
      const r = runGeneratedTestsJob(p, testCommand, dialect);
      assert.notEqual(
        r.status,
        0,
        `a FAILING delivered suite must fail the generated ${dialect} tests job, not read GREEN (got ${r.status}): ${r.output}`,
      );
      assert.match(r.output, /not ok 1/, 'the tail still shows the failing output the log exists to carry');
    }
  } finally {
    p.cleanup();
  }
});

test('ci_config: the generated tests job is ZERO when the delivered suite PASSES (the tail is kept)', () => {
  const p = fixture();
  try {
    writeFileSync(join(p.worktree, 'run-tests.sh'), '#!/usr/bin/env bash\necho "ok 1 - the delivered suite passed"\nexit 0\n');
    const testCommand = 'bash run-tests.sh 2>&1 | tail -60';
    for (const dialect of ['github', 'forgejo', 'gitlab'] as const) {
      const r = runGeneratedTestsJob(p, testCommand, dialect);
      assert.equal(r.status, 0, `a PASSING delivered suite must pass the generated ${dialect} tests job: ${r.output}`);
      assert.match(r.output, /ok 1 - the delivered suite passed/, 'the output is still tailed into the log');
    }
  } finally {
    p.cleanup();
  }
});
