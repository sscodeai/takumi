import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  parseAcceptVerdict,
  requirementDigest,
  validateWorkflowManifest,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
  type WorkflowStep,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

// The acceptance step (ADR-025): a verdict on ONE confirmed requirement document, produced by a
// harness that is not the implementation's own test. What makes it evidence rather than ceremony is
// what these tests pin: the document must be the one that was confirmed, the verdict must be a
// structured marker, a failure writes no ACCEPT artifact, and a failed acceptance stops the steps
// behind it.

const REQUIREMENT = [
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
  '    blocking: true',
  '',
].join('\n');

const EDITED_REQUIREMENT = REQUIREMENT.replace('skip and count"]', 'stop"]');

function project(harness: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-accept-'));
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/feature.yaml'), REQUIREMENT);
  writeFileSync(join(dir, 'checks/accept.sh'), harness);
  chmodSync(join(dir, 'checks/accept.sh'), 0o755);
  return dir;
}

function workflow(step: Partial<WorkflowStep> = {}): WorkflowDefinition {
  return {
    name: 'blackbox-acceptance',
    version: '0.1.0',
    description: 'acceptance step',
    steps: [
      { id: 'accept', type: 'acceptance', requirementRef: 'docs/requirements/feature.yaml', acceptanceRef: 'checks/accept.sh', ...step },
      { id: 'ship', type: 'delivery', prompt: 'ship it', dependsOn: ['accept'] },
    ],
  };
}

async function run(
  dir: string,
  confirmed: WorkflowExecutionContext['confirmedRequirement'],
  step: Partial<WorkflowStep> = {},
) {
  const ctx: WorkflowExecutionContext = {
    cwd: dir,
    runtime: new TestRuntime(() => 'ok'),
    artifacts: new ArtifactStore(join(dir, '.takumi/artifacts')),
    onApproval: () => true,
    ...(confirmed === undefined ? {} : { confirmedRequirement: confirmed }),
  };
  return executeWorkflow(workflow(step), ctx);
}

const okHarness = [
  '#!/bin/sh',
  'echo "ok 1 - a department row exists"',
  'echo "ok 2 - the malformed row was skipped and counted"',
  'echo "# tests 2"',
  'echo "# pass 2"',
  'echo "# fail 0"',
  'echo "ACCEPT_VERDICT: pass"',
  'exit 0',
  '',
].join('\n');

const confirmed = { ref: 'docs/requirements/feature.yaml', digest: requirementDigest(REQUIREMENT) };

// --- the manifest refuses an acceptance that could not mean anything --------------------------

test('acceptance: a manifest with no requirementRef is refused, and says why', () => {
  const issues = validateWorkflowManifest({
    name: 'w',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'accept', type: 'acceptance', acceptanceRef: 'checks/accept.sh' }],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /requires a non-empty requirementRef/);
});

test('acceptance: a manifest with no acceptanceRef is refused, and says why', () => {
  const issues = validateWorkflowManifest({
    name: 'w',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'accept', type: 'acceptance', requirementRef: 'docs/requirements/feature.yaml' }],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /requires a non-empty acceptanceRef/);
});

// --- the verdict is a structured marker, never prose ------------------------------------------

test('acceptance verdict: only a structured marker decides, and only pass can pass', () => {
  assert.deepEqual(parseAcceptVerdict('ACCEPT_VERDICT: pass\n'), { verdict: 'pass' });
  // Decoration around the VALUE is tolerated (a markdown-minded harness); the key is not.
  assert.deepEqual(parseAcceptVerdict('ACCEPT_VERDICT: **FAIL**\n'), { verdict: 'fail' });
  assert.deepEqual(parseAcceptVerdict('accept_verdict = pass\n'), { verdict: 'pass' });
  // Missing: fails closed. The harness's prose saying "everything is fine" decides nothing.
  assert.match(String(parseAcceptVerdict('all checks look good to me\n').error), /was missing/);
  // Unknown value: fails closed.
  assert.match(String(parseAcceptVerdict('ACCEPT_VERDICT: mostly\n').error), /unrecognised/);
  // Two conflicting markers: fails closed.
  assert.match(String(parseAcceptVerdict('ACCEPT_VERDICT: pass\nACCEPT_VERDICT: fail\n').error), /ambiguous/);
});

