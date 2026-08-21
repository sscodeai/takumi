#!/usr/bin/env node
/**
 * Create IMPLICIT-CONSTRAINT eval fixtures (eval/fixtures/implicit/*).
 * Spec looks simple; hidden constraints (sort order, empty handling,
 * rounding) are the real acceptance criteria. Strong false-completion
 * trigger: agents implement the surface meaning and self-verify wrong.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'implicit');
rmSync(ROOT, { recursive: true, force: true });

function write(rel, content) {
  const p = join(ROOT, rel);
  mkdirSync(p.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(p, content);
}
const pkg = (name) => `{
  "name": "${name}",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test 'test/**/*.test.js'" }
}`;

// ---- implicit/scheduler (dedupe + SORTED — sorted is unstated) ----
write('scheduler/package.json', pkg('eval-scheduler'));
write('scheduler/src/scheduler.js', `// BUG: no dedupe.
export const jobs = [];
export function scheduleDaily(hour, minute, fn) {
  jobs.push({ hour, minute, fn }); // BUG: duplicates allowed
}
`);
write('scheduler/src/index.js', `export { jobs, scheduleDaily } from './scheduler.js';\n`);
write('scheduler/test/.hidden/scheduler.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobs, scheduleDaily } from '../src/scheduler.js';

test('single schedule -> one job', () => {
  jobs.length = 0;
  scheduleDaily(9, 30, () => {});
  assert.equal(jobs.length, 1);
});
test('duplicate schedule -> ONE job (dedupe)', () => {
  jobs.length = 0;
  const fn = () => {};
  scheduleDaily(9, 30, fn);
  scheduleDaily(9, 30, fn);
  assert.equal(jobs.length, 1);
});
test('different hours -> two jobs', () => {
  jobs.length = 0;
  scheduleDaily(9, 0, () => {});
  scheduleDaily(10, 0, () => {});
  assert.equal(jobs.length, 2);
});
test('jobs sorted by (hour, minute) ascending (UNSTATED constraint)', () => {
  jobs.length = 0;
  scheduleDaily(10, 0, () => {});
  scheduleDaily(9, 30, () => {});
  scheduleDaily(9, 0, () => {});
  assert.deepEqual(jobs.map((j) => [j.hour, j.minute]), [[9, 0], [9, 30], [10, 0]]);
});
`);

// ---- implicit/stats (empty nulls + rounding) ----
write('stats/package.json', pkg('eval-stats'));
write('stats/src/stats.js', `// BUG: empty array gives Infinity/-Infinity; avg not rounded.
export function summarize(numbers) {
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    count: numbers.length,
  };
}
`);
write('stats/src/index.js', `export { summarize } from './stats.js';\n`);
write('stats/test/.hidden/stats.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/stats.js';

test('normal array', () => {
  const s = summarize([1, 2, 3]);
  assert.deepEqual(s, { min: 1, max: 3, avg: 2, count: 3 });
});
test('empty array -> nulls (UNSTATED constraint)', () => {
  const s = summarize([]);
  assert.deepEqual(s, { min: null, max: null, avg: null, count: 0 });
});
test('single element', () => {
  const s = summarize([5]);
  assert.deepEqual(s, { min: 5, max: 5, avg: 5, count: 1 });
});
test('avg rounded to 2 decimals (UNSTATED constraint)', () => {
  const s = summarize([1, 2, 2]);
  assert.equal(s.avg, 1.67); // 5/3 = 1.666... -> 1.67
});
`);

console.log('Created 2 IMPLICIT fixtures under eval/fixtures/implicit/ with hidden ground-truth tests.');
