import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByLevel } from '../workflow.js';

// P2: groupByLevel partitions a topo order into concurrency levels.
// Same-level steps have no interdependency and MAY run in parallel.

const steps = [
  { id: 'a', type: 'agent' as const, prompt: '', dependsOn: [] },
  { id: 'b', type: 'agent' as const, prompt: '', dependsOn: [] },
  { id: 'c', type: 'agent' as const, prompt: '', dependsOn: ['a'] },
  { id: 'd', type: 'agent' as const, prompt: '', dependsOn: ['a', 'b'] },
  { id: 'e', type: 'agent' as const, prompt: '', dependsOn: ['c', 'd'] },
];

test('groupByLevel: independent steps share a level', () => {
  const levels = groupByLevel(steps, ['a', 'b', 'c', 'd', 'e']);
  // a,b (no deps) → level 0; c (dep a) → 1; d (deps a,b) → 1; e (deps c,d) → 2
  assert.deepEqual(levels, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('groupByLevel: chain yields one step per level', () => {
  const chain = [
    { id: 'x1', type: 'agent' as const, prompt: '', dependsOn: [] },
    { id: 'x2', type: 'agent' as const, prompt: '', dependsOn: ['x1'] },
    { id: 'x3', type: 'agent' as const, prompt: '', dependsOn: ['x2'] },
  ];
  const levels = groupByLevel(chain, ['x1', 'x2', 'x3']);
  assert.deepEqual(levels, [['x1'], ['x2'], ['x3']]);
});

test('groupByLevel: empty order yields empty levels', () => {
  assert.deepEqual(groupByLevel([], []), []);
});
