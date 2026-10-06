import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FEEDBACK_BRIEF_MARKER,
  analyseFeedback,
  checkIdOf,
  decisionCheckIds,
  failuresWithoutDecision,
  parseDecisionBindings,
  parseRequirements,
  renderFeedbackBrief,
  validateRequirementDocument,
} from '../index.js';

// The intake brief (ADR-030): the deterministic half of "the intake reads the failure and proposes a
// decision". What a machine may claim here is narrow and exact — which decision a failing check
// exercises, what answer was recorded, and which answers could replace it — so the tests are about the
// trace and about the refusals, not about prose.

const DOC = [
  'requirement:',
  '  id: REQ-DOC-001',
  'requirements:',
  '  - id: REQ-001',
  '    title: Summarise the CSV',
  '    acceptance_criteria:',
  '      - One line per department.',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: What happens to a malformed row?',
  '    options:',
  '      - "Skip the row, count it, and report the count"',
  '      - "Stop with an error"',
  '    default: "Skip the row, count it, and report the count"',
  '    chosen: "Skip the row, count it, and report the count"',
  '    blocking: true',
  '  - id: AMB-002',
  '    question: Which row wins when employee_id repeats?',
  '    options:',
  '      - "First row wins"',
  '      - "Last row wins"',
  '      - "The row with the latest start_date wins"',
  '    default: "First row wins"',
  '    chosen: "The row with the latest start_date wins"',
  '    checkedAs: latest-start-date',
  '    blocking: true',
  '  - id: AMB-003',
  '    question: Where does the summary go?',
  '    options: ["stdout only", "stdout, plus an optional file path"]',
  '    default: "stdout only"',
  '    chosen: "stdout only"',
  '    blocking: false',
  'deliverable:',
  '  run: "node csv-summary.mjs {csv}"',
  '  input_format:',
  '    columns: "employee_id:id,start_date:date,annual_salary:measure"',
  '    sample: |',
  '      1001,2021-04-01,100.5',
  '      1002,2020-02-02,80.0',
  '      1003,2020-01-10,90.5',
  '      1001,2019-01-02,70.0',
  '  output_format:',
  '    department_line:',
  '      shape: "<department> <count> <total> <average>"',
  '      fields: [id, count, sum, mean]',
  '    skipped_line:',
  '      shape: "SKIPPED <count>"',
  '      fields: [skipped-count]',
  '    overall_line:',
  '      shape: "TOTAL <count> <total>"',
  '      fields: [count, sum]',
  '  relations:',
  '    - id: REL-001',
  '      relation: row-order-invariance',
  '      description: Shuffling the rows changes nothing.',
  '    - id: REL-002',
  '      relation: additivity',
  '      description: Department totals sum to the overall total.',
  '    - id: REL-003',
  '      relation: duplicate-resolution',
  '      decides: AMB-002',
  '      description: A repeated id resolves the way AMB-002 decided.',
  '  differential:',
  '    - id: DIFF-001',
  '      anchor: independent-aggregation',
  '      description: An independent recomputation matches the report.',
  '',
].join('\n');

const feedback = (checks: string[], status = 'open'): string =>
  [
    'feedback:',
    '  - id: FB-001',
    '    at: "2026-10-01T05:00:00.000Z"',
    '    run: "wf-1"',
    '    requirementDigest: "sha256:aaa"',
    '    judgeDigest: "sha256:bbb"',
    `    status: ${status}`,
    '    checks:',
    ...checks.map((c) => `      - "${c.replace(/"/g, '\\"')}"`),
    '',
  ].join('\n');

const withFeedback = (checks: string[], status = 'open'): string => `${DOC}\n${feedback(checks, status)}`;

test('brief: the document parse keeps decisions, bindings and DEC numbering in one place', () => {
  const decisions = parseRequirements(DOC);
  assert.deepEqual(decisions.map((d) => d.id), ['AMB-001', 'AMB-002', 'AMB-003']);
  assert.equal(decisions[1]?.chosen, 'The row with the latest start_date wins');
  assert.equal(decisions[2]?.blocking, false);

  const bindings = parseDecisionBindings(DOC);
  assert.deepEqual(
    bindings,
    [
      { checkId: 'REL-001', kind: 'relation', relation: 'row-order-invariance' },
      { checkId: 'REL-002', kind: 'relation', relation: 'additivity' },
      { checkId: 'REL-003', kind: 'relation', relation: 'duplicate-resolution', decides: 'AMB-002' },
      { checkId: 'DIFF-001', kind: 'anchor', relation: 'independent-aggregation' },
    ],
    'every declared check is listed; only the ones with a binding name a decision',
  );

  // DEC numbering follows the forge: one per exercised decision, in document order.
  const ids = decisionCheckIds(decisions, bindings);
  assert.deepEqual([...ids], [['AMB-002', 'DEC-001']]);
  assert.equal(checkIdOf('DEC-001 AMB-002 honoured: "x"'), 'DEC-001');
  assert.equal(checkIdOf('REL-003 duplicate-resolution: x'), 'REL-003');
  assert.equal(checkIdOf('no id here'), '');
});

