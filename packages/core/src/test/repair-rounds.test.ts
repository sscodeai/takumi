import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  requirementDigest,
  validateWorkflowManifest,
  type WorkflowDefinition,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

/**
 * The repair rounds (ADR-034): a refused delivery is repaired against the judge's failing checks and
 * judged again, and only a run that spends every attempt edits the human's requirement document.
 *
 * The harness here is a real script whose verdict flips when the "implementation" is fixed, so what these
 * tests measure is the WIRING: how many attempts were made, what the next attempt was told, and whether
 * the document moved.
 */

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

const HARNESS = `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/fixed" ]; then
  echo "ok 1 - REL-001 additivity: the totals add up"
  echo "# tests 1"
  echo "# pass 1"
  echo "# fail 0"
  echo "ACCEPT_VERDICT: pass"
  exit 0
fi
echo "not ok 1 - REL-001 additivity: department totals sum to 0 but the report says 428 — sum=0 reported=428"
echo "# tests 1"
echo "# pass 0"
echo "# fail 1"
echo "ACCEPT_VERDICT: fail"
exit 1
`;

interface Project {
  dir: string;
  docPath: string;
  docText: string;
  cleanup: () => void;
}

function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-repair-'));
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  const docPath = join(dir, 'docs', 'requirements', 'feature.yaml');
  writeFileSync(docPath, DOC);
  writeFileSync(join(dir, 'harness.sh'), HARNESS, { mode: 0o755 });
  return { dir, docPath, docText: DOC, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The sub-workflow a `repair` step runs: one agent step, then the acceptance that judges it. */
function attemptWorkflow(harnessPath: string): WorkflowDefinition {
  return {
    name: 'request-to-delivery-attempt',
    version: '0.1.0',
    description: '',
    steps: [
      {
        id: 'implementation',
        type: 'agent',
        prompt: 'Attempt {repairRound}. Repair brief:\n{repairFailures}\n— end of brief.',
      },
      {
        id: 'artifact_acceptance',
        type: 'acceptance',
        requirementRef: 'docs/requirements/feature.yaml',
        acceptanceRef: harnessPath,
        dependsOn: ['implementation'],
      },
    ],
  };
}

function parentWorkflow(maxRounds: number): WorkflowDefinition {
  return {
    name: 'request-to-delivery',
    version: '0.2.0',
    description: '',
    steps: [
      { id: 'delivery_attempt', type: 'repair', repairRef: 'request-to-delivery-attempt', maxRounds },
      { id: 'delivery', type: 'delivery', prompt: 'Package the artifacts.', dependsOn: ['delivery_attempt'] },
    ],
  };
}

async function run(
  p: Project,
  maxRounds: number,
  sub: WorkflowDefinition,
  onAgent: (index: number) => void,
): Promise<{ status: string; prompts: string[]; steps: Map<string, { status: string; summary: string }>; loads: number }> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-repair-artifacts-'));
  const prompts: string[] = [];
  let index = 0;
  let loads = 0;
  try {
    const runtime = new TestRuntime((task) => {
      prompts.push(task.prompt ?? '');
      index += 1;
      onAgent(index);
      return 'implemented';
    });
    const res = await executeWorkflow(
      parentWorkflow(maxRounds),
      {
        cwd: p.dir,
        runtime,
        artifacts: new ArtifactStore(artifacts),
        onApproval: () => true,
        confirmedRequirement: { ref: 'docs/requirements/feature.yaml', digest: requirementDigest(p.docText) },
        loadWorkflow: async (ref: string) => {
          loads += 1;
          assert.equal(ref, 'request-to-delivery-attempt');
          return sub;
        },
      },
      { input: 'the request' },
    );
    return {
      status: res.status,
      prompts,
      steps: new Map(res.steps.map((s) => [s.stepId, { status: s.status, summary: s.summary }])),
      loads,
    };
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
}

test('a refused delivery is repaired against the judge\'s failing checks, and the document is NOT touched', async () => {
  const p = project();
  try {
    // The second attempt is the one that fixes it: the harness only passes once `fixed` exists.
    const res = await run(p, 2, attemptWorkflow(join(p.dir, 'harness.sh')), (n) => {
      if (n === 2) writeFileSync(join(p.dir, 'fixed'), 'repaired\n');
    });

    assert.equal(res.status, 'completed');
    // The sub-workflow is LOADED once and RUN per attempt: a reload per round would let the definition
    // change underneath a run that is already in flight.
    assert.equal(res.loads, 1, 'the sub-workflow definition is loaded once');
    assert.equal(res.prompts.length, 2, 'one implementation task per attempt');

    // The first attempt is told nothing is broken; the second is handed the exact failing check.
    assert.match(res.prompts[0] ?? '', /Attempt 1 of 2/);
    assert.ok(!(res.prompts[0] ?? '').includes('not ok'), 'the first attempt is not told about a failure that has not happened');
    assert.match(res.prompts[1] ?? '', /Attempt 2 of 2/);
    assert.match(res.prompts[1] ?? '', /not ok 1 - REL-001 additivity: department totals sum to 0 but the report says 428/);

    const attempt = res.steps.get('delivery_attempt');
    assert.equal(attempt?.status, 'completed');
    assert.match(attempt?.summary ?? '', /delivery accepted on attempt 2 of 2/);
    assert.equal(res.steps.get('delivery')?.status, 'completed');

    // The human's document must be byte-identical: a run that repairs itself spends no human attention.
    assert.equal(readFileSync(p.docPath, 'utf8'), p.docText, 'no feedback is written for a failure that was repaired');
  } finally {
    p.cleanup();
  }
});

test('a delivery that spends every attempt writes its failure back exactly once', async () => {
  const p = project();
  try {
    const res = await run(p, 2, attemptWorkflow(join(p.dir, 'harness.sh')), () => {
      /* never repaired */
    });

    assert.equal(res.status, 'failed');
    assert.equal(res.loads, 1, 'the sub-workflow definition is loaded once');
    assert.equal(res.prompts.length, 2);
    assert.match(res.prompts[1] ?? '', /not ok 1 - REL-001 additivity/, 'the second attempt is told what failed');

    const attempt = res.steps.get('delivery_attempt');
    assert.equal(attempt?.status, 'failed');
    assert.match(attempt?.summary ?? '', /delivery refused after 2 of 2 attempt\(s\): the last failure was written back/);
    assert.equal(res.steps.get('delivery')?.status, 'skipped', 'nothing is delivered by a refused run');

    const after = readFileSync(p.docPath, 'utf8');
    assert.notEqual(after, p.docText, 'the exhausted run writes its failure back');
    assert.equal(after.match(/id: FB-/g)?.length, 1, 'exactly one feedback entry, whatever the run spent');
    assert.match(after, /status: open/);
  } finally {
    p.cleanup();
  }
});

test('a repair step that cannot be run is refused, and says why', async () => {
  const p = project();
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-repair-artifacts-'));
  try {
    const res = await executeWorkflow(
      parentWorkflow(2),
      {
        cwd: p.dir,
        runtime: new TestRuntime(() => 'ok'),
        artifacts: new ArtifactStore(artifacts),
        onApproval: () => true,
        // A sub-workflow with nothing to judge it: the loop cannot know when to stop.
        loadWorkflow: async () => ({
          name: 'attempt',
          version: '0.1.0',
          description: '',
          steps: [{ id: 'implementation', type: 'agent', prompt: 'do it' }],
        }),
      },
      { input: 'x' },
    );
    assert.equal(res.status, 'failed');
    const attempt = res.steps.find((s) => s.stepId === 'delivery_attempt');
    assert.equal(attempt?.status, 'failed');
    assert.match(attempt?.summary ?? '', /declares no acceptance step: a repair loop with nothing to judge it cannot know when to stop/);
    assert.equal(res.steps.find((s) => s.stepId === 'delivery')?.status, 'skipped');
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
    p.cleanup();
  }
});

test('a repair manifest is refused at load when it cannot be bounded or has nothing to run', () => {
  const withRepair = (repairRef: string | undefined, maxRounds: unknown): WorkflowDefinition => ({
    name: 'refused',
    version: '0.1.0',
    description: '',
    steps: [
      {
        id: 'delivery_attempt',
        type: 'repair',
        ...(repairRef === undefined ? {} : { repairRef }),
        ...(maxRounds === undefined ? {} : { maxRounds: maxRounds as number }),
      },
    ],
  });

  const missingRef = validateWorkflowManifest(withRepair(undefined, 2));
  assert.match(missingRef.map((i) => i.message).join(' '), /requires a non-empty repairRef/);

  for (const rounds of [0, 6, 1.5]) {
    const issues = validateWorkflowManifest(withRepair('attempt', rounds));
    assert.match(
      issues.map((i) => i.message).join(' '),
      /maxRounds is .*: it must be an integer from 1 to 5/,
      `maxRounds ${rounds} must be refused`,
    );
  }
  assert.deepEqual(validateWorkflowManifest(withRepair('attempt', 3)), []);

  // The shipped pair still declares what this contract requires — a repair over the attempt chain, and
  // the attempt chain itself — so the feature cannot ship half-wired.
  assert.ok(existsSync(join(packageRoot(), 'extensions/workflows/request-to-delivery/workflow.yaml')));
  assert.ok(existsSync(join(packageRoot(), 'extensions/workflows/request-to-delivery-attempt/workflow.yaml')));
});

/** The repo root, from the test's own location (packages/core/dist/test → ../../../../). */
function packageRoot(): string {
  return join(new URL('../../../../', import.meta.url).pathname);
}
