import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The forged judge, running a MUTATION CHECK the document declares (ADR-039).
//
// The document names the tool, the report it writes and the survivor budget; the judge runs the tool in
// the delivery worktree, reads the report and compares the survivors to the budget. What these tests pin
// is that behaviour — and, above all, the fail-closed discipline: a mutation check that could not run
// (a missing binary, a timeout, a report the judge cannot read) is NEVER a pass. That is the vacuous
// green one level up, and it is the failure this relation exists to make impossible.

const FORGE = join(dirname(fileURLToPath(import.meta.url)), '../../../../extensions/judges/metamorphic-forge.sh');

/** The document, with the `mutation:` block the test wants; the relation uses it either way. */
const DOC = (mutation: string): string =>
  [
    'requirement:',
    '  id: REQ-DOC-001',
    'requirements:',
    '  - id: REQ-001',
    '    title: A station summary page',
    '    acceptance_criteria:',
    '      - The page answers with one row per station.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: How are values rounded?',
    '    options: ["half-up", "truncate"]',
    '    default: "half-up"',
    '    chosen: "half-up"',
    '    checkedAs: half-up',
    '    blocking: true',
    'deliverable:',
    '  run: "bash summary.sh {csv}"',
    '  input_format:',
    '    columns: "date:date,station:id,temperature_c:measure"',
    '    sample: |',
    '      2024-01-01,ALPHA,10.4',
    '      2024-01-02,BRAVO,11.6',
    '      2024-01-03,CHARLIE,9.5',
    '  output_format:',
    '    station_line:',
    '      shape: "<station> <count> <min> <max> <mean>"',
    '      fields: [id, count, min, max, mean]',
    '    total_line:',
    '      shape: "TOTAL <count>"',
    '      fields: [count]',
    mutation,
    '  relations:',
    '    - id: REL-001',
    '      relation: mutation-detection',
    '      description: The delivered tests fail when the delivered behaviour is mutated.',
    '  differential:',
    '    - id: DIFF-001',
    '      anchor: independent-aggregation',
    '      decides: AMB-001',
    '      description: An independent recomputation matches the report.',
    '',
  ].join('\n');

/** A `mutation:` block from real lines (a literal '\n' inside a test string is two characters). */
function mutationBlock(fields: { run?: string; reportPath?: string; format?: string; maxSurvivors?: string; timeoutMs?: string }): string {
  return [
    '  mutation:',
    ...(fields.run === undefined ? [] : [`    run: "${fields.run}"`]),
    ...(fields.reportPath === undefined ? [] : [`    report_path: "${fields.reportPath}"`]),
    ...(fields.format === undefined ? [] : [`    format: ${fields.format}`]),
    ...(fields.maxSurvivors === undefined ? [] : [`    max_survivors: ${fields.maxSurvivors}`]),
    ...(fields.timeoutMs === undefined ? [] : [`    timeoutMs: ${fields.timeoutMs}`]),
  ].join('\n');
}

interface Fixture {
  dir: string;
  worktree: string;
  judgeDir: string;
  env: Record<string, string>;
  forge: { status: number; out: string };
}

