/**
 * A STEP THAT DECLARES AN OUTPUT MUST PRODUCE IT.
 *
 * Found on a real machine (2026-10-11 17:56Z, run wf-5beb034f): `request-intake` ran unattended in 74
 * seconds and reported success — `req_intake` done, `intake_shape` PASSED 4/4, `ambiguity_confirmation`
 * approved — while the agent had produced NOTHING. The document the shape gate read
 * (docs/requirements/intake.yaml, 11553 bytes) was a COMMITTED file from an earlier session, written
 * six hours before the run. It was even about the same subject (station temperatures), because the
 * earlier request had been similar, so the gate's output read as plausible: `ok 1 - the intake wrote
 * docs/requirements/intake.yaml`.
 *
 * Nothing in the chain asked "was this written by THIS run?", so a run that produced nothing was
 * indistinguishable from a run that produced the document — and the approval step that follows would
 * have had a human confirm a document that predates their own request.
 *
 * Why the runtime was silent is a separate, also-real defect: the pi turn ended with stopReason
 * "length" (output 8192 tokens, reasoning 8192) — the model spent its entire output budget on
 * reasoning and never emitted an answer, and the adapter reported that as a finished turn. But the
 * engine's blindness is the one fixed here, because it is the one that lets ANY silent runtime pass:
 * an agent step whose result is empty is recorded as `completed`, and every check downstream then
 * reads whatever happens to be on disk.
 *
 * The rule pinned here: a step that declares `produces: [path]` fails unless that path was written
 * DURING the step. A file that was already there is not this step's output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ArtifactStore, createGitRunner, executeWorkflow, validateWorkflowManifest } from '../index.js';
import type { WorkflowDefinition } from '../workflow.js';
import { TestRuntime } from '../test-utils.js';

const DOC = 'docs/requirements/intake.yaml';

/** A runtime that does exactly what its callback says — including nothing at all. */
function runtimeDoing(work: (cwd: string) => void): TestRuntime {
  return new TestRuntime((task) => {
    work(task.cwd ?? '');
    return 'agent turn finished';
  });
}

function intakeWorkflow(): WorkflowDefinition {
  return {
    name: 'intake-produces',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'req_intake', type: 'agent', prompt: 'write the document', produces: [DOC] }],
  };
}

async function run(dir: string, runtime: TestRuntime, artifacts: string) {
  return executeWorkflow(intakeWorkflow(), {
    cwd: dir,
    runtime,
    artifacts: new ArtifactStore(artifacts),
    git: createGitRunner(),
    onApproval: () => true,
  });
}

function dirs(): { dir: string; artifacts: string } {
  return {
    dir: mkdtempSync(join(tmpdir(), 'takumi-produces-')),
    artifacts: mkdtempSync(join(tmpdir(), 'takumi-produces-artifacts-')),
  };
}

// ---------------------------------------------------------------------------------------------
// (a) the observed failure: the file was already there, and the runtime did not write it
// ---------------------------------------------------------------------------------------------

