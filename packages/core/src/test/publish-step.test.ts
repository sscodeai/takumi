import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeWorkflow } from '../workflow-engine.js';
import { ArtifactStore } from '../artifact-store.js';
import { TestRuntime } from '../test-utils.js';
import type { WorkflowDefinition } from '../workflow.js';
import type { DeliveryOutcome, DeliveryProvider, PullRequestRef } from '../delivery.js';

// The publish step (ADR-037): the ONE place a black-box run is allowed to write to a code host.
//
// What these tests pin is the boundary, not the plumbing: a run with no provider FAILS rather than calling a
// local bundle "delivered"; a provider that reports a FORCE fails the run (the port forbids one, because the
// reviewed history would be gone); a host with no review surface is reported as exactly that; and an issue
// that could not be recorded is loud but does not undo a pull request that already exists.

interface Stub extends DeliveryProvider {
  delivered: number;
  issues: number;
}

function stub(overrides: Partial<DeliveryOutcome> = {}, opts: { noIssue?: boolean; issueThrows?: boolean; noPr?: boolean } = {}): Stub {
  const provider: Stub = {
    delivered: 0,
    issues: 0,
    metadata: () => ({ id: 'stub', name: 'stub', version: '0' }),
    capabilities: () => ({ canPushBranch: true, canOpenPullRequest: !opts.noPr, canRunChecks: false, canMerge: false }),
    async deliver(): Promise<DeliveryOutcome> {
      provider.delivered += 1;
      const pr: PullRequestRef | undefined =
        opts.noPr === true ? undefined : { number: '7', url: 'https://host/pulls/7', headSha: 'head1', baseSha: 'base1' };
      return { created: true, push: { mode: 'plain', branch: 'task', head: 'head1' }, notes: [], ...(pr === undefined ? {} : { pr }), ...overrides };
    },
    async status() {
      return { state: 'open', headSha: 'head1', baseSha: 'base1', mergeable: true };
    },
    async checks() {
      return [];
    },
    async merge(_ref: PullRequestRef, _opts: { expectedHeadSha: string }) {
      return { merged: true, method: 'merge', headSha: 'head1', url: 'https://host/pulls/7' };
    },
    ...(opts.noIssue === true
      ? {}
      : {
          async openIssue(req: { title: string; body: string }) {
            if (opts.issueThrows === true) throw new Error('the host refused the issue (403)');
            provider.issues += 1;
            return { number: '11', url: `https://host/issues/11?title=${encodeURIComponent(req.title)}` };
          },
        }),
  };
  return provider;
}

interface Fixture {
  dir: string;
  worktree: string;
  cleanup: () => void;
}

