import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationDigest,
  licenseStandingConfirmation,
  parseStandingAuthorization,
  readRequirementConfirmation,
  requirementDigest,
  UNMECHANISED_CLASS,
} from '../index.js';

/**
 * A standing authorization (ADR-045), PIN-ONLY (v1).
 *
 * A human signs ONE committed file that says: this exact revision of this exact requirement document
 * may be confirmed by its OWN `default:` answers, for these classes of decision, and nothing else. The
 * confirmation still happens and the digest is still the token (ADR-025); what changes is who wrote the
 * `chosen:` lines, and what the record says about it.
 *
 * What is pinned here is the two halves of that promise:
 *   * what it may license — a decision whose class is granted and whose default is an argument, and
 *   * what it may NEVER license, fail-closed and by name — a class outside the vocabulary, a widening
 *     field, a failure closure that is a human's to make, an expired or revoked grant, a document that
 *     changed since it was signed, a decision marked `human: true`, an open failure.
 */

const DOC_REF = 'docs/requirements/intake.yaml';

const DOC = [
  'requirements:',
  '  - id: REQ-001',
  '    title: "Summarise the readings"',
  '    description: "Print one aggregate line per station."',
  '    acceptance_criteria:',
  '      - "A third party can check the summary."',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: "How are unparseable rows handled?"',
  '    options:',
  '      - "skip-count: skipped and counted on a SKIPPED line"',
  '      - "stop-error: the first bad row aborts the run"',
  '    default: "skip-count: skipped and counted on a SKIPPED line"',
  '    checkedAs: skip-count',
  '    blocking: true',
  '  - id: AMB-002',
  '    question: "When a (date, station) key repeats, what wins?"',
  '    options:',
  '      - "merge: every occurrence counts as its own reading"',
  '      - "last-row: only the last occurrence is kept"',
  '    default: "merge: every occurrence counts as its own reading"',
  '    checkedAs: merge',
  '    blocking: true',
  '  - id: AMB-003',
  '    question: "In what order are the station lines printed?"',
  '    options:',
  '      - "ascending station id"',
  '      - "order of first appearance in the input"',
  '    default: "ascending station id"',
  '    blocking: false',
  'deliverable:',
  '  run: "bash summary.sh {csv}"',
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
  '      relation: malformed-row-accounting',
  '      decides: AMB-001',
  '      description: "bad rows are skipped and counted"',
  '    - id: REL-002',
  '      relation: duplicate-resolution',
  '      decides: AMB-002',
  '      description: "a repeated key merges"',
  '',
].join('\n');

/** The authorization file, with the pin computed from `doc`. `mutate` rewrites lines it is handed. */
function authText(doc: string, mutate: (lines: string[]) => string[] = (l) => l): string {
  const base = [
    'id: SA-001',
    'signedBy: "moon"',
    'signedAt: "2026-10-11T00:00:00Z"',
    'expiresAt: "2026-11-11T00:00:00Z"',
    'revoked: false',
    'reason: "unattended intake for the station-summary document"',
    'pin:',
    `  ref: "${DOC_REF}"`,
    `  digest: "${requirementDigest(doc)}"`,
    'decisions:',
    '  - class: malformed-row-accounting',
    '    policy: document-default',
    '  - class: duplicate-resolution',
    '    policy: document-default',
    '  - class: unmechanised',
    '    policy: document-default',
    'failures:',
    '  - class: implementation-changes',
    '',
  ];
  return mutate(base).join('\n');
}

function load(text: string) {
  return parseStandingAuthorization(text);
}

/** Load an authorization that must be well formed, or fail loudly with its own issues. */
function loaded(text: string) {
  const result = load(text);
  assert.deepEqual(result.issues, [], `the fixture authorization must load: ${result.issues.join('; ')}`);
  assert.ok(result.authorization, 'the fixture authorization must produce a value');
  return result.authorization;
}

// --- what it IS ---------------------------------------------------------------------------------

