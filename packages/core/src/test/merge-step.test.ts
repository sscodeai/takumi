import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ArtifactStore,
  executeWorkflow,
  requirementDigest,
  validateWorkflowManifest,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';
import type { CheckSummary, DeliveryProvider, MergeOutcome, PullRequestRef } from '../delivery.js';

/**
 * The merge step (ADR-040): the LAST MILE.
 *
 * These drive the REAL engine, the way `publish-step.test.ts` and `ci-config-step.test.ts` do: a workflow
 * definition goes in, the engine dispatches the step, and what these tests read is what the step actually
 * did. The invariant under test is the one the whole layer exists for: the step merges the head that was
 * REVIEWED AND ACCEPTED and nothing else, with two independent guards — the reviewed head is handed to the
 * host as `expectedHeadSha`, AND the pull request's CURRENT head is read and compared BEFORE any merge call.
 * A merge that did not happen is never reported as one.
 */

const DOC = [
  'requirements:',
  '  - id: REQ-001',
  '    title: Summarise the CSV',
  '    acceptance_criteria:',
  '      - A department row per department',
  '',
].join('\n');

const OK_HARNESS = [
  '#!/bin/sh',
  'echo "ok 1 - a department row exists"',
  'echo "# tests 1"',
  'echo "# pass 1"',
  'echo "# fail 0"',
  'echo "ACCEPT_VERDICT: pass"',
  'exit 0',
  '',
].join('\n');

interface Fixture {
  dir: string;
  worktree: string;
  /** The head of the delivery worktree — the commit the acceptance judges and the merge must land. */
  head: string;
  cleanup: () => void;
}

/**
 * A project directory (the requirement document + the acceptance harness) plus a REAL git worktree on a
 * branch with one commit — the boundary both the acceptance and the merge are about.
 */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-merge-'));
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'requirements', 'feature.yaml'), DOC);
  writeFileSync(join(dir, 'checks', 'accept.sh'), OK_HARNESS);
  chmodSync(join(dir, 'checks', 'accept.sh'), 0o755);

  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync('git', args, {
      cwd: worktree,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    });
  };
  git(['init', '-q', '-b', 'task']);
  writeFileSync(join(worktree, 'summary.sh'), '#!/usr/bin/env bash\necho hi\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'the implementer commits; takumi never does']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  return { dir, worktree, head, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface MergeStub extends DeliveryProvider {
  /** Every `merge()` call the step made, so "never called" is a fact rather than an inference. */
  mergeCalls: Array<{ expectedHeadSha: string; method?: string }>;
  statusCalls: number;
}

interface StubOpts {
  /** The head `status()` reports as the pull request's CURRENT head. Defaults to the fixture head. */
  currentHead?: string;
  statusThrows?: boolean;
  mergeThrows?: string;
  mergedFalse?: boolean;
  /** Checks `checks()` reports (for the await_checks → merge skip test). */
  checks?: CheckSummary[];
}

function mergeProvider(opts: StubOpts = {}): MergeStub {
  const provider: MergeStub = {
    mergeCalls: [],
    statusCalls: 0,
    metadata: () => ({ id: 'stub', name: 'stub', version: '0' }),
    capabilities: () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true }),
    async deliver() {
      return { created: true, push: { mode: 'plain', branch: 'task', head: 'head1' }, notes: [] };
    },
    async status(): Promise<{ state: 'open'; mergeable: boolean; headSha: string; baseSha: string }> {
      provider.statusCalls += 1;
      if (opts.statusThrows === true) throw new Error('the host answered 500');
      return { state: 'open', mergeable: true, headSha: opts.currentHead ?? 'MUST_BE_SET', baseSha: 'base1' };
    },
    async checks(): Promise<CheckSummary[]> {
      return opts.checks ?? [{ name: 'build', conclusion: 'success' }];
    },
    async merge(ref: PullRequestRef, o: { expectedHeadSha: string; method?: 'merge' | 'squash' | 'rebase' }): Promise<MergeOutcome> {
      provider.mergeCalls.push({ expectedHeadSha: o.expectedHeadSha, ...(o.method === undefined ? {} : { method: o.method }) });
      if (opts.mergeThrows !== undefined) throw new Error(opts.mergeThrows);
      if (opts.mergedFalse === true) return { merged: false, method: o.method ?? 'merge', headSha: o.expectedHeadSha, url: 'https://host/pulls/7' };
      return { merged: true, method: o.method ?? 'merge', headSha: o.expectedHeadSha, url: `https://host/pulls/${ref.number}` };
    },
  };
  return provider;
}

