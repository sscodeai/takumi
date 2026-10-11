import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeWorkflow } from '../workflow-engine.js';
import { ArtifactStore } from '../artifact-store.js';
import { TestRuntime } from '../test-utils.js';
import { DELIVERY_BOARD_LABELS, DELIVERY_BOARD_STEP_STATES } from '../delivery-board.js';
import type { DeliveryBoardPort, DeliveryBoardProjection, DeliveryBoardRef } from '../delivery-board.js';
import type { WorkflowDefinition, WorkflowStep } from '../workflow.js';
import type { CheckSummary, DeliveryProvider, PullRequestRef } from '../delivery.js';

/**
 * The board projection (ADR-044), driven through the REAL engine.
 *
 * What these tests pin is the CONTRACT, not the plumbing: the row follows the delivery step (publish →
 * `claimed`, a green pipeline → `pr_open` + `takumi-approved`, a red one → `fix_needed` + `takumi-blocked`,
 * merge → `merged` + `takumi-merged`); ONE delivery is ONE row, keyed by the run id; a run with no board
 * port projects nowhere and is not decorated; and a board that cannot be written is LOUD but NEVER FATAL —
 * it must not be able to un-accept a delivery the pipeline, the judge and the host already accepted.
 */

type StepWithRef = WorkflowStep & { ref?: string };

interface StubBoard extends DeliveryBoardPort {
  projections: DeliveryBoardProjection[];
  throwOnProject?: boolean;
}

/** A board that records every projection it is handed. */
function stubBoard(opts: { throwOnProject?: boolean } = {}): StubBoard {
  const board: StubBoard = {
    projections: [],
    metadata: () => ({ id: 'stub', name: 'stub board', version: '0' }),
    async project(input: DeliveryBoardProjection): Promise<DeliveryBoardRef> {
      if (opts.throwOnProject === true) throw new Error('the board answered 502');
      board.projections.push(input);
      const created = board.projections.filter((p) => p.runId === input.runId).length === 1;
      return { id: `row-${input.runId}`, url: `https://board/${input.runId}`, created };
    },
  };
  if (opts.throwOnProject === true) board.throwOnProject = true;
  return board;
}

interface Fixture {
  dir: string;
  worktree: string;
  head: string;
  cleanup: () => void;
}

/** A project directory plus a REAL git worktree on a branch with one commit, and a bare `origin`. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-board-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: worktree,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    })
      .toString()
      .trim();
  git(['init', '-q', '-b', 'task']);
  writeFileSync(join(worktree, 'summary.sh'), '#!/usr/bin/env bash\necho hi\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'the implementer commits; takumi never does']);
  const head = git(['rev-parse', 'HEAD']);
  const remote = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: worktree, stdio: 'ignore' });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: worktree, stdio: 'ignore' });
  return { dir, worktree, head, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface DeliveryStub extends DeliveryProvider {
  merges: number;
}

/** A delivery provider that opens one pull request, reads a scripted pipeline, and merges the head it is handed. */
function deliveryStub(sequence: CheckSummary[][], opts: { currentHead?: string } = {}): DeliveryStub {
  const currentHead = opts.currentHead ?? 'head1';
  const provider: DeliveryStub = {
    merges: 0,
    metadata: () => ({ id: 'stub', name: 'stub', version: '0' }),
    capabilities: () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true }),
    async deliver() {
      const pr: PullRequestRef = { number: '7', url: 'https://host/pulls/7', headSha: currentHead, baseSha: 'base1' };
      return { created: true, push: { mode: 'plain', branch: 'task', head: currentHead }, notes: [], pr };
    },
    async status() {
      return { state: 'open', headSha: currentHead, baseSha: 'base1', mergeable: true };
    },
    async checks(): Promise<CheckSummary[]> {
      return sequence[sequence.length - 1] ?? [];
    },
    async merge(ref: PullRequestRef, o: { expectedHeadSha: string }) {
      provider.merges += 1;
      return { merged: true, method: 'merge', headSha: o.expectedHeadSha, url: `https://host/pulls/${ref.number}` };
    },
  };
  return provider;
}

interface RunOut {
  status: string;
  steps: Array<{ stepId: string; status: string; summary: string }>;
}

