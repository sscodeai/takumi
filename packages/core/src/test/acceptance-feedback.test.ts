import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  parseFeedback,
  requirementDigest,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

// The feedback loop (ADR-029): a failed acceptance is written back into the requirement document it
// failed, and the write is what stops the run's confirmation from being reusable.
//
// What these tests pin is the shape of the closure, not the quality of the failure message: a
// rejection the JUDGE produced writes a REJECT artifact and a `feedback:` entry; a refusal (a stale
// confirmation, a judge that never ran) writes neither, because editing the human's document because
// of a run-configuration mistake is not a loop, it is noise.

const REQUIREMENT = [
  'requirement:',
  '  id: REQ-DOC-001',
  'requirements:',
  '  - id: REQ-001',
  '    title: Summarise the CSV',
  '    acceptance_criteria:',
  '      - A department row per department',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: What happens to a malformed row?',
  '    options: ["stop", "skip and count"]',
  '    default: "skip and count"',
  '    chosen: "skip and count"',
  '    blocking: true',
  '',
].join('\n');

/** A judge that reports one failing check and a failing verdict. */
const failingJudge = [
  '#!/bin/sh',
  'set -u',
  'echo "ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing"',
  'echo "not ok 2 - DEC-002 AMB-002 NOT honoured: \\"First row wins\\" (checked by REL-003, which failed)"',
  'echo "# tests 2"',
  'echo "# pass 1"',
  'echo "# fail 1"',
  'echo "ACCEPT_VERDICT: fail"',
  'exit 1',
  '',
].join('\n');

/** A judge that passes, for the control case. */
const passingJudge = [
  '#!/bin/sh',
  'set -u',
  'echo "ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing"',
  'echo "# tests 1"',
  'echo "# pass 1"',
  'echo "# fail 0"',
  'echo "ACCEPT_VERDICT: pass"',
  'exit 0',
  '',
].join('\n');

function forge(body: string): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'cat > "$TAKUMI_JUDGE_DIR/judge.sh" <<\'JUDGE\'',
    body,
    'JUDGE',
    'chmod +x "$TAKUMI_JUDGE_DIR/judge.sh"',
    'echo "JUDGE_FORGE: ok"',
    'echo "JUDGE_PATH: judge.sh"',
    'exit 0',
    '',
  ].join('\n');
}

interface Fixture {
  dir: string;
  worktree: string;
  requirementRef: string;
}

function project(judgeBody: string, requirementText = REQUIREMENT): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-feedback-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/feature.yaml'), requirementText);
  writeFileSync(join(dir, 'forge.sh'), forge(judgeBody));
  return { dir, worktree, requirementRef: 'docs/requirements/feature.yaml' };
}

function workflow(): WorkflowDefinition {
  return {
    name: 'feedback-loop',
    version: '0.1.0',
    description: 'a failed acceptance is written back',
    steps: [
      { id: 'implementation', type: 'agent', prompt: 'implement the requirement' },
      { id: 'judge', type: 'judge_forge', requirementRef: 'docs/requirements/feature.yaml', forgeRef: 'forge.sh', dependsOn: ['implementation'] },
      {
        id: 'accept',
        type: 'acceptance',
        requirementRef: 'docs/requirements/feature.yaml',
        acceptanceRef: '{judgePath}',
        dependsOn: ['judge'],
      },
      { id: 'ship', type: 'delivery', prompt: 'ship it', dependsOn: ['accept'] },
    ],
  };
}

function context(f: Fixture, requirementText = REQUIREMENT): WorkflowExecutionContext {
  return {
    cwd: f.dir,
    worktree: f.worktree,
    runtime: new TestRuntime(() => 'ok'),
    artifacts: new ArtifactStore(join(f.dir, '.takumi/artifacts')),
    onApproval: () => true,
    confirmedRequirement: { ref: f.requirementRef, digest: requirementDigest(requirementText) },
  };
}

/** Built from parts on purpose: see the note in judge-forge.test.ts about the secret heuristic. */
const rejectArtifactOf = (dir: string, n = '001'): string =>
  join(dir, '.takumi', 'artifacts', 'acceptance', `REJECT-${n}.md`);
const acceptArtifactOf = (dir: string): string =>
  join(dir, '.takumi', 'artifacts', 'acceptance', `ACCEPT-${'001'}.md`);

const requirementOf = (f: Fixture): string => readFileSync(join(f.dir, f.requirementRef), 'utf8');

