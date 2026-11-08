import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LEDGER #126 — the shape gate must record WHY the forge refused, not just that it did.
 *
 * Measured 2026-11-08: every `intake_shape` refusal read
 *
 *   not ok 4 - a judge can be forged from the document as the confirmation will leave it
 *              (exit 1: no delivery could be judged against this document)
 *
 * and nothing else. The forge DOES print its reason as comment lines, but `#103` budgets the gate's
 * summary and keeps the failing lines first — so the sentence naming the defect was the one thing cut,
 * on every single refusal. Diagnosing the intake's 1-in-3 first-attempt rate was impossible from the
 * records for that reason alone.
 *
 * The first line of a forge refusal is its verdict, so it is repeated up front, prefixed so it is
 * greppable in a log and survives any truncation that keeps the head.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../extensions/workflows/request-intake/checks/intake-shape-tap.sh',
);

test('a forge refusal is repeated as `# FORGE SAID:` before the transcript', () => {
  const body = readFileSync(SCRIPT, 'utf8');
  assert.match(body, /FORGE SAID/, 'the marker exists');
  assert.match(
    body,
    /head -1 \| sed 's\/\^\/# FORGE SAID: \/'/,
    'it repeats the forge\'s first line, which is its verdict',
  );
  // It must be conditional on failure: a successful forge has no refusal to quote.
  assert.match(body, /if \[ "\$FORGE_STATUS" -ne 0 \]/, 'only when the forge failed');
});

test('the marker is emitted ABOVE the comment transcript, so truncation cannot eat it', () => {
  // A budget that keeps the head must keep the marker. Asserting the order in the source is the only
  // way to check this without running the whole gate.
  const body = readFileSync(SCRIPT, 'utf8');
  const marker = body.indexOf('FORGE SAID');
  const transcript = body.indexOf('printf \'%s\\n\' "$FORGE_OUT" | sed \'s/^/# /\'');
  assert.ok(marker > 0 && transcript > 0, 'both lines exist');
  assert.ok(marker < transcript, 'the verdict comes first');
});

test('the gate still records the failing check itself', () => {
  const body = readFileSync(SCRIPT, 'utf8');
  assert.match(
    body,
    /not_ok "a judge can be forged from the document as the confirmation will leave it \(exit \$FORGE_STATUS/,
    'the `not ok` line survives, so #103 keeps working',
  );
});

test('a running gate prints the marker before the reason it already printed', () => {
  // Drive the real script over a document whose forge will refuse, and read the TAP it emits.
  // The gate resolves the validator and the forge RELATIVE TO THE PROJECT, so it must run from the real
  // repository while the DOCUMENT under test lives in a temp dir (TAKUMI_INTAKE_DOC is absolute).
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const dir = mkdtempSync(join(tmpdir(), 'shape-said-'));
  try {
    const docs = join(dir, 'docs/requirements');
    mkdirSync(docs, { recursive: true });
    // Two scenarios collapsed into one id: the forge refuses by name, which is the case that was
    // invisible in the records.
    writeFileSync(
      join(docs, 'intake.yaml'),
      [
        'requirements:',
        '  - id: REQ-001',
        '    title: one requirement',
        '    acceptance_criteria:',
        '      - something checkable',
        'deliverable:',
        '  run: "bash summary.sh {csv}"',
        '  input_format:',
        '    columns: "suite:id,passed:measure,total:other"',
        '    sample: |',
        '      a,1,2',
        '      b,0,1',
        '  output_format:',
        '    suite_line:',
        '      shape: "<suite> <passed> <total> <pct>"',
        '      fields: [id, numerator, denominator, ratio]',
        '  scenarios:',
        '    - id: SCN-001 SCN-002',
        '      expect: "the report lists a line per suite"',
        '  relations:',
        '    - id: REL-001',
        '      relation: derived-ratio',
        '      description: each percentage is passed/total',
        '',
      ].join('\n'),
    );
    const r = spawnSync('bash', [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, TAKUMI_INTAKE_DOC: join(docs, 'intake.yaml') },
    });
    const out = `${r.stdout}${r.stderr}`;
    // If the forge accepted this document the marker would be absent, which would prove nothing about
    // the marker — but the fixture is built to be refused, so require the marker.
    assert.match(out, /# FORGE SAID: /, `the gate must quote the forge's verdict. Output:\n${out.slice(0, 2000)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
