import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  JUDGE_DECISION_MODES,
  JUDGE_RELATION_VOCABULARY,
  JUDGE_RELATIONS_THAT_NEED_THE_WORLD,
  parseDecisionBindings,
  parseRequirements,
  validateRequirementDocument,
} from '../index.js';

// The relation vocabulary (ADR-031) exists in two languages: the validator that refuses a document
// naming something no judge can check, and the shell forge that implements the checks. A drift between
// them is a document that passes the front door and is refused at the acceptance, after the
// implementation has been paid for — so the drift is a test failure instead.

const repo = new URL('../../../../', import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, repo), 'utf8');

/** Every `docs/requirements/*.yaml` in the repository, with its file name. */
function committedDocuments(): { file: string; text: string }[] {
  const dir = new URL('../../../../docs/requirements/', import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, text: readFileSync(new URL(file, dir), 'utf8') }));
}

/** The `checkedAs` a relation or differential anchor carries, which nothing reads. */
function relationCheckedAs(text: string): { id: string; checkedAs: string }[] {
  const parsed = parseYaml(text) as { deliverable?: { relations?: unknown; differential?: unknown } } | null;
  const deliverable = parsed?.deliverable;
  const found: { id: string; checkedAs: string }[] = [];
  for (const list of [deliverable?.relations, deliverable?.differential]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry['checkedAs'] !== 'string') continue;
      found.push({ id: typeof entry['id'] === 'string' ? entry['id'] : '(unnamed)', checkedAs: entry['checkedAs'] });
    }
  }
  return found;
}

test('vocabulary: the forge implements exactly the relations the validator accepts', () => {
  const forge = read('extensions/judges/metamorphic-forge.sh');
  const line = /^IMPLEMENTED="([^"]*)"/m.exec(forge);
  assert.ok(line !== null, 'the forge declares its implemented relations on one IMPLEMENTED= line');
  const implemented = (line[1] ?? '').trim().split(/\s+/).filter((r) => r.length > 0).sort();
  assert.deepEqual([...JUDGE_RELATION_VOCABULARY].sort(), implemented);
});

test('vocabulary: the forge implements exactly the decision modes the validator accepts', () => {
  const forge = read('extensions/judges/metamorphic-forge.sh');
  const modesOf = (name: string): string[] => {
    const line = new RegExp(`^${name}="([^"]*)"`, 'm').exec(forge);
    assert.ok(line !== null, `the forge declares ${name} on one line`);
    return (line[1] ?? '').trim().split(/\s+/).filter((m) => m.length > 0).sort();
  };
  assert.deepEqual(modesOf('DUPLICATE_MODES'), [...JUDGE_DECISION_MODES['duplicate-resolution'] ?? []].sort());
  assert.deepEqual(modesOf('MALFORMED_MODES'), [...JUDGE_DECISION_MODES['malformed-row-accounting'] ?? []].sort());
  assert.deepEqual(modesOf('ROUNDING_MODES'), [...JUDGE_DECISION_MODES['independent-aggregation'] ?? []].sort());
});

test('vocabulary: the intake prompt offers exactly the relations the validator accepts', () => {
  const prompt = read('extensions/skills/req-intake/prompts/intake.md');
  for (const relation of JUDGE_RELATION_VOCABULARY) {
    assert.ok(prompt.includes(`\`${relation}\``), `the intake prompt must name ${relation} as implemented`);
  }
  // And it must not offer anything else: the fenced list in the prompt is read as the whole vocabulary.
  const offered = [...prompt.matchAll(/^\s+-\s+`([a-z-]+)`\s{2,}/gm)].map((m) => m[1] ?? '');
  assert.deepEqual(offered.sort(), [...JUDGE_RELATION_VOCABULARY].sort());
});