async function run(
  f: Fixture,
  steps: StepWithRef[],
  delivery: DeliveryProvider | undefined,
  vars: Record<string, string>,
  board: DeliveryBoardPort | undefined,
  opts: { confirmed?: boolean } = {},
): Promise<RunOut> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-board-artifacts-'));
  try {
    const wf: WorkflowDefinition = { name: 'board-test', version: '0.0.1', description: '', steps };
    const ctx: Parameters<typeof executeWorkflow>[1] = {
      cwd: f.dir,
      worktree: f.worktree,
      runtime: new TestRuntime(() => 'ok'),
      artifacts: new ArtifactStore(artifacts),
      onApproval: () => true,
      ...(opts.confirmed === false ? {} : { confirmedRequirement: { ref: 'docs/requirements/feature.yaml', digest: 'digest' } }),
    };
    if (delivery !== undefined) ctx.delivery = delivery;
    if (board !== undefined) ctx.board = board;
    const res = await executeWorkflow(wf, ctx, vars);
    return { status: res.status, steps: res.steps.map((s) => ({ stepId: s.stepId, status: s.status, summary: s.summary })) };
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
}

const green: CheckSummary[] = [{ name: 'build', conclusion: 'success' }, { name: 'tests', conclusion: 'success' }];
const red: CheckSummary[] = [{ name: 'build', conclusion: 'failure', url: 'https://host/checks/1' }];

// ---------------------------------------------------------------------------------------------
// (a) the step → state mapping, driven through the real engine
// ---------------------------------------------------------------------------------------------