/** A project directory plus a REAL git worktree on a branch with one commit — the boundary publish verifies. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-publish-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: worktree, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
  };
  git(['init', '-q', '-b', 'task']);
  writeFileSync(join(worktree, 'summary.sh'), '#!/usr/bin/env bash\necho hi\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'the implementer commits; takumi never does']);
  // The remote-tracking base the step resolves: a bare repo with a `main` branch.
  const remote = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: worktree, stdio: 'ignore' });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: worktree, stdio: 'ignore' });
  return { dir, worktree, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const workflow = (): WorkflowDefinition => ({
  name: 'publish-test',
  version: '0.0.1',
  description: 'a run whose only step is the publish boundary',
  steps: [{ id: 'publish', type: 'publish', dependsOn: [] }],
});

async function run(f: Fixture, provider: DeliveryProvider | undefined): Promise<{ status: string; summary: string }> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-publish-artifacts-'));
  const ctx: Parameters<typeof executeWorkflow>[1] = {
    cwd: f.dir,
    worktree: f.worktree,
    runtime: new TestRuntime(() => 'ok'),
    artifacts: new ArtifactStore(artifacts),
    confirmedRequirement: { ref: 'docs/requirements/station.yaml', digest: 'abc123' },
    onEvent: () => {},
  };
  if (provider !== undefined) ctx.delivery = provider as NonNullable<typeof ctx.delivery>;
  const result = await executeWorkflow(workflow(), ctx, {});
  const step = result.steps.find((s) => s.stepId === 'publish');
  return { status: result.status, summary: step?.summary ?? '' };
}

test('publish: a run with no delivery provider FAILS — a local bundle is not a delivery', async () => {
  const f = fixture();
  try {
    const r = await run(f, undefined);
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /no delivery provider \(ctx\.delivery\), so there is no host to publish to: a local bundle is not a delivery/);
  } finally {
    f.cleanup();
  }
});

test('publish: a plain push and one pull request, with the confirmed requirement and its digest in the body', async () => {
  const f = fixture();
  const provider = stub();
  try {
    const r = await run(f, provider);
    assert.equal(r.status, 'completed', r.summary);
    assert.equal(provider.delivered, 1, 'exactly one delivery');
    assert.match(r.summary, /published task -> main as pull request 7/);
    assert.match(r.summary, /https:\/\/host\/pulls\/7/);
    assert.match(r.summary, /push: plain/);
    assert.match(r.summary, /Requirement: `docs\/requirements\/station\.yaml` at `sha256:abc123`/);
    assert.match(r.summary, /issue: 11 opened/);
    assert.equal(provider.issues, 1, 'one issue records the work');
  } finally {
    f.cleanup();
  }
});

test('publish: a provider that reports a FORCE fails the run — the reviewed history would be gone', async () => {
  const f = fixture();
  // The port forbids a forced push; a provider that reports one has broken the boundary this layer keeps.
  const provider = stub({ push: { mode: 'force', branch: 'task', head: 'head1' } });
  try {
    const r = await run(f, provider);
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /pushed with a FORCE, which the port forbids/);
  } finally {
    f.cleanup();
  }
});

test('publish: a host with no review surface is reported as that, never as a pull request that does not exist', async () => {
  const f = fixture();
  const provider = stub({}, { noPr: true });
  try {
    const r = await run(f, provider);
    assert.equal(r.status, 'completed', r.summary);
    assert.match(r.summary, /the branch is pushed and this host has no review surface/);
    assert.ok(!/pull request \d/.test(r.summary), 'no pull request is claimed');
    // The issue records the branch (that is its body, not the step summary); the summary reports that the
    // issue WAS opened, so a reader can tell the difference between "recorded" and "not recorded".
    assert.match(r.summary, /issue: 11 opened/, 'the issue is still the record of the work');
  } finally {
    f.cleanup();
  }
});

test('publish: an issue that could not be recorded is LOUD, and does not undo the pull request', async () => {
  const f = fixture();
  const provider = stub({}, { issueThrows: true });
  try {
    const r = await run(f, provider);
    // The pull request exists and is a fact; the record is missing and is said so. Failing the run here would
    // punish a delivery for a decorative board, which is the rule the board mirror already keeps.
    assert.equal(r.status, 'completed', r.summary);
    assert.match(r.summary, /issue: COULD NOT be opened \(the host refused the issue \(403\)\) — the pull request exists; the record does not/);
  } finally {
    f.cleanup();
  }
});

test('publish: a provider without the issue surface says so instead of pretending', async () => {
  const f = fixture();
  const provider = stub({}, { noIssue: true });
  try {
    const r = await run(f, provider);
    assert.equal(r.status, 'completed', r.summary);
    assert.match(r.summary, /issue: not opened \(the provider cannot record issues\)/);
  } finally {
    f.cleanup();
  }
});

test('publish: a dirty worktree is the provider\'s refusal to make, and it fails the run', async () => {
  const f = fixture();
  const provider = stub();
  // The port requires `deliver()` to refuse an uncommitted worktree; the step must surface that as a failure
  // rather than reporting a delivery that never happened.
  provider.deliver = async () => {
    throw new Error('the worktree has uncommitted changes: takumi never commits for you');
  };
  try {
    const r = await run(f, provider);
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /the host refused the delivery: the worktree has uncommitted changes/);
  } finally {
    f.cleanup();
  }
});
