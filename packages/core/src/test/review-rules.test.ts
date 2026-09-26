import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFindings,
  hasBlockingFinding,
  hasHumanFinding,
  isTestPath,
  runReviewRules,
  type ReviewFileChange,
  type ReviewInput,
} from '../review-rules.js';

/**
 * The deterministic reviewer's rules, tested as pure functions: two strings in, findings
 * out. Every rule gets its positive case AND the negative case that would make it a
 * nuisance — a rule that fires on ordinary work is worse than no rule, because it spends
 * the agent's fix rounds on nothing.
 */

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function change(
  path: string,
  baseContent: string | null,
  headContent: string | null,
  status: ReviewFileChange['status'] = 'modified',
): ReviewFileChange {
  return { path, status, baseContent, headContent };
}

function input(...changes: ReviewFileChange[]): ReviewInput {
  return { baseSha: BASE, headSha: HEAD, changes };
}

const TEST_WITH_TWO_ASSERTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('add', () => {
  assert.equal(add(1, 2), 3);
  assert.equal(add(0, 0), 0);
});
`;

test('a deleted test file is a block: a removed proof is not a fix', () => {
  const findings = runReviewRules(input(change('test/calc.test.ts', TEST_WITH_TWO_ASSERTS, null, 'deleted')));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, 'test-weakening/deleted');
  assert.equal(findings[0]?.severity, 'block');
  assert.match(findings[0]?.detail ?? '', /exists at aaaa/);
});

test('a NEW test file is not a deletion (and its own skips are not a weakening)', () => {
  const findings = runReviewRules(
    input(change('test/new.test.ts', null, "test('x', () => { assert.ok(1); });", 'added')),
  );
  assert.deepEqual(
    findings.filter((f) => f.rule.startsWith('test-weakening/')),
    [],
    'adding tests is the good case, not a finding',
  );
  assert.deepEqual(findings.map((f) => f.severity), ['note'], 'it is a test-only change, which is a note');
});

test('adding a skip marker is a block, and removing one is not', () => {
  const before = `test('a', () => { assert.equal(1, 1); });`;
  const after = `test.skip('a', () => { assert.equal(1, 1); });`;
  const weakened = runReviewRules(input(change('test/a.test.ts', before, after)));
  assert.equal(weakened.filter((f) => f.rule === 'test-weakening/skipped').length, 1);

  const restored = runReviewRules(input(change('test/a.test.ts', after, before)));
  assert.deepEqual(
    restored.filter((f) => f.rule.startsWith('test-weakening/')),
    [],
    'un-skipping a test is progress',
  );
});

test('losing assertions is a block, and gaining them is not', () => {
  const fewer = `test('add', () => { assert.equal(add(1, 2), 3); });`;
  const lost = runReviewRules(input(change('test/a.test.ts', TEST_WITH_TWO_ASSERTS, fewer)));
  const finding = lost.find((f) => f.rule === 'test-weakening/assertions-removed');
  assert.ok(finding, 'fewer assertions must be reported');
  // The counts are a heuristic over markers (the fixture's `import assert` scores too), so
  // the assertion is on the DIRECTION, which is the fact the rule exists for.
  const counts = /went from (\d+) to (\d+)/.exec(finding.detail);
  assert.ok(counts, `the detail must name both counts: ${finding.detail}`);
  assert.ok(Number(counts[1]) > Number(counts[2]), 'the before count must be the larger one');

  const gained = runReviewRules(input(change('test/a.test.ts', fewer, TEST_WITH_TWO_ASSERTS)));
  assert.deepEqual(
    gained.filter((f) => f.rule.startsWith('test-weakening/')),
    [],
    'more assertions is the point — and the only thing left to say is that the tests are all that changed',
  );
});

test('the assertion rule only judges files that exist on BOTH sides', () => {
  // An added test file has no "before" to lose assertions from; a deleted one is already
  // covered by its own rule. Counting either against zero would report nonsense.
  const findings = runReviewRules(
    input(
      change('test/added.test.ts', null, `assert.ok(1);`, 'added'),
      change('test/gone.test.ts', `assert.ok(1);`, null, 'deleted'),
    ),
  );
  assert.equal(findings.filter((f) => f.rule === 'test-weakening/assertions-removed').length, 0);
});

test('a test-only change is a NOTE by default, so a real test-writing item still merges', () => {
  const findings = runReviewRules(
    input(change('test/calc.test.ts', TEST_WITH_TWO_ASSERTS, `${TEST_WITH_TWO_ASSERTS}test('sub', () => { assert.equal(sub(3, 4), -1); });`)),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, 'test-only-change');
  assert.equal(findings[0]?.severity, 'note');
  assert.equal(hasBlockingFinding(findings), false, 'writing tests is not a defect');
  assert.equal(hasHumanFinding(findings), false);
});

test('the test-only rule can be made a block, or ignored, by policy', () => {
  const only = input(change('test/calc.test.ts', 'assert.ok(1);', 'assert.ok(1); assert.ok(2);'));
  assert.equal(runReviewRules(only, { testOnlyChange: 'block' })[0]?.severity, 'block');
  assert.deepEqual(runReviewRules(only, { testOnlyChange: 'ignore' }), []);
});

test('a change outside the tests alongside a test change is not "test only"', () => {
  const findings = runReviewRules(
    input(
      change('src/calc.ts', 'export const add = (a, b) => a + b;', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;'),
      change('test/calc.test.ts', 'assert.ok(1);', 'assert.ok(1); assert.ok(2);'),
    ),
  );
  assert.deepEqual(findings.filter((f) => f.rule === 'test-only-change'), []);
});

test('a protected path needs a HUMAN, and is never handed back to the agent to "fix"', () => {
  for (const path of ['package.json', '.github/workflows/ci.yml', 'Dockerfile', 'go.mod', 'pnpm-lock.yaml', 'takumi.yaml', '.takumi/workflows/x.yaml']) {
    const findings = runReviewRules(input(change(path, 'a', 'b')));
    const finding = findings.find((f) => f.rule === 'protected-path');
    assert.ok(finding, `${path} must be protected`);
    assert.equal(finding.severity, 'human', `${path}: a machine may not wave it through`);
    assert.equal(hasHumanFinding(findings), true);
    assert.equal(hasBlockingFinding(findings), false, 'and an agent may not be told to revert it');
  }
});

test('an ordinary source file is not protected and raises nothing', () => {
  const findings = runReviewRules(input(change('src/calc.ts', 'a', 'b'), change('docs/README.md', 'a', 'b')));
  assert.deepEqual(findings, []);
});

test('protected paths and test patterns are configurable', () => {
  const custom = runReviewRules(input(change('infra/terraform.tf', 'a', 'b')), {
    protectedPaths: ['(^|/)infra/'],
  });
  assert.equal(custom[0]?.rule, 'protected-path');

  // Replacing the list takes the defaults away — an operator who says "only this" means it.
  const replaced = runReviewRules(input(change('package.json', 'a', 'b')), {
    protectedPaths: ['(^|/)infra/'],
    replaceProtectedPaths: true,
  });
  assert.deepEqual(replaced, []);

  const extraTestPattern = runReviewRules(input(change('specs/calc_spec.rb', 'assert.ok(1);', 'assert.ok(1); assert.ok(2);')), {
    testPathPatterns: ['_spec\\.rb$'],
    testOnlyChange: 'note',
  });
  assert.equal(extraTestPattern[0]?.rule, 'test-only-change', 'a custom test pattern is honoured');
});

test('a broken pattern weakens one rule instead of taking the reviewer down', () => {
  const findings = runReviewRules(input(change('test/a.test.ts', 'assert.ok(1);', 'assert.ok(1);')), {
    testPathPatterns: ['([unclosed'],
  });
  assert.deepEqual(
    findings.map((f) => f.rule),
    ['test-only-change'],
    'the default patterns still work (the file IS recognised as a test) and the broken one is skipped',
  );
});

test('weakening can be switched off entirely by an operator who means it', () => {
  const findings = runReviewRules(input(change('test/a.test.ts', TEST_WITH_TWO_ASSERTS, null, 'deleted')), {
    forbidTestWeakening: false,
  });
  assert.equal(findings.some((f) => f.rule.startsWith('test-weakening/')), false, 'the operator asked for no weakening rule');
  assert.deepEqual(findings.map((f) => f.rule), ['test-only-change'], 'the deletion is still worth a note');
});

test('the findings list is stable and renders one line per finding', () => {
  const findings = runReviewRules(
    input(
      change('test/a.test.ts', TEST_WITH_TWO_ASSERTS, 'test("a", () => {});'),
      change('package.json', 'a', 'b'),
    ),
  );
  assert.deepEqual(
    findings.map((f) => f.rule),
    ['test-weakening/assertions-removed', 'protected-path'],
  );
  const text = describeFindings(findings);
  assert.match(text, /test-weakening\/assertions-removed \(test\/a\.test\.ts\)/);
  assert.match(text, /protected-path \(package\.json\)/);
});

test('isTestPath: the plumbing and the rules agree on what a test file is', () => {
  assert.equal(isTestPath('test/calc.test.ts'), true);
  assert.equal(isTestPath('src/calc.spec.js'), true);
  assert.equal(isTestPath('src/__tests__/calc.js'), true);
  assert.equal(isTestPath('test_calc.py'), true);
  assert.equal(isTestPath('calc_test.go'), true);
  assert.equal(isTestPath('src/test/java/CalcTest.java'), true);
  assert.equal(isTestPath('src/test/java/CalcTests.kt'), true);
  assert.equal(isTestPath('src/calc.ts'), false);
  assert.equal(isTestPath('docs/testing.md'), false, 'a document about tests is not a test');
  assert.equal(isTestPath('src/testdata/input.json'), false);
});

// --- credentials in the change (ADR-019) -------------------------------------------

// Assembled at runtime on purpose: a token-shaped literal in the tree is itself a
// finding for vendor secret scanners, while the rules under test still see the same
// string. Do not fold these back into one literal.
const SECRET_TOKENS = {
  glpat: 'glpat-' + 'AbCdEf0123456789xyzQ',
  privateKey: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  mixedEntropy: 'Zx8Qm2Lp7Rt4Vw9Yb3Nc6Kd1Hf5Jg0SaT',
  hexSha: '4f2a1c9e77b04c8fa1d5e6b7c8d9e0f1a2b3c4d',
};

function changesFor(path: string, base: string | null, head: string | null) {
  return { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), changes: [{ path, status: base === null ? ('added' as const) : ('modified' as const), baseContent: base, headContent: head }] };
}

test('review rules: a committed credential BLOCKS, and says to rotate it', () => {
  const findings = runReviewRules(changesFor('config.py', 'x = 1\n', `x = 1\n\ntoken = "${SECRET_TOKENS.glpat}"\n`));
  const secret = findings.find((f) => f.rule === 'secret/committed');
  assert.ok(secret !== undefined, `a token in the change must be found: ${JSON.stringify(findings)}`);
  assert.equal(secret.severity, 'block');
  assert.equal(secret.path, 'config.py');
  assert.equal(secret.line, 3, 'the finding points at the line, so a person can act on it');
  assert.match(secret.detail, /ROTATE/);
  assert.ok(hasBlockingFinding(findings), 'it must gate the delivery, not just be reported');
});

test('review rules: a private key header blocks too', () => {
  const findings = runReviewRules(changesFor('id_rsa', null, `${SECRET_TOKENS.privateKey}\nMIIEow...\n`));
  assert.equal(findings.filter((f) => f.rule === 'secret/committed').length, 1);
});

test('review rules: a secret that was ALREADY at the base is not this change\'s doing', () => {
  const body = `token = "${SECRET_TOKENS.glpat}"\n`;
  const findings = runReviewRules(changesFor('config.py', body, `${body}x = 1\n`));
  assert.equal(findings.filter((f) => f.rule === 'secret/committed').length, 0, 'reporting it every round would bury the one that is new');
});

test('review rules: a hex digest is NOT a secret (the false positive that matters)', () => {
  const findings = runReviewRules(changesFor('lock.json', '{\n}\n', `{\n  "sha": "${SECRET_TOKENS.hexSha}"\n}\n`));
  assert.equal(findings.filter((f) => f.rule.startsWith('secret/')).length, 0, `a lockfile hash must not trip the gate: ${JSON.stringify(findings)}`);
});

test('review rules: an unprovable high-entropy string goes to a HUMAN, never to a block', () => {
  const findings = runReviewRules(changesFor('settings.py', null, `KEY = "${SECRET_TOKENS.mixedEntropy}"\n`));
  const suspected = findings.find((f) => f.rule === 'secret/suspected');
  assert.ok(suspected !== undefined, `a mixed-entropy run must be surfaced: ${JSON.stringify(findings)}`);
  assert.equal(suspected.severity, 'human', 'a heuristic never blocks: a person decides');
  assert.equal(suspected.line, 1);
  assert.equal(hasBlockingFinding(findings), false);
  assert.equal(hasHumanFinding(findings), true);
});