// The world requirement exists in the same two languages, and drifted the same way (ledger #85): the
// forge learned that a scenario needs no declared world (#83, #84) while the front door went on demanding
// one, so documents the forge could implement were refused before it ever saw them. Measured 2026-10-13:
// round 10's three runs died at the front door, in 2.5 minutes each, with "declares no input_format".

test('vocabulary: the relations that need the declared world are one list in the validator and the forge', () => {
  const forge = read('extensions/judges/metamorphic-forge.sh');
  const line = /WORLD_NEEDED=1 ;;/.exec(forge);
  assert.ok(line !== null, 'the forge marks its world-consuming relations on one WORLD_NEEDED line');
  const worldLine = forge.split('\n').find((l) => l.includes('WORLD_NEEDED=1 ;;')) ?? '';
  const fromForge = [...worldLine.matchAll(/"\s+([a-z-]+)\s+"/g)].map((m) => m[1] ?? '').sort();
  assert.deepEqual(fromForge, [...JUDGE_RELATIONS_THAT_NEED_THE_WORLD].sort());
});

test('vocabulary: a document whose checks need no declared world passes the front door (ledger #85)', () => {
  // One scenario, no input_format, no output_format: a scenario needs neither, and the forge writes a
  // judge for it (see judge-forge-decisions.test.ts, which RUNS that judge). The front door must agree.
  const text = read('packages/core/src/test/fixtures/graph-requirement-with-scenario-no-world.yaml');
  const issues = validateRequirementDocument(text);
  assert.deepEqual(issues, [], `a world-free document must pass the front door: ${issues.join('; ')}`);
});

// The `checkedAs` placement defect (ADR-045 §7). `checkedAs` is read from the `AMB-nnn` ENTRY, beside
// `chosen` (`parseRequirements`) and looked for there by the validator and by the forge's own line-wise
// parse. A `checkedAs` on a relation or an anchor is invisible to all three: it is a second place for one
// fact, and a generated document that puts it there is refused at the front door until a human moves the
// line — which is exactly the interactive moment intake automation exists to remove. These tests are the
// fix's teeth: the prompt's own worked example has to BE a document the front door accepts, and the
// repository's committed documents may not keep the habit either.

test('vocabulary: the intake prompt\'s worked example is a document the front door accepts', () => {
  const prompt = read('extensions/skills/req-intake/prompts/intake.md');
  const fence = /```yaml\r?\n([\s\S]*?)```/.exec(prompt);
  assert.ok(fence !== null, 'the intake prompt carries one fenced YAML example');
  const example = fence[1] ?? '';
  const issues = validateRequirementDocument(example);
  assert.deepEqual(issues, [], `the prompt's own example must pass the front door: ${issues.join('; ')}`);
});

test('vocabulary: the prompt puts checkedAs on the DECISION, and never on a relation', () => {
  const prompt = read('extensions/skills/req-intake/prompts/intake.md');
  const example = /```yaml\r?\n([\s\S]*?)```/.exec(prompt)?.[1] ?? '';
  const decisions = parseRequirements(example);
  assert.ok(decisions.length > 0, 'the example records decisions');

  // Every decision a mode-carrying relation settles says what its answer MEANS, and says it on the
  // AMB entry — the only place it is read.
  const modeRelations = new Set(Object.keys(JUDGE_DECISION_MODES));
  let settled = 0;
  for (const binding of parseDecisionBindings(example)) {
    if (!modeRelations.has(binding.relation) || binding.decides === undefined) continue;
    const decision = decisions.find((d) => d.id === binding.decides);
    assert.ok(decision, `${binding.checkId} settles ${binding.decides}, which the example must record`);
    assert.ok(
      decision.checkedAs !== undefined,
      `${decision.id} must carry checkedAs: it is read from the AMB entry, not from ${binding.checkId}`,
    );
    assert.ok(
      (JUDGE_DECISION_MODES[binding.relation] ?? []).includes(decision.checkedAs),
      `${decision.id} says checkedAs: "${decision.checkedAs}", which ${binding.relation} cannot act on`,
    );
    settled += 1;
  }
  assert.ok(settled >= 2, 'the example must show at least two decisions whose mode a judge reads');

  // And the relation node does not repeat it.
  assert.deepEqual(relationCheckedAs(example), [], 'the mode belongs on the decision, not on the relation');
});