type StepWithRef = WorkflowStep & { ref?: string };

interface RunOut {
  status: string;
  vars: Record<string, string>;
  /** Artifact contents, keyed by the (store-relative) artifact path, read before the store is cleaned up. */
  artifacts: Record<string, string>;
  steps: Array<{ stepId: string; status: string; summary: string; artifacts: string[] }>;
}

async function run(
  f: Fixture,
  steps: StepWithRef[],
  provider: DeliveryProvider | undefined,
  vars: Record<string, string>,
  loadWorkflow?: (ref: string) => Promise<WorkflowDefinition>,
): Promise<RunOut> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-merge-artifacts-'));
  try {
    const wf: WorkflowDefinition = { name: 'merge-test', version: '0.0.1', description: '', steps };
    const ctx: Parameters<typeof executeWorkflow>[1] = {
      cwd: f.dir,
      worktree: f.worktree,
      runtime: new TestRuntime(() => 'ok'),
      artifacts: new ArtifactStore(artifacts),
      onApproval: () => true,
      confirmedRequirement: { ref: 'docs/requirements/feature.yaml', digest: requirementDigest(DOC) },
    };
    if (provider !== undefined) ctx.delivery = provider;
    if (loadWorkflow !== undefined) ctx.loadWorkflow = loadWorkflow;
    const res = await executeWorkflow(wf, ctx, vars);
    const contents: Record<string, string> = {};
    for (const s of res.steps) {
      for (const p of s.artifacts) {
        try {
          contents[p] = readFileSync(join(artifacts, p), 'utf8');
        } catch {
          // not every artifact is a file we can read; the path is still reported
        }
      }
    }
    return {
      status: res.status,
      vars: res.vars,
      artifacts: contents,
      steps: res.steps.map((s) => ({ stepId: s.stepId, status: s.status, summary: s.summary, artifacts: s.artifacts })),
    };
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
}

const acceptanceStep: StepWithRef = {
  id: 'accept',
  type: 'acceptance',
  requirementRef: 'docs/requirements/feature.yaml',
  acceptanceRef: 'checks/accept.sh',
};

const mergeStep = (extra: Partial<WorkflowStep> = {}): StepWithRef => ({
  id: 'merge',
  type: 'merge',
  dependsOn: ['accept'],
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// (a) the manifest: the only thing a merge declares is its method — never a head, never a reference
// ---------------------------------------------------------------------------------------------

test('merge manifest: a method no host implements is refused at load, and says which are', () => {
  const issues = validateWorkflowManifest({
    name: 'w',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'merge', type: 'merge', mergeMethod: 'octopus' as never }],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /merge whose mergeMethod is "octopus": implemented are merge, squash, rebase/);
});

test('merge manifest: the implemented methods are accepted, and a step with no method is not refused', () => {
  for (const method of ['merge', 'squash', 'rebase'] as const) {
    assert.deepEqual(
      validateWorkflowManifest({ name: 'w', version: '0.1.0', description: '', steps: [{ id: 'merge', type: 'merge', mergeMethod: method }] }),
      [],
      `${method} must be allowed`,
    );
  }
  assert.deepEqual(validateWorkflowManifest({ name: 'w', version: '0.1.0', description: '', steps: [{ id: 'merge', type: 'merge' }] }), []);
});

// ---------------------------------------------------------------------------------------------
// (b) the accepted head is merged — and the summary names the method, the head and the URL
// ---------------------------------------------------------------------------------------------

test('merge: the accepted head is merged, and the summary names the method, the head and the url', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head });
  try {
    const r = await run(f, [acceptanceStep, mergeStep({ mergeMethod: 'squash' })], provider, { deliveryRef: '7' });

    assert.equal(r.status, 'completed', JSON.stringify(r.steps.map((s) => [s.stepId, s.status, s.summary.split('\n')[0]])));
    const merge = r.steps.find((s) => s.stepId === 'merge');
    assert.equal(merge?.status, 'completed');
    // The summary states what the provider ACTUALLY returned: method, head, url.
    assert.match(merge?.summary ?? '', new RegExp(`merged pull request 7: method squash, head ${f.head}, url https://host/pulls/7`));
    assert.match(merge?.summary ?? '', new RegExp(`reviewed head: ${f.head} \\(the commit the acceptance judged\\)`));

    // The reviewed head — the commit the acceptance judged — is the head handed to the host, and the ONLY
    // merge call made.
    assert.equal(provider.mergeCalls.length, 1, 'exactly one merge call');
    assert.equal(provider.mergeCalls[0]?.expectedHeadSha, f.head, 'the port is handed the reviewed head');
    assert.equal(provider.mergeCalls[0]?.method, 'squash', 'the declared method is passed through');

    // The merge is recorded as an artifact a human can read.
    assert.equal(merge?.artifacts.length, 1, 'the merge is recorded as an artifact');
    const artifact = r.artifacts[merge!.artifacts[0]!] ?? '';
    assert.match(artifact, /merged: true/);
    assert.match(artifact, /method: squash/);
    assert.match(artifact, new RegExp(`head: ${f.head}`));
    assert.match(artifact, /url: https:\/\/host\/pulls\/7/);

    // A later step can know the delivery LANDED without reading prose.
    assert.equal(r.vars['deliveryMerged'], 'true');
    assert.equal(r.vars['mergedHead'], f.head);
    assert.equal(r.vars['mergedRef'], '7');
  } finally {
    f.cleanup();
  }
});