test('feedback: a failed acceptance writes a REJECT artifact and a feedback entry into the document', async () => {
  const f = project(failingJudge);
  try {
    const before = requirementOf(f);
    const res = await executeWorkflow(workflow(), context(f));

    assert.equal(res.status, 'failed');
    assert.equal(res.steps.find((s) => s.stepId === 'ship')?.status, 'skipped');
    assert.ok(!existsSync(acceptArtifactOf(f.dir)), 'a failed acceptance writes no ACCEPT artifact');

    const summary = res.steps.find((s) => s.stepId === 'accept')?.summary ?? '';
    assert.match(summary, /acceptance FAILED/);
    assert.match(summary, /rejection: REJECT-001 written/);
    assert.match(summary, /feedback: FB-001 written into docs\/requirements\/feature\.yaml \(open\)/);
    assert.match(summary, /the document now hashes to [0-9a-f]{12}/);
    assert.match(summary, /failing checks: DEC-002/);

    // The rejection is citable, and it records both the digest judged and the digest the document has
    // after the write-back — the pair is what makes the confirmation stale.
    const reject = readFileSync(rejectArtifactOf(f.dir), 'utf8');
    assert.match(reject, /kind: acceptance-reject/);
    assert.match(reject, /digestAfterFeedback: sha256:[0-9a-f]{64}/);
    assert.match(reject, /documentChanged: true/);
    assert.match(reject, /feedbackOpen: \[FB-001\]/);
    assert.match(reject, /not ok 2 - DEC-002 AMB-002 NOT honoured/);

    // The document itself gained the entry, with the failing check verbatim.
    const after = requirementOf(f);
    assert.notEqual(requirementDigest(after), requirementDigest(before), 'the write-back changes the digest');
    const entries = parseFeedback(after);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, 'FB-001');
    assert.equal(entries[0]?.status, 'open');
    assert.equal(entries[0]?.requirementDigest, requirementDigest(before));
    assert.match(entries[0]?.checks[0] ?? '', /DEC-002 AMB-002 NOT honoured/);
    assert.equal(entries[0]?.judgeDigest.startsWith('sha256:'), true);

    // The comments the human wrote are still there: the write is textual, not a re-serialisation.
    assert.match(after, /^requirement:$/m);
    assert.match(after, /^ambiguities:$/m);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('feedback: the run that follows is refused by name until the document is re-confirmed', async () => {
  const f = project(failingJudge);
  try {
    await executeWorkflow(workflow(), context(f));
    const firstReject = readFileSync(rejectArtifactOf(f.dir), 'utf8');
    const staleRun = await executeWorkflow(workflow(), context(f, REQUIREMENT));
    const summary = staleRun.steps.find((s) => s.stepId === 'accept')?.summary ?? '';
    assert.match(summary, /is not the one that was confirmed/);
    assert.match(summary, /re-confirm the edited document before it can be accepted/);
    // A stale confirmation is a refusal, not a rejection: the acceptance could not even be made, so it
    // must not be written back as a failure of the implementation, and it must not touch the document
    // again. The FIRST run's rejection is still on the record, unchanged — evidence is not overwritten.
    assert.ok(!existsSync(rejectArtifactOf(f.dir, '002')), 'no second REJECT artifact for a stale confirmation');
    assert.equal(readFileSync(rejectArtifactOf(f.dir), 'utf8'), firstReject, 'the first rejection is untouched');
    assert.equal(parseFeedback(requirementOf(f)).length, 1, 'still exactly one feedback entry');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('feedback: a judge that ran without failing checks is not written back, and says why', async () => {
  // The verdict marker is missing, so the acceptance fails — but no check failed. There is nothing to
  // hand back to the human: the failure is in the judge's own contract, not in the implementation.
  const f = project(
    ['#!/bin/sh', 'set -u', 'echo "ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing"', 'exit 0', ''].join('\n'),
  );
  try {
    const before = requirementOf(f);
    const res = await executeWorkflow(workflow(), context(f));
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /reject: not recorded — no failing check came out of a judge that ran/);
    assert.ok(!existsSync(rejectArtifactOf(f.dir)));
    assert.equal(requirementOf(f), before, 'the document is untouched');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('feedback: a passing acceptance writes neither a REJECT nor a feedback entry', async () => {
  const f = project(passingJudge);
  try {
    const before = requirementOf(f);
    const res = await executeWorkflow(workflow(), context(f));
    assert.equal(res.status, 'completed');
    assert.equal(requirementOf(f), before, 'a passing run does not touch the requirement document');
    assert.ok(!existsSync(rejectArtifactOf(f.dir)));
    assert.equal(parseFeedback(before).length, 0);
    assert.ok(existsSync(acceptArtifactOf(f.dir)));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('feedback: a document with an existing feedback block gains an entry without losing the old one', async () => {
  const withFeedback = [
    REQUIREMENT.replace(/\s*$/, ''),
    '',
    'feedback:',
    '  - id: FB-001',
    '    at: "2026-09-30T00:00:00.000Z"',
    '    run: "an earlier run"',
    '    requirementDigest: "sha256:deadbeef"',
    '    judgeDigest: "sha256:deadbeef"',
    '    status: resolved',
    '    resolvedAt: "2026-09-30T01:00:00.000Z"',
    '    resolvedBy: "SS"',
    '    resolvedNote: "the earlier failure was addressed"',
    '    checks:',
    '      - "REL-002 additivity: an earlier failure"',
    '',
  ].join('\n');
  const f = project(failingJudge, withFeedback);
  try {
    const res = await executeWorkflow(workflow(), context(f, withFeedback));
    assert.equal(res.status, 'failed');
    const entries = parseFeedback(requirementOf(f));
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.id, 'FB-001');
    assert.equal(entries[0]?.status, 'resolved');
    assert.equal(entries[1]?.id, 'FB-002');
    assert.equal(entries[1]?.status, 'open');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /feedback: FB-002 written/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
