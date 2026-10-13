import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// The limitations inventory is MACHINE-READ (docs/limitations.yaml, which explains why). These tests
// are what "machine-read" means: prose can sit in two places at once and disagree; an inventory with
// a checker cannot. Shapes borrowed from a spec-suite repository — mechanism only, that repository
// carries no licence at all.

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

interface Limitation {
  id?: string;
  what?: string;
  where?: { file?: string; contains?: string };
  closes_when?: string;
  closes_when_path?: string;
}

/** The three rules, as a function, so the rules themselves can be tested (not just the file). */
export function checkInventory(
  yamlText: string,
  opts: { repo: string; exists?: (p: string) => boolean; read?: (p: string) => string },
): string[] {
  const exists = opts.exists ?? existsSync;
  const read = opts.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const doc = parseYaml(yamlText) as { limitations?: Limitation[] } | null;
  const entries = doc?.limitations ?? [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const id = e.id ?? '(no id)';
    if (!e.id || !e.what || !e.closes_when) {
      problems.push(`${id}: an entry needs id, what and closes_when (a limitation nobody can close is a design, not a gap)`);
      continue;
    }
    if (seen.has(e.id)) problems.push(`${id}: declared twice`);
    seen.add(e.id);
    const file = e.where?.file;
    const contains = e.where?.contains;
    if (!file || !contains) {
      problems.push(`${id}: must name where it is stated (file + contains)`);
    } else {
      const full = `${opts.repo}${file}`;
      if (!exists(full)) problems.push(`${id}: where.file does not exist (${file})`);
      else if (!read(full).includes(contains)) {
        problems.push(`${id}: ${file} no longer contains the text that states this limitation — either the statement moved (update this entry) or the limitation is gone (delete it)`);
      }
    }
    if (e.closes_when_path && exists(`${opts.repo}${e.closes_when_path}`)) {
      problems.push(`${id}: closes_when_path exists (${e.closes_when_path}) — the limitation looks CLOSED, so the entry must be DELETED (a closed limitation left in the list is a lie in the other direction)`);
    }
  }
  return problems;
}

test('the limitations inventory: every entry is stated where it says it is', () => {
  const text = readFileSync(`${REPO}docs/limitations.yaml`, 'utf8');
  const problems = checkInventory(text, { repo: REPO });
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the inventory check is not vacuous: a missing statement and a closed limitation are both caught', () => {
  const fixture = `
limitations:
  - id: a-statement-that-moved
    what: something
    where: { file: docs/adr/058-a-delivery-runs-inside-a-boundary.md, contains: "text that is not in that file" }
    closes_when: never
  - id: already-closed
    what: something closed
    where: { file: docs/adr/058-a-delivery-runs-inside-a-boundary.md, contains: "## What CI cannot verify" }
    closes_when: it happened
    closes_when_path: docs/adr/058-a-delivery-runs-inside-a-boundary.md
`;
  const problems = checkInventory(fixture, { repo: REPO });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems.join('\n'), /no longer contains the text/);
  assert.match(problems.join('\n'), /must be DELETED/);
});

test('the inventory check refuses an entry that cannot be closed or located', () => {
  const fixture = `
limitations:
  - id: nowhere
    what: a limitation with no source and no closure
`;
  const problems = checkInventory(fixture, { repo: REPO });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /needs id, what and closes_when/);
});