test('a standing authorization is one committed pin, plus the classes it may default', () => {
  const authorization = loaded(authText(DOC));
  assert.equal(authorization.id, 'SA-001');
  assert.equal(authorization.signedBy, 'moon');
  assert.equal(authorization.revoked, false);
  assert.equal(authorization.pin.ref, DOC_REF);
  assert.equal(authorization.pin.digest, requirementDigest(DOC));
  assert.deepEqual(
    authorization.decisions.map((d) => [d.class, d.policy]),
    [
      ['malformed-row-accounting', 'document-default'],
      ['duplicate-resolution', 'document-default'],
      [UNMECHANISED_CLASS, 'document-default'],
    ],
  );
  assert.deepEqual(authorization.failures.map((f) => f.class), ['implementation-changes']);
});

test('the authorization digest IS the requirement digest: one hash function, one "same text"', () => {
  // CRLF, trailing whitespace and a missing final newline are the same text to both.
  assert.equal(authorizationDigest('a\r\nb   \n\n'), requirementDigest('a\r\nb   \n\n'));
  assert.equal(authorizationDigest('a\r\nb   \n\n'), requirementDigest('a\nb\n'));
});

// --- what it may NEVER license: refused at load, by name ----------------------------------------

test('a class outside the project vocabulary is refused at load, by name', () => {
  const result = load(
    authText(DOC, (lines) => lines.map((line) => (line === '  - class: unmechanised' ? '  - class: anything-goes' : line))),
  );
  assert.equal(result.authorization, undefined);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0] ?? '', /anything-goes/);
  assert.match(result.issues[0] ?? '', /malformed-row-accounting/);
  assert.match(result.issues[0] ?? '', /unmechanised/);
});

test('a field that would WIDEN the licensable set is refused at load, by name', () => {
  const widenings: [string, string[]][] = [
    ['scope.documents', ['scope:', '  documents:', `    - "${DOC_REF}"`]],
    ['allowProtectedPaths', ['allowProtectedPaths: true']],
    ['anyDecision', ['anyDecision: true']],
    ['override', ['override: "confirm everything"']],
  ];
  for (const [name, added] of widenings) {
    const result = load(authText(DOC, (lines) => [...lines, ...added]));
    assert.equal(result.authorization, undefined, `${name} must refuse the file`);
    assert.equal(result.issues.length, 1, `${name}: one issue, naming itself`);
    assert.match(result.issues[0] ?? '', new RegExp(name.split('.')[0] ?? name), `${name} must be named`);
    assert.match(result.issues[0] ?? '', /widen|pin/i);
  }
});

test('the other failure closures are refused at load: only the implementation is a machine\'s to change', () => {
  for (const [kind, why] of [
    ['answer-wrong', /answer|criteria/i],
    ['check-at-fault', /human|claim/i],
    ['addressed', /legacy|undifferentiated/i],
  ] as const) {
    const result = load(
      authText(DOC, (lines) => lines.map((line) => (line === '  - class: implementation-changes' ? `  - class: ${kind}` : line))),
    );
    assert.equal(result.authorization, undefined, `${kind} must refuse the file`);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0] ?? '', new RegExp(kind));
    assert.match(result.issues[0] ?? '', why);
  }
});

test('an authorization that never expires is refused, and so is a repair budget (v1 spends no rounds)', () => {
  const noExpiry = load(authText(DOC, (lines) => lines.filter((line) => !line.startsWith('expiresAt:'))));
  assert.equal(noExpiry.authorization, undefined);
  assert.match(noExpiry.issues.join(' '), /expires/i);

  const rounds = load(
    authText(DOC, (lines) => lines.map((line) => (line === '  - class: implementation-changes' ? '  - class: implementation-changes\n    maxRounds: 2' : line))),
  );
  assert.equal(rounds.authorization, undefined, 'v1 may not spend repair rounds');
  assert.match(rounds.issues.join(' '), /maxRounds/);
});

test('an unknown policy, a duplicate class and a missing pin are each refused by name', () => {
  const badPolicy = load(
    authText(DOC, (lines) => lines.map((line) => (line === '    policy: document-default' ? '    policy: invent-an-answer' : line))),
  );
  assert.equal(badPolicy.authorization, undefined);
  assert.match(badPolicy.issues.join(' '), /invent-an-answer|policy/);

  const duplicate = load(
    authText(DOC, (lines) => [
      ...lines,
      '  - class: malformed-row-accounting',
      '    policy: document-default',
    ]),
  );
  assert.equal(duplicate.authorization, undefined);
  assert.match(duplicate.issues.join(' '), /twice|duplicate/i);

  const noPin = load(authText(DOC, (lines) => lines.filter((line) => !/^  (ref|digest):/.test(line) && line !== 'pin:')));
  assert.equal(noPin.authorization, undefined);
  assert.match(noPin.issues.join(' '), /pin/);
});