test('brief: a failing check that exercises a decision names it, its answer and its alternatives', () => {
  const analysed = analyseFeedback(withFeedback(['REL-003 duplicate-resolution: the chosen option does not hold']));
  assert.equal(analysed.length, 1);
  const failure = analysed[0]?.failures[0];
  assert.equal(failure?.kind, 'decision-not-honoured');
  assert.equal(failure?.decision?.id, 'AMB-002');
  // The alternatives are the decision's own options minus the answer it recorded — no invented ones.
  assert.deepEqual(failure?.alternatives, ['First row wins', 'Last row wins']);
});

test('brief: a DEC line traces back to its decision too, by numbering rather than by binding', () => {
  const analysed = analyseFeedback(withFeedback(['DEC-001 AMB-002 NOT honoured: "The row with the latest start_date wins"']));
  assert.equal(analysed[0]?.failures[0]?.kind, 'decision-not-honoured');
  assert.equal(analysed[0]?.failures[0]?.decision?.id, 'AMB-002');
});

test('brief: a check with no decision behind it is reported as such, never as a decision', () => {
  const analysed = analyseFeedback(
    withFeedback([
      'REL-002 additivity: department totals sum to 428 but the report says 214',
      'DOC-001 every open decision has a chosen option (4/4)',
      'ZZZ-001 something a harness invented',
    ]),
  );
  const failures = analysed[0]?.failures ?? [];
  assert.equal(failures[0]?.kind, 'no-decision');
  assert.match(failures[0]?.reason ?? '', /is a declared check, and it exercises no decision/);
  assert.equal(failures[1]?.kind, 'no-decision');
  assert.match(failures[1]?.reason ?? '', /DOC-001 is a check on the requirement document itself/);
  assert.match(failures[1]?.reason ?? '', /nothing for the intake to decide/);
  assert.equal(failures[2]?.kind, 'undeclared-check');
  assert.match(failures[2]?.reason ?? '', /cannot account for the check/);
  assert.deepEqual(failures.map((f) => f.decision), [undefined, undefined, undefined]);
});

test('brief: a DEC line the document cannot produce is not traced to a decision', () => {
  const analysed = analyseFeedback(withFeedback(['DEC-004 AMB-009 NOT honoured: "x"']));
  assert.equal(analysed[0]?.failures[0]?.kind, 'undeclared-check');
  assert.match(analysed[0]?.failures[0]?.reason ?? '', /do not add up to that numbering/);
});