test('merge: the method defaults to merge when the step declares none', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head });
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'completed', JSON.stringify(r.steps.map((s) => [s.stepId, s.status])));
    assert.equal(provider.mergeCalls[0]?.method, 'merge');
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /method merge, head/);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// (c) the reviewed head is the only mergeable head — two independent guards
// ---------------------------------------------------------------------------------------------

test('merge: the PR current head differing from the reviewed head is refused BEFORE calling merge, naming both SHAs', async () => {
  const f = fixture();
  // The pull request points at a DIFFERENT commit than the one the acceptance judged.
  const moved = `${f.head.slice(0, 12)}0deadbeef0`;
  const provider = mergeProvider({ currentHead: moved });
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], provider, { deliveryRef: '7' });

    assert.equal(r.status, 'failed');
    const merge = r.steps.find((s) => s.stepId === 'merge');
    assert.equal(merge?.status, 'failed');
    // BOTH SHAs are named: the commit judged and the commit the pull request now points at.
    assert.match(merge?.summary ?? '', new RegExp(moved), 'the current head is named');
    assert.match(merge?.summary ?? '', new RegExp(f.head), 'the reviewed head is named');
    assert.match(merge?.summary ?? '', /refusing to merge a head that was not the one judged/);
    // The guard fired BEFORE the merge: the provider's merge was NEVER called.
    assert.equal(provider.mergeCalls.length, 0, 'no merge call is made when the head moved');
    assert.equal(provider.statusCalls, 1, 'the current head was read exactly once, before any merge');
  } finally {
    f.cleanup();
  }
});

test('merge: a host that refuses a moved head fails the run, and the message names both SHAs', async () => {
  const f = fixture();
  const remote = `${f.head.slice(0, 12)}feedface00`;
  // status() reports the reviewed head (guard 2 passes), but the HOST refuses the merge because the remote
  // moved between the read and the call — the guard only the host can enforce.
  const provider = mergeProvider({
    currentHead: f.head,
    mergeThrows: `the pull request head moved: reviewed ${f.head}, remote ${remote}`,
  });
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], provider, { deliveryRef: '7' });

    assert.equal(r.status, 'failed');
    const summary = r.steps.find((s) => s.stepId === 'merge')?.summary ?? '';
    assert.match(summary, /the host refused the merge/);
    assert.match(summary, new RegExp(`reviewed ${f.head}`), 'the reviewed head is named');
    assert.match(summary, new RegExp(`remote ${remote}`), 'the remote head is named');
    assert.equal(provider.mergeCalls.length, 1, 'the step did attempt the merge; the host refused it');
  } finally {
    f.cleanup();
  }
});

test('merge: merged=false from the host FAILS the run — a merge that did not happen is not a delivery', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head, mergedFalse: true });
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /merged=false/);
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /a merge that did not happen is not a landed delivery/);
  } finally {
    f.cleanup();
  }
});

test('merge: the reviewed head cannot be determined when no acceptance recorded one — the step refuses', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head });
  try {
    // A published reference exists, but nothing judged a head: a merge that cannot say which commit it is
    // landing is not a merge this project performs.
    const r = await run(f, [mergeStep({ dependsOn: [] })], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /the reviewed head could not be determined/);
    assert.equal(provider.mergeCalls.length, 0, 'nothing is merged when the reviewed head is unknown');
    assert.equal(provider.statusCalls, 0, 'status is not even read without a reviewed head');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// (d) the refusals: no provider, no published reference
// ---------------------------------------------------------------------------------------------

test('merge: a run with no delivery provider FAILS — an open pull request is not a landed delivery', async () => {
  const f = fixture();
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], undefined, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /no delivery provider \(ctx\.delivery\)/);
  } finally {
    f.cleanup();
  }
});

