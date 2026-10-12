/**
 * THE BRIEF COMES FROM THE STEP THAT FAILED, AND A FAILURE NO IMPLEMENTATION CAN REPAIR ENDS THE LOOP.
 *
 * Both come from the same run (2026-10-12, the third unattended chain, docs/bugs-fixed.md #68). Its
 * `delivery_attempt` is a `repair` step with `maxRounds: 2`; the first attempt's `judge_forge` refused the
 * DOCUMENT (no totals line, #69) and the acceptance that would have reported it was SKIPPED, because it
 * depends on the forge. So the second attempt was handed
 *
 *     the acceptance failed without naming a failing check the engine could read: treat the run log as
 *     the brief, and note that a judge which reported nothing has told you nothing
 *
 * — a brief that named no failing check while the run log named one. And because a document does not
 * change between attempts, the second round re-paid 1 047 s to fail identically; its implementer, told to
 * repair a failure no implementation could touch, left the delivery worktree and edited the platform
 * itself (#68).
 *
 * What these tests pin, in the order the chain meets them:
 *   (a) when the acceptance never ran, the next attempt is told what the step that DID fail said;
 *   (b) a `judge_forge` refusal stops the loop — the remaining round is not spent, and the run says why;
 *   (c) the manifests carry the wiring: the intake is a repair round over its own sub-workflow (ADR-057),
 *       and the delivery's agent steps declare a bound.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore,
  executeWorkflow,
  requirementDigest,
  validateWorkflowManifest,
  type WorkflowDefinition,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));

const DOC = [
  'requirement:',
  '  id: REQ-DOC-001',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: How are malformed rows handled?',
  '    options: ["skip and count", "stop"]',
  '    default: "skip and count"',
  '    chosen: "skip and count"',
  '    blocking: false',
  'deliverable:',
  '  run: "bash deliver.sh {csv}"',
  '  input_format:',
  '    columns: "date:date,station:id,temperature_c:measure"',
  '    sample: |',
  '      2024-01-01,ALPHA,10.4',
  '      2024-01-01,BRAVO,-2.5',
  '      2024-01-02,ALPHA,11.6',
  '  output_format:',
  '    station_line:',
  '      shape: "<station> <count> <min> <max> <mean>"',
  '      fields: [id, count, min, max, mean]',
  '  relations:',
  '    - id: REL-001',
  '      relation: additivity',
  '',
].join('\n');

/** The document contract, as TAP: it passes once the agent has written `fixed`. */
const SHAPE = `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/fixed" ]; then
  echo "ok 1 - the document carries exactly one totals line"
  echo "# tests 1"
  echo "# pass 1"
  echo "# fail 0"
  exit 0
fi
echo "not ok 1 - the document carries exactly one totals line"
echo "# tests 1"
echo "# pass 0"
echo "# fail 1"
exit 1
`;

/** The acceptance, which the repair loop reads when it DOES run. */
const HARNESS = `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/fixed" ]; then
  echo "ok 1 - REL-001 additivity: the totals add up"
  echo "ACCEPT_VERDICT: pass"
  exit 0
fi
echo "not ok 1 - REL-001 additivity: the totals do not add up"
echo "ACCEPT_VERDICT: fail"
exit 1
`;

/** A forge that cannot build a judge from the document — a DOCUMENT-level refusal, by construction. */
const REFUSING_FORGE = `#!/usr/bin/env bash
echo "the deliverable block declares 0 output line(s) that are neither a per-id line nor a skipped line, where exactly one totals line is needed" >&2
exit 1
`;

interface Project {
  dir: string;
  docText: string;
}

function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-brief-'));
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'requirements', 'feature.yaml'), DOC);
  writeFileSync(join(dir, 'shape.sh'), SHAPE, { mode: 0o755 });
  writeFileSync(join(dir, 'harness.sh'), HARNESS, { mode: 0o755 });
  writeFileSync(join(dir, 'refusing-forge.sh'), REFUSING_FORGE, { mode: 0o755 });
  return { dir, docText: DOC };
}

async function run(
  p: Project,
  sub: WorkflowDefinition,
  onAgent: (index: number) => void,
): Promise<{ status: string; prompts: string[]; step: { status: string; summary: string } }> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-brief-artifacts-'));
  const prompts: string[] = [];
  let index = 0;
  try {
    const runtime = new TestRuntime((task) => {
      prompts.push(task.prompt ?? '');
      index += 1;
      onAgent(index);
      return 'did the work';
    });
    const parent: WorkflowDefinition = {
      name: 'request-to-delivery',
      version: '0.2.0',
      description: '',
      steps: [{ id: 'delivery_attempt', type: 'repair', repairRef: 'the-attempt', maxRounds: 2 }],
    };
    const res = await executeWorkflow(
      parent,
      {
        cwd: p.dir,
        runtime,
        artifacts: new ArtifactStore(artifacts),
        onApproval: () => true,
        confirmedRequirement: { ref: 'docs/requirements/feature.yaml', digest: requirementDigest(p.docText) },
        loadWorkflow: async (ref: string) => {
          assert.equal(ref, 'the-attempt');
          return sub;
        },
      },
      { input: 'the request' },
    );
    const step = res.steps.find((s) => s.stepId === 'delivery_attempt');
    return { status: res.status, prompts, step: { status: step?.status ?? '?', summary: step?.summary ?? '' } };
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
}