test('brief: the rendered brief carries the marker, the trace and the either/or framing', () => {
  const text = renderFeedbackBrief('docs/requirements/doc.yaml', withFeedback(['REL-003 duplicate-resolution: nope', 'REL-002 additivity: nope']));
  assert.ok(text.startsWith(FEEDBACK_BRIEF_MARKER), 'the marker is what makes the intake treat this as a re-pass');
  assert.match(text, /### FB-001 — OPEN \(run wf-1\)/);
  assert.match(text, /\*\*REL-003\*\* — REL-003 duplicate-resolution: nope/);
  assert.match(text, /recorded answer: The row with the latest start_date wins/);
  assert.match(text, /- First row wins/);
  assert.match(text, /- Last row wins/);
  assert.match(text, /\*\*REL-002\*\* — /);
  assert.match(text, /exercises no decision: the failure is about the implementation/);
  assert.match(text, /fromFeedback: FB-nnn/);
});

test('brief: a document with no failure says so instead of asking for a revision', () => {
  const text = renderFeedbackBrief('docs/requirements/doc.yaml', DOC);
  assert.ok(text.startsWith(FEEDBACK_BRIEF_MARKER));
  assert.match(text, /No acceptance failure has been written back/);
  assert.match(text, /Nothing is being asked of the intake/);
});

test('brief: only OPEN failures with no decision behind them reach the intake as work', () => {
  const open = withFeedback(['REL-003 duplicate-resolution: mapped', 'REL-002 additivity: unmapped']);
  assert.deepEqual(
    failuresWithoutDecision(open).map((f) => f.checkId),
    ['REL-002'],
  );
  const resolved = withFeedback(['REL-002 additivity: unmapped'], 'resolved');
  assert.deepEqual(failuresWithoutDecision(resolved), []);
});

test('validate: a decision that cites a failure the document does not record is refused', () => {
  // The first `blocking: true` line that precedes another entry is AMB-002's, so this lands there.
  const cited = DOC.replace('    blocking: true\n  - id: AMB-003', '    blocking: true\n    fromFeedback: FB-001\n  - id: AMB-003');
  assert.ok(
    validateRequirementDocument(cited).some((i) => /AMB-002 cites FB-001, which this document does not record/.test(i)),
    'the dangling citation is refused',
  );
  // With the failure present, the same citation is fine: the decision answers something real.
  const ok = `${cited.replace(/\s*$/, '')}\n\n${feedback(['REL-002 additivity: x'])}`;
  assert.ok(
    validateRequirementDocument(ok).every((i) => !i.includes('cites FB-001')),
    'with the failure on record the citation is fine',
  );
});

test('validate: the intake contract is machine-checked, not hoped for', () => {
  // Ids that do not line up: the loop traces decisions and requirements by that numbering.
  const gaps = DOC.replace('  - id: AMB-003', '  - id: AMB-007');
  assert.match(validateRequirementDocument(gaps)[0] ?? '', /the AMB ids are not sequential: entry 3 is AMB-007 where AMB-003 was expected/);

  // An unbounded "open question" cannot be answered by typing a number.
  const single = DOC.replace('      - "Stop with an error"\n', '');
  assert.match(
    validateRequirementDocument(single).find((i) => i.includes('AMB-001')) ?? '',
    /AMB-001 has 1 option\(s\): a decision a human answers by number needs 2 to 4 bounded options/,
  );

  // A value the document does not offer is a value nobody chose.
  const stray = DOC.replace('    chosen: "The row with the latest start_date wins"', '    chosen: "Whatever the implementer felt like"');
  assert.match(
    validateRequirementDocument(stray).find((i) => i.includes('AMB-002')) ?? '',
    /AMB-002 has chosen = "Whatever the implementer felt like", which is not one of its own options/,
  );

  // A requirement nobody can check is a wish.
  const noCriteria = DOC.replace('    acceptance_criteria:\n      - One line per department.\n', '');
  assert.match(validateRequirementDocument(noCriteria).find((i) => i.includes('REQ-001')) ?? '', /REQ-001 has no acceptance criterion/);
});

test('validate: the confirmed PoC document itself passes the contract', () => {
  // A guard against the validator drifting away from the document the flow was built on: the rules are
  // enforced by `takumi requirement confirm --dry-run`, so tightening them must not break the real file.
  const real = readFileSync(new URL('../../../../docs/requirements/poc-blackbox-acceptance.yaml', import.meta.url), 'utf8');
  assert.deepEqual(validateRequirementDocument(real), []);
});

test('validate: the deliverable block is checked before a human confirms it (ADR-031)', () => {
  // No invocation: a judge with no way to run the thing cannot check anything.
  const noRun = DOC.replace('  run: "node csv-summary.mjs {csv}"\n', '');
  assert.match(validateRequirementDocument(noRun)[0] ?? '', /declares no run/);

  // A relation no judge implements: refused at the front door, not after the implementation is paid for.
  const invented = DOC.replace('      relation: additivity', '      relation: statistical-plausibility');
  assert.match(
    validateRequirementDocument(invented).find((i) => i.includes('REL-002')) ?? '',
    /declares the relation "statistical-plausibility", which no judge can check \(implemented: row-order-invariance, additivity/,
  );

  // A blocking decision nothing exercises. AMB-001 and AMB-002 are both blocking; only AMB-002 is bound.
  const uncovered = DOC.replace('      decides: AMB-002', '      note: unbound');
  assert.match(
    validateRequirementDocument(uncovered).find((i) => i.includes('AMB-001')) ?? '',
    /AMB-001 is blocking and no declared check exercises it/,
  );

  // The confirmed PoC document satisfies all of it — asserted in the guard test below.
});

test('validate: a check claiming to settle a decision that is not there is refused', () => {
  assert.ok(
    validateRequirementDocument(DOC.replace('decides: AMB-002', 'decides: AMB-099')).some((i) =>
      /REL-003 \(duplicate-resolution\) exercises AMB-099, which is not a decision/.test(i),
    ),
  );
});
