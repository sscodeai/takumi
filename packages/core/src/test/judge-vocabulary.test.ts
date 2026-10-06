import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JUDGE_DECISION_MODES, JUDGE_RELATION_VOCABULARY } from '../index.js';

// The relation vocabulary (ADR-031) exists in two languages: the validator that refuses a document
// naming something no judge can check, and the shell forge that implements the checks. A drift between
// them is a document that passes the front door and is refused at the acceptance, after the
// implementation has been paid for — so the drift is a test failure instead.

const repo = new URL('../../../../', import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, repo), 'utf8');

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
