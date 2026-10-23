import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/chain-failures.sh` answers the question `chain-eval.sh` cannot: the chain's first-attempt
// rate is 45%, and "the delivery was refused" covers four different faults that want four different
// fixes. This groups them by WHO COULD HAVE PREVENTED IT.
//
// The taxonomy's ORDER is the design, and these tests pin it, because getting it wrong is invisible:
// the report still looks plausible, it just attributes the failures to the wrong layer and sends the
// work to the wrong place.
const SCRIPT = fileURLToPath(new URL('../../../../scripts/chain-failures.sh', import.meta.url));

function delivery(run: string, message: string, finishedAt = '2026-10-20T00:00:00.000Z') {
  return {
    runId: run,
    workflow: 'request-to-delivery',
    outcome: 'failed',
    accepted: false,
    finishedAt,
    durationMs: 1000,
    published: { pullRequest: null, issue: null, mergedSha: null },
    failure: { stepId: 'delivery_attempt', message },
    steps: [{ id: 'delivery_attempt', status: 'failed', summary: message }],
  };
}

function attempt(run: string, failedStep: string, summary: string) {
  return {
    runId: run,
    workflow: 'request-to-delivery-attempt',
    outcome: 'failed',
    accepted: false,
    finishedAt: '2026-10-20T00:00:00.000Z',
    published: { pullRequest: null, issue: null, mergedSha: null },
    failure: null,
    steps: [{ id: failedStep, status: 'failed', summary }],
  };
}

function withRuns(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'chain-fail-'));
  mkdirSync(join(dir, 'runs'), { recursive: true });
  records.forEach((r, i) => {
    writeFileSync(join(dir, 'runs', `wf-${String(i).padStart(4, '0')}.json`), JSON.stringify(r));
  });
  return dir;
}

function run(dir: string, ...args: string[]) {
  return spawnSync('bash', [SCRIPT, '--dir', join(dir, 'runs'), '--json', ...args], { cwd: dir, encoding: 'utf8' });
}

test('chain-failures: a document no judge can be forged from is the DOCUMENT\'s fault', () => {
  // Measured in this repository: three runs died with "the judge could not be forged from the confirmed
  // document ... and no implementation can change it". Attributing those to the model sends the work to
  // the wrong layer entirely.
  const dir = withRuns([
    delivery('wf-a', 'delivery reached no verdict: the judge could not be forged from the confirmed document (judge_forge), and no implementation can change it'),
  ]);
  try {
    const rep = JSON.parse(run(dir).stdout);
    assert.equal(rep.by_group.document.count, 1);
    assert.equal(rep.refused, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-failures: a judge refusing a real implementation is NOT the document\'s fault', () => {
  // THE ORDERING BUG THIS PINS. An earlier taxonomy matched `acceptance FAILED` inside the document
  // group, which mislabelled three runs whose judge had legitimately refused a real implementation.
  // "The judge refused" is the loop WORKING — it must never be filed next to "no implementation could
  // have passed", because those want opposite responses.
  const dir = withRuns([
    delivery('wf-b', 'delivery refused after 2 of 2 attempt(s): the last failure was written back\n--- repair round 2 of 2: refused ---\nacceptance FAILED: the harness reported a failing verdict\nnot ok 1 - REL-001 malformed-row-accounting\nfailing checks: REL-001, DEC-001'),
  ]);
  try {
    const rep = JSON.parse(run(dir).stdout);
    assert.equal(rep.by_group['judge-refused']?.count, 1, JSON.stringify(rep.by_group));
    assert.equal(rep.by_group.document, undefined, 'a real refusal is not a document fault');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-failures: a missing ENV VAR is the ENGINE\'s fault', () => {
  // `PiRuntimeAdapter: missing env OPENCODE_GO_API_KEY` (ledger #93) cost full repair rounds on a cause
  // no implementation could reach. It belongs with the engine, and the record names it plainly.
  const dir = withRuns([
    delivery('wf-c', 'delivery refused after 2 of 2 attempt(s)\n--- attempt 1 of 2: refused ---\nPiRuntimeAdapter: missing env OPENCODE_GO_API_KEY — set it or pass apiKeyEnv'),
  ]);
  try {
    const rep = JSON.parse(run(dir).stdout);
    assert.equal(rep.by_group.infrastructure?.count, 1, JSON.stringify(rep.by_group));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// LEDGER #98: THE PARENT CAN LOSE THE REASON. A parent message that says only "refused" is not
// attributable on its own — but the CHILD attempt record carries the failing step and its message, and
// that is where the answer is. Falling back to it turns an "unknown" into a diagnosis.
test('chain-failures: when the parent lost the reason, the CHILD record is classified', () => {
  const dir = withRuns([
    delivery('wf-d', 'delivery refused after 2 of 2 attempt(s): the last failure was written back'),
    attempt('wf-d-child', 'artifact_acceptance', 'acceptance FAILED: the acceptance verdict marker "ACCEPT_VERDICT: <pass|fail>" was missing'),
  ]);
  try {
    const rep = JSON.parse(run(dir).stdout);
    assert.equal(rep.by_group.infrastructure?.count, 1, 'the child names a missing verdict marker: an engine fault');
    assert.equal(rep.by_inner_step.artifact_acceptance, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain-failures: a refusal with NO reason anywhere is reported as a RECORDING defect', () => {
  // Not silently bucketed into a plausible group. A run whose reason is lost cannot be learned from, and
  // saying so is the difference between a metric and a guess.
  const dir = withRuns([delivery('wf-e', 'delivery refused after 2 of 2 attempt(s): the last failure was written back')]);
  try {
    const r = run(dir);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.by_group.unclassified?.count, 1);
    const text = spawnSync('bash', [SCRIPT, '--dir', join(dir, 'runs')], { cwd: dir, encoding: 'utf8' }).stdout;
    assert.match(text, /cannot be attributed/);
    assert.match(text, /RECORDING defect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
