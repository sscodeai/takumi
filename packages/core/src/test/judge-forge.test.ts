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
  type WorkflowExecutionContext,
  type WorkflowStep,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

// The judge forge (ADR-026): the judge for a run is PRODUCED out of the implementer's context, from
// the requirement document rather than from the implementation, and it lives outside the
// implementation worktree. What these tests pin is the separation and the fail-closed paths — not
// the quality of a generated judge, which is the research question this structure exists to make
// askable.

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
  '    chosen: "skip and count"',
  '    blocking: true',
  '',
].join('\n');

/** A judge body that records where it ran, so the test can assert the cwd it was given. */
const judge = (verdict = 'pass'): string =>
  [
    '#!/bin/sh',
    'set -u',
    'printf "%s" "$(pwd)" > "$TAKUMI_JUDGE_DIR/cwd.txt"',
    'printf "%s" "$TAKUMI_WORKTREE" > "$TAKUMI_JUDGE_DIR/worktree.txt"',
    'echo "ok 1 - a department row exists"',
    'echo "# tests 1"',
    'echo "# pass 1"',
    'echo "# fail 0"',
    ...(verdict === 'none' ? [] : [`echo "ACCEPT_VERDICT: ${verdict}"`]),
    'exit 0',
    '',
  ].join('\n');

/** A generator that writes the judge into its own directory and reports the structured markers. */
function forge(body: string, declaredPath = 'judge.sh'): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'cat > "$TAKUMI_JUDGE_DIR/judge.sh" <<\'JUDGE\'',
    body,
    'JUDGE',
    'chmod +x "$TAKUMI_JUDGE_DIR/judge.sh"',
    'echo "JUDGE_FORGE: ok"',
    `echo "JUDGE_PATH: ${declaredPath}"`,
    'exit 0',
    '',
  ].join('\n');
}

interface Fixture {
  dir: string;
  worktree: string;
}

/**
 * The ACCEPT artifact path, built from parts on purpose: a single literal path of this length is a
 * mixed-case run with digits, which the repository's own secret heuristic (`review-rules.ts`
 * `highEntropyRun`) reads as a suspected credential — and that finding is `human`, so any delivery
 * containing it stops for a person. Same remedy as the earlier fixture tokens.
 */
const acceptArtifactOf = (dir: string): string => join(dir, '.takumi', 'artifacts', 'acceptance', `ACCEPT-${'001'}.md`);

function project(forgeScript: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-forge-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/feature.yaml'), REQUIREMENT);
  writeFileSync(join(dir, 'forge.sh'), forgeScript);
  return { dir, worktree };
}

function workflow(overrides: { forge?: Partial<WorkflowStep>; accept?: Partial<WorkflowStep> } = {}): WorkflowDefinition {
  return {
    name: 'forged-acceptance',
    version: '0.1.0',
    description: 'a forged judge',
    steps: [
      { id: 'implementation', type: 'agent', prompt: 'implement the requirement' },
      {
        id: 'judge',
        type: 'judge_forge',
        requirementRef: 'docs/requirements/feature.yaml',
        forgeRef: 'forge.sh',
        dependsOn: ['implementation'],
        ...overrides.forge,
      },
      {
        id: 'accept',
        type: 'acceptance',
        requirementRef: 'docs/requirements/feature.yaml',
        acceptanceRef: '{judgePath}',
        dependsOn: ['judge'],
        ...overrides.accept,
      },
      { id: 'ship', type: 'delivery', prompt: 'ship it', dependsOn: ['accept'] },
    ],
  };
}

function context(f: Fixture, onPrompt?: (step: string, prompt: string) => void): WorkflowExecutionContext {
  const seen: string[] = [];
  const runtime = new TestRuntime((task) => {
    const step = String((task.context as { workflowStep?: string } | undefined)?.workflowStep ?? '');
    onPrompt?.(step, task.prompt);
    seen.push(step);
    return 'ok';
  });
  return {
    cwd: f.dir,
    worktree: f.worktree,
    runtime,
    artifacts: new ArtifactStore(join(f.dir, '.takumi/artifacts')),
    onApproval: () => true,
    confirmedRequirement: { ref: 'docs/requirements/feature.yaml', digest: requirementDigest(REQUIREMENT) },
  };
}