// --- what it may license ------------------------------------------------------------------------

test('a covered document is licensed: every open decision gets its OWN default, in document order', () => {
  const authorization = loaded(authText(DOC));
  const licence = licenseStandingConfirmation({ authorization, documentRef: DOC_REF, documentText: DOC });
  assert.deepEqual(licence.refusals, []);
  assert.deepEqual(
    licence.defaulted.map((d) => [d.id, d.class, d.chosen, d.checkedAs]),
    [
      ['AMB-001', 'malformed-row-accounting', 'skip-count: skipped and counted on a SKIPPED line', 'skip-count'],
      ['AMB-002', 'duplicate-resolution', 'merge: every occurrence counts as its own reading', 'merge'],
      ['AMB-003', UNMECHANISED_CLASS, 'ascending station id', undefined],
    ],
  );
  for (const decision of licence.defaulted) assert.equal(decision.policy, 'document-default');
});

test('it fills blanks and never overwrites an answer a human wrote', () => {
  const answered = DOC.replace(
    '    default: "skip-count: skipped and counted on a SKIPPED line"',
    '    default: "skip-count: skipped and counted on a SKIPPED line"\n    chosen: "stop-error: the first bad row aborts the run"',
  );
  const licence = licenseStandingConfirmation({
    authorization: loaded(authText(answered)),
    documentRef: DOC_REF,
    documentText: answered,
  });
  assert.deepEqual(licence.refusals, []);
  assert.deepEqual(licence.defaulted.map((d) => d.id), ['AMB-002', 'AMB-003'], 'the answered decision is left alone');
});

test('a decision the authorization does not cover STOPS it, and the refusal names the decision and why', () => {
  const authorization = loaded(
    authText(DOC, (lines) => lines.filter((line) => line !== '  - class: duplicate-resolution' && line !== '    policy: document-default')),
  );
  const licence = licenseStandingConfirmation({ authorization, documentRef: DOC_REF, documentText: DOC });
  assert.deepEqual(licence.defaulted, [], 'nothing is defaulted when anything is out of scope');
  assert.equal(licence.refusals.length, 1);
  assert.match(licence.refusals[0] ?? '', /AMB-002/);
  assert.match(licence.refusals[0] ?? '', /duplicate-resolution/);
  assert.match(licence.refusals[0] ?? '', /class/i);
});

test('a decision with no default, and one marked human: true, are each refused by name', () => {
  const noDefault = DOC.replace('    default: "ascending station id"\n', '');
  const licence = licenseStandingConfirmation({
    authorization: loaded(authText(noDefault)),
    documentRef: DOC_REF,
    documentText: noDefault,
  });
  assert.deepEqual(licence.defaulted, []);
  assert.match(licence.refusals.join('\n'), /AMB-003/);
  assert.match(licence.refusals.join('\n'), /default/);

  const human = DOC.replace('    checkedAs: merge\n', '    checkedAs: merge\n    human: true\n');
  const humanLicence = licenseStandingConfirmation({
    authorization: loaded(authText(human)),
    documentRef: DOC_REF,
    documentText: human,
  });
  assert.deepEqual(humanLicence.defaulted, []);
  assert.match(humanLicence.refusals.join('\n'), /AMB-002/);
  assert.match(humanLicence.refusals.join('\n'), /human/i);
});

test('an open acceptance failure is not a machine\'s to close: it stops the confirmation', () => {
  const withFailure = [
    DOC,
    'feedback:',
    '  - id: FB-001',
    '    at: "2026-10-01T00:00:00.000Z"',
    '    run: "wf-deadbeef"',
    '    requirementDigest: "aaaa"',
    '    judgeDigest: "sha256:bbbb"',
    '    status: open',
    '    checks:',
    '      - "REL-002 duplicate-resolution: the chosen option \\"merge\\" does not hold"',
    '',
  ].join('\n');
  const licence = licenseStandingConfirmation({
    authorization: loaded(authText(withFailure)),
    documentRef: DOC_REF,
    documentText: withFailure,
  });
  assert.deepEqual(licence.defaulted, []);
  assert.match(licence.refusals.join('\n'), /FB-001/);
  assert.match(licence.refusals.join('\n'), /failure/i);
});