test('a failure whose acceptance never ran is briefed from the step that DID fail', async () => {
  const p = project();
  try {
    const sub: WorkflowDefinition = {
      name: 'the-attempt',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'implementation', type: 'agent', prompt: 'Attempt {repairRound}. Brief:\n{repairFailures}\n— end.', timeoutMs: 600000 },
        { id: 'shape_gate', type: 'quality_gate', prompt: 'bash shape.sh', dependsOn: ['implementation'], timeoutMs: 120000 },
        // The acceptance DEPENDS on the gate, so a refusing gate SKIPS it — which is exactly the situation
        // that produced the empty brief. Its summary is available only if something else failed.
        {
          id: 'artifact_acceptance',
          type: 'acceptance',
          requirementRef: 'docs/requirements/feature.yaml',
          acceptanceRef: join(p.dir, 'harness.sh'),
          dependsOn: ['shape_gate'],
        },
      ],
    };
    const res = await run(p, sub, (n) => {
      if (n === 2) writeFileSync(join(p.dir, 'fixed'), 'repaired\n');
    });

    assert.equal(res.status, 'completed', res.step.summary);
    assert.equal(res.prompts.length, 2, 'one implementation task per attempt');
    assert.ok(
      !(res.prompts[0] ?? '').includes('not ok'),
      'the first attempt is not told about a failure that has not happened',
    );
    assert.match(
      res.prompts[1] ?? '',
      /the document carries exactly one totals line/,
      `the second attempt is told what the gate refused\n${res.prompts[1] ?? ''}`,
    );
    assert.ok(
      !(res.prompts[1] ?? '').includes('a judge which reported nothing'),
      'the sentinel is not handed to an implementer while the run log names a failing check',
    );
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a judge that cannot be forged from the document ends the loop: the remaining round is not spent', async () => {
  const p = project();
  try {
    const sub: WorkflowDefinition = {
      name: 'the-attempt',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'implementation', type: 'agent', prompt: 'Attempt {repairRound}', timeoutMs: 600000 },
        {
          id: 'judge_forge',
          type: 'judge_forge',
          requirementRef: 'docs/requirements/feature.yaml',
          forgeRef: join(p.dir, 'refusing-forge.sh'),
          dependsOn: ['implementation'],
          timeoutMs: 60000,
        },
        {
          id: 'artifact_acceptance',
          type: 'acceptance',
          requirementRef: 'docs/requirements/feature.yaml',
          acceptanceRef: join(p.dir, 'harness.sh'),
          dependsOn: ['judge_forge'],
        },
      ],
    };
    const res = await run(p, sub, () => {});

    assert.equal(res.status, 'failed');
    assert.equal(res.prompts.length, 1, 'the second round is NOT started: another attempt cannot change the document');
    assert.match(res.step.summary, /could not be forged from the confirmed document \(judge_forge\)/);
    assert.match(res.step.summary, /the remaining round\(s\) were not spent/);
    assert.match(res.step.summary, /exactly one totals line is needed/, 'the operator sees the forge’s own reason');
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('the manifests carry the wiring: the intake is a repair round, and the delivery’s agent steps are bounded', () => {
  // Declared-in-the-manifest assertions, in the style this repository already uses for the intake
  // (`produced-output.test.ts` asserts the REAL manifest declares the document its agent step produces):
  // the wiring is what the run reads, so a workflow file that lost it is a defect no unit test of the
  // engine would catch.
  const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

  const intake = read('extensions/workflows/request-intake/workflow.yaml');
  assert.match(intake, /- id: intake_attempt/, 'the intake runs an attempt it can repair');
  assert.match(intake, /type: repair\n\s*repairRef: intake-attempt/, 'the attempt is a `repair` over its own sub-workflow');
  assert.match(intake, /maxRounds: 2/, 'a bad sample gets one repair, not a lost run');
  assert.match(intake, /dependsOn: \[intake_attempt\]/, 'the confirmation happens after the attempt, not after a bare agent step');

  const sub = read('extensions/workflows/intake-attempt/workflow.yaml');
  assert.match(sub, /- id: req_intake[\s\S]*?type: agent/, 'the attempt writes the document with an agent');
  assert.match(sub, /- id: req_intake[\s\S]*?timeoutMs: 900000/, 'the agent has a bound');
  assert.match(sub, /- id: req_intake[\s\S]*?produces:\n\s*- docs\/requirements\/intake.yaml/, 'the document is a declared output');
  assert.match(sub, /\{repairFailures\}/, 'the next attempt is told what the contract refused');
  assert.match(sub, /- id: intake_shape[\s\S]*?type: quality_gate/, 'the gate is the attempt’s verdict — what the engine reads as the brief');
  assert.match(sub, /- id: intake_shape[\s\S]*?dependsOn: \[req_intake\]/, 'the gate runs on the document the agent wrote');

  const delivery = read('extensions/workflows/request-to-delivery-attempt/workflow.yaml');
  for (const id of ['implementation', 'unit_and_integration_tests']) {
    const block = delivery.slice(delivery.indexOf(`- id: ${id}`), delivery.indexOf('- id:', delivery.indexOf(`- id: ${id}`) + 5));
    assert.match(
      block,
      /timeoutMs: [1-9][0-9]{5,}/,
      `${id} declares a bound: a wandering agent must not spend without limit (docs/bugs-fixed.md #68)`,
    );
  }
});