test('vocabulary: no committed requirement document carries checkedAs on a relation or anchor', () => {
  const documents = committedDocuments();
  assert.ok(documents.length > 0, 'there are committed requirement documents to check');
  for (const document of documents) {
    assert.deepEqual(
      relationCheckedAs(document.text),
      [],
      `${document.file} carries checkedAs on a relation: it is read from the AMB entry, and two places for one fact drift (ADR-031)`,
    );
  }
});

test('vocabulary: every committed requirement document says checkedAs where it is read', () => {
  for (const document of committedDocuments()) {
    const decisions = parseRequirements(document.text);
    const modeRelations = new Set(Object.keys(JUDGE_DECISION_MODES));
    for (const binding of parseDecisionBindings(document.text)) {
      if (!modeRelations.has(binding.relation) || binding.decides === undefined) continue;
      const decision = decisions.find((d) => d.id === binding.decides);
      assert.ok(decision, `${document.file}: ${binding.checkId} settles ${binding.decides}, which the document must record`);
      assert.ok(
        decision.checkedAs !== undefined,
        `${document.file}: ${decision.id} must carry checkedAs (settled by ${binding.checkId})`,
      );
    }
  }
});

// LEDGER #99: THE PROMPT MUST SAY THAT THE TWO FIELD MODELS ARE ALTERNATIVES, NOT A MENU.
//
// The judge checks EVERY relation a document declares. So a document that declares a record-aggregate
// relation (`malformed-row-accounting`, `duplicate-resolution`) AND `derived-ratio` makes the judge demand
// BOTH field vocabularies in the same output line — `count`/`sum` from the first, `numerator`/
// `denominator`/`ratio` from the second.
//
// Measured 2026-10-23: a correct uptime report did exactly that, its line carried
// `[id, denominator, sum, numerator, ratio]`, and the judge refused it for `sum=0.0 want 3.0` — a field a
// ratio report has no reason to print. The availability arithmetic was right and the delivery was lost.
//
// The prompt is the only place the intake learns this, so the prompt has to say it. A sentence nobody
// checks is a sentence that rots; this assertion is what keeps it in the file it has to be in.
test('vocabulary: the intake prompt says the two field models are alternatives (ledger #99)', () => {
  const prompt = read('extensions/skills/req-intake/prompts/intake.md');
  assert.match(
    prompt,
    /DO NOT MIX THE TWO FIELD MODELS/,
    'the prompt must warn against mixing the field models, not only the two shapes',
  );
  // Both vocabularies have to be NAMED in that warning, or a reader cannot tell which is which.
  assert.match(prompt, /`count`, `sum`, `min`, `max`, `mean`/, 'the record-aggregate fields are listed');
  assert.match(prompt, /`numerator`, `denominator`, `ratio`/, 'the derived-ratio fields are listed');
  // And it must say the choice is exclusive.
  assert.match(prompt, /declare only that one/i, 'it must say to pick ONE model');
  // AND IT MUST SAY WHAT TO CHOOSE BY. A warning that says "pick one" without a criterion is what let
  // the next run pick the record model because the request mentioned malformed rows — which is a
  // property of the INPUT, not of the answer. The rule is: decide from the printed NUMBER.
  assert.match(prompt, /CHOOSE THE MODEL FROM THE ANSWER, NEVER FROM THE INPUT/, 'the criterion is stated');
  assert.match(prompt, /properties of the INPUT/, 'and the inputs that must NOT drive the choice are named');
  assert.match(prompt, /percentage or a rate/i, 'the ratio-shaped answers are listed so the criterion is usable');
});