test('a declared output that the step did not write FAILS the step, even though the file exists', async () => {
  const { dir, artifacts } = dirs();
  try {
    // The document a previous session left behind — valid, on disk, and NOT this run's work.
    mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
    writeFileSync(join(dir, DOC), 'requirements:\n  - id: REQ-001\n');
    // Make it unmistakably older than the run, as the real one was (six hours).
    const old = new Date(Date.now() - 6 * 3600 * 1000);
    utimesSync(join(dir, DOC), old, old);

    // The runtime produces nothing at all — the observed silent agent turn.
    const res = await run(dir, runtimeDoing(() => {}), artifacts);

    assert.equal(res.status, 'failed', 'a step that produced nothing is not a completed step');
    const step = res.steps.find((s) => s.stepId === 'req_intake');
    assert.equal(step?.status, 'failed');
    assert.match(
      step?.summary ?? '',
      /docs\/requirements\/intake\.yaml/,
      'the refusal names the path that was not produced',
    );
    assert.match(
      step?.summary ?? '',
      /was not written during this step/,
      'the refusal says the file was not written during THIS step',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

test('a declared output that does not exist at all also FAILS the step', async () => {
  const { dir, artifacts } = dirs();
  try {
    const res = await run(dir, runtimeDoing(() => {}), artifacts);
    assert.equal(res.status, 'failed');
    assert.match(res.steps.find((s) => s.stepId === 'req_intake')?.summary ?? '', /was not written during this step/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// (b) no false red: a runtime that writes the document is a completed step
// ---------------------------------------------------------------------------------------------

test('a declared output the step DID write is a completed step', async () => {
  const { dir, artifacts } = dirs();
  try {
    const res = await run(
      dir,
      runtimeDoing((cwd) => {
        mkdirSync(join(cwd, dirname(DOC)), { recursive: true });
        writeFileSync(join(cwd, DOC), 'requirements:\n  - id: REQ-001\n    title: from this run\n');
      }),
      artifacts,
    );
    assert.equal(res.status, 'completed');
    assert.equal(res.steps.find((s) => s.stepId === 'req_intake')?.status, 'completed');
    assert.match(readFileSync(join(dir, DOC), 'utf8'), /from this run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// (c) the real manifest: the intake's agent step declares the document it must produce
// ---------------------------------------------------------------------------------------------

test('the REAL intake manifests declare the document its agent step must produce, and a repair round around it', () => {
  // The intake is a `repair` round over its own sub-workflow (ADR-057): the agent that writes the
  // document and the gate that reads it live together in `intake-attempt`, so a document the gate refuses
  // gets a SECOND attempt told exactly what was refused, instead of the run being thrown away (measured
  // 2026-10-12: three of four unattended chains lost the whole run at the gate for three different reasons
  // — docs/bugs-fixed.md #69, #70).
  const parent = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/request-intake/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  assert.deepEqual(validateWorkflowManifest(parent), [], 'the shipped manifest passes its own validator');

  const attempt = (parent.steps ?? []).find((s) => s.id === 'intake_attempt');
  assert.equal(attempt?.type, 'repair', 'the intake runs one repairable attempt, not a bare agent step');
  assert.equal(attempt?.repairRef, 'intake-attempt');
  assert.equal(attempt?.maxRounds, 2, 'a bad sample is repaired once rather than losing the run');
  const confirmation = (parent.steps ?? []).find((s) => s.id === 'ambiguity_confirmation');
  assert.ok(
    (confirmation?.dependsOn ?? []).includes('intake_attempt'),
    'the confirmation happens after the attempt that owns the gate, not after a bare agent step',
  );

  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  assert.deepEqual(validateWorkflowManifest(def), [], 'the attempt manifest passes its own validator');

  // The step that WRITES the document is the one this test is about, not simply the first agent: with
  // the shape decision split out (ledger #102) the attempt has two agent steps, and only `req_intake`
  // produces the file. Finding by type alone would assert against the decision step and demand a
  // `produces` the decision has no business declaring.
  const agent = (def.steps ?? []).find((s) => (s.produces ?? []).includes('docs/requirements/intake.yaml'));
  assert.ok(agent, 'the attempt has an agent step that declares producing the document');
  assert.deepEqual(
    agent?.produces,
    ['docs/requirements/intake.yaml'],
    'the agent step declares the document it must write, so an intake that writes nothing is refused instead of graded on a file it did not produce',
  );
  assert.equal(agent?.timeoutMs, 900_000, 'the bound per attempt stays where it is: 15 minutes');
  assert.match(
    String(agent?.prompt ?? ''),
    /\{repairFailures\}/,
    'the next attempt is handed the failing checks the gate reported — the whole point of the repair round',
  );
  // LEDGER #102: the shape decision is its OWN step, ahead of the document, and it is BINDING on it.
  const shape = (def.steps ?? []).find((s) => s.id === 'shape_decision');
  assert.ok(shape, 'the shape decision is a step of its own');
  assert.equal(shape?.skillAction, 'shape', 'and it uses the SHORT prompt, not the 400-line document prompt');
  // A `skillAction` THE SKILL'S MANIFEST DOES NOT MAP IS SILENTLY IGNORED — `skillPromptFor` falls back
  // to the workflow's own prompt text, so the step ran the bare `{input}` template and the agent answered
  // with its default behaviour (measured 2026-10-27: it offered open-source discovery instead of deciding
  // the shape). The mapping is the load-bearing part, so it is asserted here rather than assumed.
  const manifest = parseYaml(
    readFileSync(new URL('../../../../extensions/skills/req-intake/manifest.yaml', import.meta.url), 'utf8'),
  ) as { prompts?: Record<string, string> };
  assert.equal(
    manifest.prompts?.['shape'],
    'prompts/shape.md',
    'the skill manifest maps the `shape` action, or the step silently loses its prompt',
  );
  for (const action of ['intake', 'shape', 'confirm', 'revise']) {
    const rel = manifest.prompts?.[action];
    assert.ok(rel, `the manifest maps \`${action}\``);
    assert.ok(
      existsSync(new URL(`../../../../extensions/skills/req-intake/${rel}`, import.meta.url)),
      `the file \`${rel}\` that \`${action}\` maps to exists`,
    );
  }
  assert.ok(
    (agent?.dependsOn ?? []).includes('shape_decision'),
    'the document step waits for the decision',
  );
  assert.match(
    String(agent?.prompt ?? ''),
    /\{step\.shape_decision\}/,
    'and the decision reaches that step through the engine\'s per-step vars, or the split decides nothing',
  );
  // LEDGER #107: `deliverable.run` went missing THREE times (2026-10-29). The rule was in the 400-line
  // document prompt already and was ignored there, so the entry point is now decided in the SHORT step
  // and the document step is told to copy it verbatim. Both halves are load-bearing: a short prompt
  // that never emits ENTRY_POINT decides nothing, and a document prompt that is not told to copy it
  // goes on ignoring the rule it already had.
  const shapePrompt = readFileSync(
    new URL('../../../../extensions/skills/req-intake/prompts/shape.md', import.meta.url),
    'utf8',
  );
  assert.match(shapePrompt, /^ENTRY_POINT: /m, 'the short step emits the entry point');
  assert.match(
    shapePrompt,
    /\{csv\}/,
    'and keeps the literal {csv} the judge replaces with a fixture path',
  );
  assert.match(
    String(agent?.prompt ?? ''),
    /ENTRY_POINT/,
    'the document step is told that line exists',
  );
  assert.match(
    String(agent?.prompt ?? ''),
    /deliverable\.run/,
    'and told what to do with it',
  );

  // The gate that reads the document must depend on the step that produces it, or the declaration
  // is checked after something has already read the stale file.
  const gate = (def.steps ?? []).find((s) => s.type === 'quality_gate');
  // LEDGER #129: the gate depends on `intake_repair`, which depends on the agent. The gate still judges
  // the DOCUMENT THE AGENT WROTE — the repair only fills in what step 1 had already decided — so the
  // chain is asserted link by link rather than collapsed into one edge.
  assert.ok(
    (gate?.dependsOn ?? []).includes('intake_repair'),
    'the shape gate depends on the repair step',
  );
  const repair = (def.steps ?? []).find((s) => s.id === 'intake_repair');
  assert.ok(
    (repair?.dependsOn ?? []).includes(agent?.id ?? ''),
    'and the repair acts on the document the agent wrote',
  );
});

// ---------------------------------------------------------------------------------------------
// (d) the declaration is only honoured where it is executed — elsewhere it is refused by name
// ---------------------------------------------------------------------------------------------

test('a manifest declaring produces on a step type whose output is NOT checked is refused by name', () => {
  const def: WorkflowDefinition = {
    name: 'produces-on-a-gate',
    version: '0.1.0',
    description: '',
    steps: [{ id: 'shape', type: 'quality_gate', prompt: 'npm test', produces: [DOC] }],
  };
  const issues = validateWorkflowManifest(def);
  const refusal = issues.find((i) => /produces/.test(i.message));
  assert.ok(refusal, `expected a refusal naming produces, got: ${JSON.stringify(issues)}`);
  assert.equal(refusal?.stepId, 'shape');
  assert.match(
    refusal?.message ?? '',
    /only an agent step/,
    'the refusal says where a declared output is actually checked',
  );
});

// LEDGER #121: the SHAPE step also decides which relations are POSSIBLE, because the same model kept
// picking an aggregate relation for a ratio answer — five separate runs, the last on 2026-11-04
// declaring `independent-aggregation` on a ratio line and losing the run before any code was written.
//
// The list is derivable from the fields, so it is decided in the 60-line step and handed to the
// 400-line document step as a constraint, instead of being rediscovered (wrongly) inside it.
test('the shape step declares the relations each field model allows', () => {
  const shapePrompt = readFileSync(
    new URL('../../../../extensions/skills/req-intake/prompts/shape.md', import.meta.url),
    'utf8',
  );
  assert.match(shapePrompt, /^ALLOWED_RELATIONS: /m, 'the step emits the list');

  // QUOTIENT: only the relations that read no aggregate roles.
  const quotient = shapePrompt.match(/ALLOWED_RELATIONS: ([^\n]+)/g) ?? [];
  assert.ok(quotient.length >= 2, 'one list per shape');
  const ratioList = quotient[0] ?? '';
  assert.match(ratioList, /derived-ratio/, 'a ratio document can always declare derived-ratio');
  assert.match(ratioList, /row-order-invariance/, 'and row-order, which needs no fields (#110)');
  for (const forbidden of ['independent-aggregation', 'additivity', 'duplicate-resolution', 'malformed-row-accounting']) {
    assert.doesNotMatch(
      ratioList,
      new RegExp(forbidden),
      `${forbidden} recomputes counts and cannot check a ratio line`,
    );
  }

  // AGGREGATE: all seven, since the aggregate model has the roles they read.
  const aggList = quotient[1] ?? '';
  for (const kind of [
    'independent-aggregation',
    'additivity',
    'duplicate-resolution',
    'malformed-row-accounting',
    'row-order-invariance',
    'mutation-detection',
    'browser-scenario',
  ]) {
    assert.match(aggList, new RegExp(kind), `an aggregate document can declare ${kind}`);
  }
});

test('the document step is told the list is a CONSTRAINT, not a suggestion', () => {
  const def = parseYaml(readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8')) as WorkflowDefinition;
  const doc = (def.steps ?? []).find((s) => (s.produces ?? []).includes('docs/requirements/intake.yaml'));
  const prompt = String(doc?.prompt ?? '');
  assert.match(prompt, /ALLOWED_RELATIONS/, 'it names the line');
  assert.match(prompt, /SUBSET/, 'and calls it a subset constraint');
  assert.match(prompt, /may not use any other|REFUSED/, 'with the consequence stated');
});

// LEDGER #127: the shape step also decides what the ROUNDING answer MEANS.
//
// Measured 2026-11-08 on a real run: a ratio document settled its rounding decision but wrote no
// `checkedAs`, so the forge refused the whole document —
//   the decision AMB-001 is settled by REL-001, and the relation needs to know what its answer MEANS:
//   give it "checkedAs: <half-up truncate>"
// — and the run was lost before a line of code was written. The rule is #12 of the 400-line document
// prompt and was ignored there, which is the same thing that happened to the field model (#102), the
// entry point (#107) and the relation list (#121). So it is decided in the 60-line step instead.
test('the shape step decides the rounding mode, with the default spelled out', () => {
  const prompt = readFileSync(
    new URL('../../../../extensions/skills/req-intake/prompts/shape.md', import.meta.url),
    'utf8',
  );
  assert.match(prompt, /^ROUNDING_MEANS: /m, 'the step emits the line');
  assert.match(prompt, /`half-up` — a value exactly halfway rounds away from zero/, 'half-up is defined');
  assert.match(prompt, /`truncate` — everything after the last printed digit is dropped/, 'truncate is defined');
  assert.match(
    prompt,
    /without qualifying it, answer `half-up`/,
    'the unqualified case is decided for the model rather than left to taste',
  );
  assert.match(prompt, /NONE/, 'a shape with nothing rounded says so');
});

test('the document step is told `checkedAs` must carry that word, on the DECISION', () => {
  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  const doc = (def.steps ?? []).find((s) => (s.produces ?? []).includes('docs/requirements/intake.yaml'));
  const prompt = String(doc?.prompt ?? '');
  assert.match(prompt, /ROUNDING_MEANS/, 'it names the line');
  assert.match(prompt, /checkedAs/, 'and the field it fills');
  assert.match(
    prompt,
    /ON THE AMB-nnn ENTRY next to `chosen:`, never on the relation/i,
    'with the placement the forge actually enforces',
  );
});

// LEDGER #139 — the shape step must also say which decisions NOT to write.
//
// Measured 2026-11-09: a ratio document narrowed its relations correctly to the four that can read a
// ratio line, and THEN recorded blocking decisions "what happens to a malformed row" (checkedAs:
// skip-count) and "what happens to a repeated id" (checkedAs: merge) — decisions only
// `malformed-row-accounting` and `duplicate-resolution` can verify, and those cannot read a ratio line.
// The forge refused with "blocking decision(s) AMB-001, AMB-002 are exercised by no declared relation".
//
// A list of what IS allowed is not enough: the model still writes the decision the request implies. The
// prompt has to say what to do with that impulse instead.
test('the shape step forbids on a QUOTIENT answer the decisions its relations cannot check', () => {
  const prompt = readFileSync(
    new URL('../../../../extensions/skills/req-intake/prompts/shape.md', import.meta.url),
    'utf8',
  );
  assert.match(prompt, /DO NOT WRITE THOSE DECISIONS AT ALL/, 'the half that was missing');
  assert.match(prompt, /skip-count/, 'it names the malformed-row decision');
  assert.match(prompt, /merge/, 'and the duplicate one');
  assert.match(
    prompt,
    /State the behaviour in the REQUIREMENT text instead/,
    'and says where the behaviour goes instead of into an unverifiable decision',
  );
  assert.match(
    prompt,
    /A decision\s+nothing can check is worse than no decision/,
    'with the reason a reader can act on',
  );
});