function run(command: string, args: string[], env: Record<string, string>, cwd: string): { status: number; out: string } {
  try {
    const out = execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Forge for `doc`, with `extraFiles` written into the worktree (the mutation tool the document names). */
function forgeFixture(doc: string, extraFiles: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-mutation-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(join(worktree, 'e2e'), { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/poc.yaml'), doc);
  for (const [name, content] of Object.entries(extraFiles)) {
    const path = join(worktree, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    // Any script the fixture writes must be runnable: a check that fails because the harness forgot the
    // executable bit is a test of the fixture, not of the judge.
    if (name.endsWith('.sh')) chmodSync(path, 0o755);
  }
  const env = {
    TAKUMI_REQUIREMENT: 'docs/requirements/poc.yaml',
    TAKUMI_PROJECT: dir,
    TAKUMI_WORKTREE: worktree,
    TAKUMI_JUDGE_DIR: judgeDir,
  };
  return { dir, worktree, judgeDir, env, forge: run('bash', [FORGE], env, dir) };
}

const judge = (f: Fixture): { status: number; out: string } => run('bash', [join(f.judgeDir, 'judge.sh')], f.env, f.judgeDir);
const cleanup = (f: Fixture): void => rmSync(f.dir, { recursive: true, force: true });

const mutationLine = (out: string): string => out.split('\n').find((l) => l.includes('mutation-detection')) ?? '';

/** The tool the document names: a shell script that writes the report the fixture hands it. */
const tool = (report: string): string =>
  ['#!/usr/bin/env bash', 'set -eu', 'mkdir -p e2e', `cat > e2e/mutation.json <<'JSON'`, report, 'JSON', 'exit 0', ''].join('\n');

const survivors = (entries: Array<{ file: string; line: number; description: string }>): string =>
  JSON.stringify({ total: 5, survivors: entries });

test('mutation: a run within the declared budget passes, and says the budget it stayed inside', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'bash e2e/mutate.sh', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
    { 'e2e/mutate.sh': tool(survivors([])) },
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    // The fixture does not supply the deliverable's own script, so the OTHER checks (DIFF-001, DEC-001) fail
    // for a reason that has nothing to do with mutation detection; what this test pins is the mutation
    // relation itself, exactly as judge-forge-scenarios.test.ts pins its SCN line.
    assert.match(
      mutationLine(r.out),
      /^ok \d+ - REL-001 mutation-detection: the delivered tests fail when the delivered behaviour is mutated \(0 survivor\(s\) tolerated\)$/,
      r.out,
    );
  } finally {
    cleanup(f);
  }
});

test('mutation: survivors over the budget fail, naming the count, the budget and the measured total', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'bash e2e/mutate.sh', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
    {
      'e2e/mutate.sh': tool(
        survivors([
          { file: 'src/sum.sh', line: 12, description: 'removed the mean' },
          { file: 'src/sum.sh', line: 20, description: 'replaced + with -' },
        ]),
      ),
    },
  );
  try {
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: the delivered tests fail when the delivered behaviour is mutated — 2 survivor\(s\) over the budget of 0 \(of 5 mutant\(s\) measured\): src\/sum\.sh:12 \(removed the mean\)/,
      r.out,
    );
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('mutation: a tool that is not there fails closed, naming the command and saying the tests never ran', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'this-tool-does-not-exist --run', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: .* — the mutation command could not run \(exit 127\), so the tests were never exercised: this-tool-does-not-exist --run/,
      r.out,
    );
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('mutation: a tool that outlives the declared timeout fails closed, saying the tests never ran', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'sleep 60', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0', timeoutMs: '5000' })),
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: .* — the mutation command timed out after 5000ms, so the tests were never exercised: sleep 60/,
      r.out,
    );
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('mutation: a report the judge cannot find fails, naming the path — never a silent pass', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'bash e2e/mutate.sh', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
    { 'e2e/mutate.sh': '#!/usr/bin/env bash\nexit 0\n' },
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: .* — the report .*e2e\/mutation\.json does not exist \(the command exited 0\): a mutation run whose report the judge cannot read is not a pass/,
      r.out,
    );
  } finally {
    cleanup(f);
  }
});

test('mutation: a malformed report fails, saying what the shape was', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'bash e2e/mutate.sh', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
    { 'e2e/mutate.sh': tool('[{"total": 5}]') },
  );
  try {
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: .* — the report .*e2e\/mutation\.json is not the declared survivors-json shape: the report is not a JSON object/,
      r.out,
    );
  } finally {
    cleanup(f);
  }
});

test('mutation: a report with an unknown key fails, naming the key and the declared shape', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'bash e2e/mutate.sh', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
    { 'e2e/mutate.sh': tool('{"total": 5, "survivors": [], "killed": 3}') },
  );
  try {
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: .* — the report .*e2e\/mutation\.json is not the declared survivors-json shape: the report declares the key "killed" where the declared shape has only total and survivors/,
      r.out,
    );
  } finally {
    cleanup(f);
  }
});

test('mutation: a run that measured zero mutants fails — a check that measured nothing is not a pass', () => {
  const f = forgeFixture(
    DOC(mutationBlock({ run: 'bash e2e/mutate.sh', reportPath: 'e2e/mutation.json', format: 'survivors-json', maxSurvivors: '0' })),
    { 'e2e/mutate.sh': tool('{"total": 0, "survivors": []}') },
  );
  try {
    const r = judge(f);
    assert.match(
      mutationLine(r.out),
      /not ok \d+ - REL-001 mutation-detection: .* — the report .*e2e\/mutation\.json measured 0 mutant\(s\): a mutation run that measured nothing cannot fail a test, so it is not a pass/,
      r.out,
    );
  } finally {
    cleanup(f);
  }
});
