#!/usr/bin/env node
/**
 * End-to-end demo of the board + delivery layers (ADR-006 / ADR-007), using the
 * in-memory providers: no credentials, no network, no repository.
 *
 * It exists to make two claims checkable in one command:
 *
 *   1. a run can go from "work item on a board" to "merged pull request" through
 *      the two ports, with the board owning the delivery state and takumi owning
 *      the evidence;
 *   2. the guards actually fire — a dirty worktree is refused, a stale head is
 *      refused, and a board that cannot merge says so instead of pretending.
 *
 * Run: node scripts/board-delivery-demo.mjs
 */
import { FakeBoardProvider } from '../boards/fake/dist/index.js';
import { FakeDeliveryProvider } from '../deliveries/fake/dist/index.js';
import { renderRunMarker } from '../packages/core/dist/index.js';

const RUN_ID = 'c0ffee01';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = `${'b'.repeat(12)}c0mmit000000`;

const timeline = [];
const record = (step, detail) => {
  timeline.push({ step, detail });
  console.log(`  ${step.padEnd(28)} ${detail}`);
};
const guard = (label, outcome) => {
  timeline.push({ step: `guard:${label}`, detail: outcome });
  console.log(`  ⚠ guard ${label.padEnd(20)} ${outcome}`);
};

/** Run `fn`, returning the error message instead of throwing. */
async function expectFailure(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return `${e.name}(${e.kind ?? '-'}): ${e.message}`;
  }
}

async function main() {
  console.log('\nTakumi board + delivery demo (in-memory providers, no credentials)\n');

  // --- the two ports ---------------------------------------------------------
  const board = new FakeBoardProvider({
    items: [
      { id: 'DEMO-7', state: 'ready', title: 'Add the delivery port', labels: ['takumi-ready'] },
      { id: 'DEMO-8', state: 'ready', title: 'Something not started yet', labels: ['takumi-ready'] },
    ],
  });
  const delivery = new FakeDeliveryProvider({ baseSha: BASE_SHA, headSha: HEAD_SHA });

  record('board: metadata', `${board.metadata().name} (${board.metadata().id})`);
  const ready = await board.listWork({ states: ['ready'] });
  record('board.listWork(ready)', `${ready.length} item(s): ${ready.map((i) => i.id).join(', ')}`);

  // --- claim -----------------------------------------------------------------
  const claim = await board.claim('DEMO-7', RUN_ID);
  record('board.claim(DEMO-7)', `claimed=${claim.claimed} by run ${RUN_ID}`);
  const secondClaim = await board.claim('DEMO-8', RUN_ID);
  const thirdClaim = await board.claim('DEMO-7', 'deadbeef');
  guard('double claim', thirdClaim.claimed === false ? `refused: ${thirdClaim.reason}` : 'NOT REFUSED');
  record('board.claim(DEMO-8)', `claimed=${secondClaim.claimed} (the second run keeps working) or refused: ${secondClaim.reason ?? '-'}`);

  // --- the "agent" commits, then the runner closes out ------------------------
  await board.transition('DEMO-7', 'pr_open', { runId: RUN_ID, note: 'agent committed; runner closes out' });
  record('board.transition', `DEMO-7 → ${(await board.getWork('DEMO-7')).state}`);

  const delivered = await delivery.deliver(
    {
      worktree: '/tmp/takumi-demo-worktree',
      branch: 'takumi/demo-7-c0ffee01',
      baseBranch: 'main',
      itemId: 'DEMO-7',
      runId: RUN_ID,
      title: 'Add the delivery port',
    },
    { baseSha: BASE_SHA },
  );
  record('delivery.deliver', `created=${delivered.created} push=${delivered.push.mode} pr=${delivered.pr.number}`);
  const reused = await delivery.deliver(
    {
      worktree: '/tmp/takumi-demo-worktree',
      branch: 'takumi/demo-7-c0ffee01',
      baseBranch: 'main',
      itemId: 'DEMO-7',
      runId: RUN_ID,
    },
    { baseSha: BASE_SHA },
  );
  record('delivery.deliver again', `created=${reused.created} pr=${reused.pr.number} (same PR, new commits only)`);

  delivery.setChecks([
    { name: 'build', conclusion: 'success' },
    { name: 'tests', conclusion: 'pending' },
  ]);
  const checks = await delivery.checks(delivered.pr);
  record('delivery.checks', checks.map((c) => `${c.name}=${c.conclusion}`).join(' '));

  await board.writeState('DEMO-7', {
    schema: 1,
    runId: RUN_ID,
    item: 'DEMO-7',
    reviewRound: 0,
    updatedAt: new Date().toISOString(),
    deliveryRef: `#${delivered.pr.number}`,
  });
  const state = await board.readState('DEMO-7');
  record('board.readState', `resumable record: run=${state?.runId} pr=${String(state?.deliveryRef)}`);

  // --- the guards -------------------------------------------------------------
  const staleMerge = await expectFailure(() =>
    delivery.merge(delivered.pr, { expectedHeadSha: `${'c'.repeat(12)}notreviewed00` }),
  );
  guard('stale-head merge', staleMerge ?? 'NOT REFUSED');

  delivery.setDirty(true);
  const dirtyDeliver = await expectFailure(() =>
    delivery.deliver(
      {
        worktree: '/tmp/takumi-demo-worktree',
        branch: 'takumi/demo-7-c0ffee01',
        baseBranch: 'main',
        itemId: 'DEMO-7',
        runId: RUN_ID,
      },
      { baseSha: BASE_SHA },
    ),
  );
  delivery.setDirty(false);
  guard('dirty worktree', dirtyDeliver ?? 'NOT REFUSED');

  const notionLike = new FakeBoardProvider({
    items: [{ id: 'PAGE-1', state: 'ready' }],
    capabilities: { delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false } },
  });
  guard(
    'board capability',
    `a Notion-like board reports delivery=[none] → ${JSON.stringify(notionLike.capabilities().delivery)}`,
  );

  // --- the happy ending -------------------------------------------------------
  const merged = await delivery.merge(delivered.pr, { expectedHeadSha: delivered.pr.headSha, method: 'merge' });
  record('delivery.merge', `merged=${merged.merged} head=${merged.headSha.slice(0, 12)} method=${merged.method}`);
  await board.transition('DEMO-7', 'merged', { runId: RUN_ID, note: `merged ${merged.headSha.slice(0, 8)}` });
  await board.comment('DEMO-7', `Delivered: ${delivered.pr.url}\n\n${renderRunMarker(RUN_ID)}`, { runId: RUN_ID });
  record('board final state', (await board.getWork('DEMO-7')).state);

  const failures = timeline.filter((t) => t.step.startsWith('guard:') && /NOT REFUSED/.test(t.detail));
  console.log(`\n${timeline.length} steps, ${failures.length} guard(s) that did not fire.\n`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
