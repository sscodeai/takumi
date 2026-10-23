import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/chain-eval.sh` measures THE CHAIN, from the run records it already writes.
//
// The agent's reliability is measured by `eval/` (23 held-out tasks). The chain's reliability has only
// ever been measured by hand — thirteen rounds in docs/unattended-chain-measurements.md, each an
// afternoon of running the thing three times and reading logs. That does not accumulate and it does not
// notice regressions. Every run already writes `.takumi/runs/<id>.json` with the facts the four metrics
// need; nobody was aggregating it.
//
// These tests pin the DEFINITIONS, because a metric whose definition drifts is worse than no metric:
// people quote the number and stop looking at what it counted.
const SCRIPT = fileURLToPath(new URL('../../../../scripts/chain-eval.sh', import.meta.url));

/** One run record, with only the fields the aggregation reads. */
function record(opts: {
  run: string;
  outcome?: string;
  accepted?: boolean;
  mergedSha?: string | null;
  summary?: string;
  failureStep?: string;
  agentTools?: string;
  durationMs?: number;
  workflow?: string;
}) {
  return {
    runId: opts.run,
    workflow: opts.workflow ?? 'request-to-delivery',
    outcome: opts.outcome ?? 'completed',
    accepted: opts.accepted ?? true,
    finishedAt: '2026-10-20T00:00:00.000Z',
    durationMs: opts.durationMs ?? 1000,
    // `??` would swallow an explicit null, and an explicit null is exactly the case this fixture
    // exists to model (a completed run that never merged) — the first version of this helper used
    // `opts.mergedSha ?? 'abc123'` and made the false-completion test pass for the wrong reason.
    published: { pullRequest: null, issue: null, mergedSha: opts.mergedSha === undefined ? 'abc123' : opts.mergedSha },
    failure: opts.failureStep === undefined ? null : { stepId: opts.failureStep, message: 'x' },
    boundaries: { stepCommands: 'none', agentTools: opts.agentTools ?? 'confined', agentRuntime: 'pi', acceptanceSubject: 'none' },
    steps: [
      { id: 'delivery_attempt', kind: 'repair', status: opts.accepted === false ? 'failed' : 'done', summary: opts.summary ?? 'delivery accepted on the first attempt' },
    ],
  };
}

function withRuns(records: object[], extra?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'chain-eval-'));
  mkdirSync(join(dir, 'runs'), { recursive: true });
  records.forEach((r, i) => {
    writeFileSync(join(dir, 'runs', `wf-${String(i).padStart(4, '0')}.json`), JSON.stringify(r));
  });
  for (const [name, body] of Object.entries(extra ?? {})) {
    writeFileSync(join(dir, 'runs', name), body);
  }
  return dir;
}

function run(dir: string, ...args: string[]) {
  return spawnSync('bash', [SCRIPT, '--dir', join(dir, 'runs'), ...args], { cwd: dir, encoding: 'utf8' });
}

test('chain-eval: the four metrics are the eval/ metrics, computed from run records', () => {
  const dir = withRuns([
    record({ run: 'wf-a', summary: 'delivery accepted on the first attempt' }),
    record({ run: 'wf-b', summary: 'delivery accepted on the first attempt' }),
    record({ run: 'wf-c', summary: 'delivery accepted on attempt 2 of 2' }),          // repaired, then landed
    record({ run: 'wf-d', accepted: false, mergedSha: null, failureStep: 'delivery_attempt', summary: 'delivery refused after 2 of 2 attempt(s)' }),
  ]);
  try {
    const r = run(dir, '--json');
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.runs, 4);
    // 2 of 4 accepted on attempt 1
    assert.equal(rep.counts.first_attempt, 2);
    assert.equal(rep.metrics.first_attempt_rate, 0.5);
    // 1 of 2 runs that entered the repair loop came out delivered
    assert.equal(rep.counts.entered_repair, 2, 'wf-c repaired, wf-d entered and never landed');
    assert.equal(rep.counts.repaired_then_accepted, 1);
    assert.equal(rep.metrics.repair_rescue_rate, 0.5);
    // 3 of 4 accepted AND merged
    assert.equal(rep.counts.merged, 3);
    assert.equal(rep.metrics.final_success_rate, 0.75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE METRIC THAT MATTERS MOST. eval/RESULTS.md defines false completion as "claimed SUCCESS AND
// verification FAILED". For the chain the claim is `outcome: completed` and the verification is
// "accepted AND actually merged" — a run that says it finished and did not land is exactly the failure
// the whole "Agents propose. Takumi verifies." proposition exists to make impossible.
test('chain-eval: a run that CLAIMS success without landing is a false completion', () => {
  const dir = withRuns([
    record({ run: 'wf-honest', mergedSha: 'aaa' }),
    record({ run: 'wf-liar', mergedSha: null }),                    // completed, accepted, but never merged
    record({ run: 'wf-failed', outcome: 'failed', accepted: false, mergedSha: null }), // honest failure
  ]);
  try {
    const r = run(dir, '--json');
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.counts.false_completion, 1, 'the un-merged "completed" run is the false completion');
    assert.equal(rep.metrics.false_completion_rate, 0.5, 'measured over CLAIMED runs (2 claimed, 1 false)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-eval: an unreadable record is COUNTED, never silently dropped', () => {
  // A metric that quietly skips what it cannot parse reports a cleaner number than reality, which is
  // the worst possible direction for a reliability metric to be wrong in.
  const dir = withRuns([record({ run: 'wf-a' })], { 'wf-broken.json': '{not json' });
  try {
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 record\(s\) could not be read/);
    assert.match(r.stdout, /wf-broken\.json/);
    const j = JSON.parse(run(dir, '--json').stdout);
    assert.equal(j.unreadable_records, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-eval: a small sample SAYS it is a small sample', () => {
  // Five runs move these numbers by 10-20 points. A tool that printed "80%" without saying n=5 would be
  // manufacturing confidence, which is the failure mode an honest metrics script exists to avoid.
  const dir = withRuns([record({ run: 'wf-a' }), record({ run: 'wf-b' })]);
  try {
    const r = run(dir);
    assert.match(r.stdout, /SMALL SAMPLE/);
    assert.match(r.stdout, /2 run\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-eval: only delivery runs are its subject', () => {
  // The intake writes its own records; counting them as deliveries would inflate every denominator and
  // make the rate mean nothing in particular.
  const dir = withRuns([
    record({ run: 'wf-intake', workflow: 'request-intake' }),
    record({ run: 'wf-attempt', workflow: 'request-to-delivery-attempt' }),
    record({ run: 'wf-delivery' }),
  ]);
  try {
    const rep = JSON.parse(run(dir, '--json').stdout);
    assert.equal(rep.runs, 1, 'one delivery run, not three records');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-eval: --since filters by finish time, and an empty window is not an error', () => {
  const dir = withRuns([record({ run: 'wf-a' })]);
  try {
    const rep = JSON.parse(run(dir, '--json', '--since', '2030-01-01').stdout);
    assert.equal(rep.runs, 0);
    const text = run(dir, '--since', '2030-01-01');
    assert.equal(text.status, 0, 'an empty window is a fact, not a failure');
    assert.match(text.stdout, /no delivery runs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-eval: a missing runs directory is a refusal, not a zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chain-eval-none-'));
  try {
    const r = spawnSync('bash', [SCRIPT, '--dir', join(dir, 'nope')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2, 'a check that cannot see its input must not report a clean rate');
    assert.match(r.stderr, /no runs directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