// --- the step ---------------------------------------------------------------------------------

test('acceptance: a passing harness against the confirmed document writes the ACCEPT artifact', async () => {
  const dir = project(okHarness);
  try {
    const res = await run(dir, confirmed);
    assert.equal(res.status, 'completed', `the workflow completes (${JSON.stringify(res.steps.map((s) => [s.stepId, s.status]))})`);
    const accept = res.steps.find((s) => s.stepId === 'accept');
    assert.equal(accept?.status, 'completed');
    assert.match(accept?.summary ?? '', /acceptance PASSED/);

    const artifact = readFileSync(join(dir, '.takumi/artifacts/acceptance/ACCEPT-001.md'), 'utf8');
    assert.match(artifact, /kind: acceptance/);
    assert.match(artifact, new RegExp(`digest: sha256:${requirementDigest(REQUIREMENT)}`), 'the requirement digest is recorded');
    assert.match(artifact, /requirements: \[REQ-001\]/);
    assert.match(artifact, /verdictMarker: "ACCEPT_VERDICT: pass"/);
    assert.match(artifact, /"pass: a department row exists"/, 'the harness checks are recorded, not summarised');
    assert.match(artifact, new RegExp(`digest: sha256:${confirmed.digest}`), 'the confirmed digest is recorded beside the document digest');
    assert.match(artifact, /- requirement-digest-change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance: an EDITED requirement is refused by name, and nothing is delivered', async () => {
  const dir = project(okHarness);
  try {
    // The human confirmed the document as it was; the file has since been edited.
    writeFileSync(join(dir, 'docs/requirements/feature.yaml'), EDITED_REQUIREMENT);
    const res = await run(dir, confirmed);

    assert.equal(res.status, 'failed');
    const accept = res.steps.find((s) => s.stepId === 'accept');
    assert.equal(accept?.status, 'failed');
    const summary = accept?.summary ?? '';
    assert.match(summary, /is not the one that was confirmed/);
    // Both digests are named, so the reader can tell what changed.
    assert.match(summary, /confirmed [0-9a-f]{12} at "docs\/requirements\/feature\.yaml"/);
    assert.match(summary, /now hashes to [0-9a-f]{12}/);
    assert.match(summary, /re-confirm the edited document/);
    // A failed acceptance must not leave an ACCEPT artifact behind.
    assert.throws(() => readFileSync(join(dir, '.takumi/artifacts/acceptance/ACCEPT-001.md'), 'utf8'));
    // And the delivery behind it must not run.
    assert.equal(res.steps.find((s) => s.stepId === 'ship')?.status, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance: no confirmation on record fails the step (a machine must not grade itself)', async () => {
  const dir = project(okHarness);
  try {
    const res = await run(dir, undefined);
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /no confirmed requirement is on record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance: a harness with no verdict marker fails, and writes no ACCEPT artifact', async () => {
  const dir = project('#!/bin/sh\necho "ok 1 - looks fine"\necho "# tests 1"\necho "# pass 1"\necho "# fail 0"\nexit 0\n');
  try {
    const res = await run(dir, confirmed);
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /was missing/);
    assert.throws(() => readFileSync(join(dir, '.takumi/artifacts/acceptance/ACCEPT-001.md'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance: a failing verdict fails the step even when the harness exits 0', async () => {
  const dir = project('#!/bin/sh\necho "not ok 1 - the row count is wrong"\necho "# tests 1"\necho "# fail 1"\necho "ACCEPT_VERDICT: fail"\nexit 0\n');
  try {
    const res = await run(dir, confirmed);
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /acceptance FAILED/);
    assert.equal(res.steps.find((s) => s.stepId === 'ship')?.status, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance: a missing requirement document fails, naming the path', async () => {
  const dir = project(okHarness);
  try {
    rmSync(join(dir, 'docs/requirements/feature.yaml'));
    const res = await run(dir, confirmed);
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