test('merge: a run with no published reference FAILS — there is no pull request to land', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head });
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], provider, {});
    assert.equal(r.status, 'failed');
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /no published reference \(vars\.deliveryRef/);
    assert.equal(provider.mergeCalls.length, 0, 'nothing is merged without a pull request');
  } finally {
    f.cleanup();
  }
});

test('merge: a status() that throws fails the run, saying what the host said', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head, statusThrows: true });
  try {
    const r = await run(f, [acceptanceStep, mergeStep()], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /could not report the state of pull request 7/);
    assert.match(r.steps.find((s) => s.stepId === 'merge')?.summary ?? '', /the host answered 500/);
    assert.equal(provider.mergeCalls.length, 0);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// (e) a red pipeline skips the merge STRUCTURALLY — asserted, not assumed
// ---------------------------------------------------------------------------------------------

test('merge: when await_checks fails, the merge step is SKIPPED (the engine dependency skip does it)', async () => {
  const f = fixture();
  // A red pipeline: await_checks fails, and merge (dependsOn await_checks) must not run at all.
  const provider = mergeProvider({ currentHead: f.head, checks: [{ name: 'build', conclusion: 'failure', url: 'https://host/checks/1' }] });
  const awaitStep: StepWithRef = { id: 'await_checks', type: 'await_checks', ref: '7' };
  const merge: StepWithRef = { id: 'merge', type: 'merge', dependsOn: ['await_checks'] };
  try {
    const r = await run(f, [awaitStep, merge], provider, { deliveryRef: '7' });
    assert.equal(r.status, 'failed');
    assert.equal(r.steps.find((s) => s.stepId === 'await_checks')?.status, 'failed');
    const mergeStep = r.steps.find((s) => s.stepId === 'merge');
    assert.equal(mergeStep?.status, 'skipped', 'a red pipeline skips the merge structurally');
    assert.match(mergeStep?.summary ?? '', /skipped \(dependency failed: await_checks\)/);
    assert.equal(provider.mergeCalls.length, 0, 'nothing is merged on a pipeline that did not go green');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// (f) the reviewed head crosses the repair sub-workflow boundary — the real request-to-delivery shape
// ---------------------------------------------------------------------------------------------

test('merge: after a repair, the head the SUB-run accepted reaches the run that invoked it and is merged', async () => {
  const f = fixture();
  const provider = mergeProvider({ currentHead: f.head });
  const sub: WorkflowDefinition = {
    name: 'request-to-delivery-attempt',
    version: '0.1.0',
    description: '',
    steps: [
      { id: 'implementation', type: 'agent', prompt: 'implement {repairRound}' },
      { id: 'artifact_acceptance', type: 'acceptance', requirementRef: 'docs/requirements/feature.yaml', acceptanceRef: 'checks/accept.sh', dependsOn: ['implementation'] },
    ],
  };
  const parent: WorkflowDefinition = {
    name: 'request-to-delivery',
    version: '0.4.0',
    description: '',
    steps: [
      { id: 'delivery_attempt', type: 'repair', repairRef: 'request-to-delivery-attempt', maxRounds: 1 },
      { id: 'merge', type: 'merge', dependsOn: ['delivery_attempt'] },
    ],
  };
  try {
    const artifacts = mkdtempSync(join(tmpdir(), 'takumi-merge-artifacts-'));
    try {
      const res = await executeWorkflow(
        parent,
        {
          cwd: f.dir,
          worktree: f.worktree,
          runtime: new TestRuntime(() => 'ok'),
          artifacts: new ArtifactStore(artifacts),
          onApproval: () => true,
          confirmedRequirement: { ref: 'docs/requirements/feature.yaml', digest: requirementDigest(DOC) },
          delivery: provider,
          loadWorkflow: async () => sub,
        },
        { deliveryRef: '7' },
      );
      assert.equal(res.status, 'completed', JSON.stringify(res.steps.map((s) => [s.stepId, s.status, s.summary.split('\n')[0]])));
      const merge = res.steps.find((s) => s.stepId === 'merge');
      assert.equal(merge?.status, 'completed');
      // The head merged is the head the SUB-run's acceptance judged — it crossed the boundary in vars.
      assert.equal(provider.mergeCalls.length, 1);
      assert.equal(provider.mergeCalls[0]?.expectedHeadSha, f.head, 'the sub-run accepted head is the head merged');
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});