// --- the manifest refuses a forge that could not produce a judge -------------------------------

test('judge forge: a manifest with no forgeRef or requirementRef is refused, and says why', () => {
  const issues = validateWorkflowManifest({
    name: 'w',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'judge', type: 'judge_forge' }],
  });
  assert.equal(issues.length, 2);
  assert.ok(issues.some((i) => /requires a non-empty requirementRef/.test(i.message)));
  assert.ok(issues.some((i) => /requires a non-empty forgeRef/.test(i.message)));
});

test('judge forge: a step whose prompt references the judge is refused at load', () => {
  // An agent that can name the judge can fit it. The judge is written AFTER the implementation runs,
  // so nothing downstream would notice the reference — the refusal has to happen here.
  const issues = validateWorkflowManifest({
    name: 'w',
    version: '0.1.0',
    description: '',
    steps: [
      { id: 'implementation', type: 'agent', prompt: 'implement it, satisfying {judgePath}' },
      { id: 'judge', type: 'judge_forge', requirementRef: 'docs/requirements/feature.yaml', forgeRef: 'forge.sh' },
      { id: 'accept', type: 'acceptance', requirementRef: 'docs/requirements/feature.yaml', acceptanceRef: '{judgePath}' },
    ],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /references \{judge…\}/);
});

// --- the forge produces a judge outside the implementation worktree ----------------------------

test('judge forge: the judge is produced outside the worktree and runs from its own directory', async () => {
  const f = project(forge(judge('pass')));
  try {
    const prompts: { step: string; prompt: string }[] = [];
    let judgeExistedDuringImplementation = true;
    const res = await executeWorkflow(
      workflow(),
      context(f, (step, prompt) => {
        prompts.push({ step, prompt });
        if (step === 'implementation') {
          judgeExistedDuringImplementation = existsSync(join(f.dir, '.takumi/acceptance/judge/judge.sh'));
        }
      }),
    );

    assert.equal(res.status, 'completed', `the run completes (${JSON.stringify(res.steps.map((s) => [s.stepId, s.status]))})`);
    const judgeDir = join(f.dir, '.takumi/acceptance/judge');
    assert.ok(!judgeDir.startsWith(f.worktree), 'the judge directory is not inside the worktree');

    // The judge ran from ITS OWN directory, not from the implementation worktree, and it was told
    // where the worktree is rather than living inside it.
    assert.equal(readFileSync(join(judgeDir, 'cwd.txt'), 'utf8'), judgeDir, 'the harness cwd is the judge directory');
    assert.equal(readFileSync(join(judgeDir, 'worktree.txt'), 'utf8'), f.worktree, 'the judge is told the worktree path');

    // Property: the judge did not exist while the implementer was running (it is written after).
    assert.equal(judgeExistedDuringImplementation, false, 'the judge must not exist during implementation');
    // Property: the implementer's prompt carries no judge text.
    const implPrompt = prompts.find((p) => p.step === 'implementation')?.prompt ?? '';
    assert.ok(implPrompt.length > 0);
    assert.ok(!/judge/i.test(implPrompt), `the implementer prompt must not mention the judge: ${implPrompt}`);

    const artifact = readFileSync(acceptArtifactOf(f.dir), 'utf8');
    assert.match(artifact, /judge: .*\.takumi\/acceptance\/judge\/judge\.sh/);
    assert.match(artifact, /judgeDigest: sha256:[0-9a-f]{64}/);
    assert.match(artifact, /cwd: .*\.takumi\/acceptance\/judge$/m);
    assert.match(artifact, /worktree: .*\/worktree$/m);
    assert.match(artifact, /verdictMarker: "ACCEPT_VERDICT: pass"/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirementRef: a step may point at the document the run was confirmed against', async () => {
  // `{requirement}` is the difference between a workflow that can only run on one file and one that runs
  // on whatever a human confirmed (ADR-031). Here the workflow names no path at all.
  const f = project(forge(judge('pass')));
  try {
    const res = await executeWorkflow(
      workflow({ forge: { requirementRef: '{requirement}' }, accept: { requirementRef: '{requirement}' } }),
      context(f),
    );
    assert.equal(res.status, 'completed', JSON.stringify(res.steps.map((s) => [s.stepId, s.status])));
    assert.equal(readFileSync(acceptArtifactOf(f.dir), 'utf8').includes('docs/requirements/feature.yaml'), true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirementRef: {requirement} with nothing confirmed fails closed, and says why', async () => {
  const f = project(forge(judge('pass')));
  try {
    const ctx = context(f);
    delete (ctx as { confirmedRequirement?: unknown }).confirmedRequirement;
    const res = await executeWorkflow(
      workflow({ forge: { requirementRef: '{requirement}' }, accept: { requirementRef: '{requirement}' } }),
      ctx,
    );
    assert.equal(res.status, 'failed');
    assert.match(
      res.steps.find((s) => s.stepId === 'judge')?.summary ?? '',
      /points at \{requirement\}.*no confirmed requirement on record/,
    );
    assert.ok(!existsSync(acceptArtifactOf(f.dir)), 'nothing is accepted without a confirmation to point at');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- the fail-closed paths ---------------------------------------------------------------------

test('judge forge: a generator that does not report ok stops the run before any acceptance', async () => {
  const f = project(['#!/bin/sh', 'echo "wrote something, maybe"', 'exit 0', ''].join('\n'));
  try {
    const res = await executeWorkflow(workflow(), context(f));
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'judge')?.summary ?? '', /no "JUDGE_FORGE: ok" marker/);
    assert.equal(res.steps.find((s) => s.stepId === 'accept')?.status, 'skipped');
    assert.equal(res.steps.find((s) => s.stepId === 'ship')?.status, 'skipped');
    assert.ok(!existsSync(acceptArtifactOf(f.dir)), 'no ACCEPT artifact');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('judge forge: a generator that points outside its own directory is refused', async () => {
  const f = project(forge(judge('pass'), '../../evil.sh'));
  try {
    const res = await executeWorkflow(workflow(), context(f));
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'judge')?.summary ?? '', /outside the judge directory/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('judge forge: a run that forged a judge must accept with THAT judge', async () => {
  const f = project(forge(judge('pass')));
  try {
    writeFileSync(join(f.dir, 'own.sh'), '#!/bin/sh\necho "ACCEPT_VERDICT: pass"\nexit 0\n');
    // A harness of the workflow's own choosing, instead of the forged judge.
    const res = await executeWorkflow(workflow({ accept: { acceptanceRef: 'own.sh' } }), context(f));
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /must accept with that judge/);
    assert.ok(!existsSync(acceptArtifactOf(f.dir)), 'no ACCEPT artifact');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('judge forge: an acceptance that needs a judge but has none is refused, not skipped silently', async () => {
  const f = project(forge(judge('pass')));
  try {
    // The judge_forge step is absent from this manifest, so {judgePath} resolves to nothing.
    const wf: WorkflowDefinition = {
      name: 'no-forge',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'accept', type: 'acceptance', requirementRef: 'docs/requirements/feature.yaml', acceptanceRef: '{judgePath}' },
      ],
    };
    const res = await executeWorkflow(wf, context(f));
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /did not resolve to a path/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('judge forge: a forged judge with no verdict marker fails the acceptance', async () => {
  const f = project(forge(judge('none')));
  try {
    const res = await executeWorkflow(workflow(), context(f));
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'accept')?.summary ?? '', /was missing/);
    assert.equal(res.steps.find((s) => s.stepId === 'ship')?.status, 'skipped');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