test('expiry, revocation and a document that changed since it was signed are refusals by name', () => {
  const authorization = loaded(authText(DOC));

  const expired = licenseStandingConfirmation({
    authorization,
    documentRef: DOC_REF,
    documentText: DOC,
    now: new Date('2026-12-01T00:00:00Z'),
  });
  assert.deepEqual(expired.defaulted, []);
  assert.match(expired.refusals.join('\n'), /expired/i);

  const revoked = loaded(authText(DOC, (lines) => lines.map((line) => (line === 'revoked: false' ? 'revoked: true' : line))));
  const revokedLicence = licenseStandingConfirmation({ authorization: revoked, documentRef: DOC_REF, documentText: DOC });
  assert.deepEqual(revokedLicence.defaulted, []);
  assert.match(revokedLicence.refusals.join('\n'), /revoked/i);

  // The pin binds the REVISION a human read: an edit after signing is refused with both digests.
  const edited = DOC.replace('    blocking: false', '    blocking: false\n    # a human edited this after signing');
  const stale = licenseStandingConfirmation({ authorization, documentRef: DOC_REF, documentText: edited });
  assert.deepEqual(stale.defaulted, []);
  assert.match(stale.refusals.join('\n'), new RegExp(requirementDigest(edited)));
  assert.match(stale.refusals.join('\n'), new RegExp(requirementDigest(DOC)));

  // And the pin names ONE document: another path is out of scope by construction.
  const otherDoc = licenseStandingConfirmation({
    authorization,
    documentRef: 'docs/requirements/other.yaml',
    documentText: DOC,
  });
  assert.deepEqual(otherDoc.defaulted, []);
  assert.match(otherDoc.refusals.join('\n'), /other\.yaml/);
});

// --- the audit trail ----------------------------------------------------------------------------

test('the record can tell a human\'s confirmation from an authorization\'s, and names what nobody read', () => {
  const digestOnly = readRequirementConfirmation(DOC);
  assert.equal(digestOnly.mode, 'digest-only');
  assert.equal(digestOnly.by, null);
  assert.equal(digestOnly.method, null);
  assert.equal(digestOnly.authorization, null);
  assert.deepEqual(digestOnly.defaulted, []);

  const interactive = readRequirementConfirmation(
    `${DOC}\nconfirmation:\n  by: "moon"\n  at: "2026-10-11T09:17:13.940Z"\n  method: bounded-choice\n`,
  );
  assert.equal(interactive.mode, 'interactive');
  assert.equal(interactive.by, 'moon');
  assert.equal(interactive.method, 'bounded-choice');
  assert.equal(interactive.authorization, null);
  assert.deepEqual(interactive.defaulted, []);

  const standing = readRequirementConfirmation(
    [
      DOC,
      'confirmation:',
      '  by: "moon"',
      '  at: "2026-10-11T09:17:13.940Z"',
      '  method: standing-authorization',
      '  authorization:',
      '    ref: "docs/authorizations/SA-001.yaml"',
      `    digest: "sha256:${authorizationDigest('x')}"`,
      '    signedBy: "moon"',
      '    signedAt: "2026-10-11T00:00:00Z"',
      '    expiresAt: "2026-11-11T00:00:00Z"',
      '  defaulted:',
      '    - id: AMB-001',
      '      question: "How are unparseable rows handled?"',
      '      chosen: "skip-count: skipped and counted on a SKIPPED line"',
      '      class: malformed-row-accounting',
      '      policy: document-default',
      '      checkedAs: skip-count',
      '',
    ].join('\n'),
  );
  assert.equal(standing.mode, 'standing-authorization');
  assert.equal(standing.by, 'moon');
  assert.equal(standing.method, 'standing-authorization');
  assert.equal(standing.authorization?.ref, 'docs/authorizations/SA-001.yaml');
  assert.equal(standing.authorization?.signedBy, 'moon');
  assert.equal(standing.authorization?.expiresAt, '2026-11-11T00:00:00Z');
  assert.deepEqual(standing.defaulted.map((d) => [d.id, d.class, d.checkedAs]), [
    ['AMB-001', 'malformed-row-accounting', 'skip-count'],
  ]);
});