test('board: publish projects ONE row as `claimed`, keyed by the run id and titled by the requirement', async () => {
  const f = fixture();
  const board = stubBoard();
  try {
    const r = await run(f, [{ id: 'publish', type: 'publish' }], deliveryStub([green]), {}, board);
    assert.equal(r.status, 'completed', r.steps[0]?.summary);
    assert.equal(board.projections.length, 1, 'one projection for one delivery step');
    const p = board.projections[0]!;
    assert.equal(p.state, DELIVERY_BOARD_STEP_STATES.publish);
    assert.equal(p.state, 'claimed');
    assert.equal(p.title, 'docs/requirements/feature.yaml', 'the row is titled by the confirmed requirement');
    assert.ok(p.runId.startsWith('wf-'), `the row is keyed by the run id (${p.runId})`);
    assert.match(p.detail ?? '', /pull request 7 opened/);
    // The board line is IN the step's own summary, so a reader of the run knows a row exists.
    assert.match(r.steps[0]?.summary ?? '', /board: row created \(row-wf-/);
  } finally {
    f.cleanup();
  }
});

test('board: a GREEN pipeline moves the row to `pr_open` + `takumi-approved`', async () => {
  const f = fixture();
  const board = stubBoard();
  try {
    const r = await run(
      f,
      [
        { id: 'publish', type: 'publish' },
        { id: 'await_checks', type: 'await_checks', dependsOn: ['publish'] },
      ],
      deliveryStub([green]),
      {},
      board,
    );
    assert.equal(r.status, 'completed', JSON.stringify(r.steps));
    assert.equal(board.projections.length, 2, 'publish AND await_checks each move the row');
    const greenProjection = board.projections[1]!;
    assert.equal(greenProjection.state, 'pr_open');
    assert.deepEqual(greenProjection.labels, [DELIVERY_BOARD_LABELS.approved]);
    assert.deepEqual(greenProjection.labels, ['takumi-approved']);
    // ONE row: both projections name the same run id.
    assert.equal(new Set(board.projections.map((p) => p.runId)).size, 1, 'one delivery = one row');
    assert.match(r.steps[1]?.summary ?? '', /board: row /);
  } finally {
    f.cleanup();
  }
});

test('board: a RED pipeline moves the row to `fix_needed` + `takumi-blocked`, and the run stays failed BY THE PIPELINE', async () => {
  const f = fixture();
  const board = stubBoard();
  try {
    const r = await run(
      f,
      [
        { id: 'publish', type: 'publish' },
        { id: 'await_checks', type: 'await_checks', dependsOn: ['publish'] },
      ],
      deliveryStub([red]),
      {},
      board,
    );
    assert.equal(r.status, 'failed', 'a red pipeline is a red run');
    assert.equal(r.steps[1]?.status, 'failed');
    assert.match(r.steps[1]?.summary ?? '', /1 check\(s\) FAILED/);
    const redProjection = board.projections[1]!;
    assert.equal(redProjection.state, 'fix_needed');
    assert.deepEqual(redProjection.labels, ['takumi-blocked']);
    assert.match(r.steps[1]?.summary ?? '', /board: row /, 'the board line is in the red step summary too');
  } finally {
    f.cleanup();
  }
});

test('board: merge lands the row as `merged` + `takumi-merged`, with the merged head in the detail', async () => {
  const f = fixture();
  const board = stubBoard();
  try {
    const r = await run(
      f,
      [
        { id: 'publish', type: 'publish' },
        { id: 'merge', type: 'merge', mergeMethod: 'merge', dependsOn: ['publish'] },
      ],
      deliveryStub([green], { currentHead: f.head }),
      { acceptedHead: f.head },
      board,
    );
    assert.equal(r.status, 'completed', JSON.stringify(r.steps));
    const merged = board.projections[board.projections.length - 1]!;
    assert.equal(merged.state, 'merged');
    assert.deepEqual(merged.labels, ['takumi-merged']);
    assert.match(merged.detail ?? '', new RegExp(`head ${f.head}`), 'the landed SHA is auditable from the board itself');
    assert.equal(new Set(board.projections.map((p) => p.runId)).size, 1);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// (b) the failure policy: absent is silent, broken is loud, and neither can change the run
// ---------------------------------------------------------------------------------------------

test('board: a run with NO board port projects nowhere and is not decorated with a board line', async () => {
  const f = fixture();
  try {
    const r = await run(
      f,
      [
        { id: 'publish', type: 'publish' },
        { id: 'await_checks', type: 'await_checks', dependsOn: ['publish'] },
      ],
      deliveryStub([green]),
      {},
      undefined,
    );
    assert.equal(r.status, 'completed', JSON.stringify(r.steps));
    for (const s of r.steps) {
      assert.ok(!s.summary.includes('board:'), `no board line for a run with no board (${s.stepId}: ${s.summary})`);
    }
  } finally {
    f.cleanup();
  }
});

test('board: a board that CANNOT be written is LOUD but NEVER FATAL — the delivery is unaffected', async () => {
  const f = fixture();
  const board = stubBoard({ throwOnProject: true });
  try {
    const r = await run(f, [{ id: 'publish', type: 'publish' }], deliveryStub([green]), {}, board);
    // The pull request exists and the run completed: a decorative board must not un-accept a delivery the
    // pipeline, the judge and the host already accepted (ADR-017 rule 2).
    assert.equal(r.status, 'completed', r.steps[0]?.summary);
    assert.match(r.steps[0]?.summary ?? '', /board: COULD NOT be written \(the board answered 502\)/);
    assert.match(r.steps[0]?.summary ?? '', /the delivery is unaffected; the row is stale/);
  } finally {
    f.cleanup();
  }
});

test('board: a broken board does NOT rescue a RED pipeline — the run is failed by the pipeline, not the board', async () => {
  const f = fixture();
  const board = stubBoard({ throwOnProject: true });
  try {
    const r = await run(
      f,
      [
        { id: 'publish', type: 'publish' },
        { id: 'await_checks', type: 'await_checks', dependsOn: ['publish'] },
      ],
      deliveryStub([red]),
      {},
      board,
    );
    assert.equal(r.status, 'failed');
    assert.match(r.steps[1]?.summary ?? '', /board: COULD NOT be written/);
    assert.match(r.steps[1]?.summary ?? '', /1 check\(s\) FAILED/);
  } finally {
    f.cleanup();
  }
});

test('board: with no confirmed requirement the row is titled by the WORKFLOW name', async () => {
  const f = fixture();
  const board = stubBoard();
  try {
    const r = await run(f, [{ id: 'publish', type: 'publish' }], deliveryStub([green]), {}, board, { confirmed: false });
    assert.equal(r.status, 'completed', r.steps[0]?.summary);
    assert.equal(board.projections[0]?.title, 'board-test');
  } finally {
    f.cleanup();
  }
});
