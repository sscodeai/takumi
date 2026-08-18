import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort } from '../workflow.js';
import type { WorkflowStep } from '../workflow.js';

test('topoSort: sequential steps keep declaration order', () => {
  const steps: WorkflowStep[] = [
    { id: 'a', type: 'agent' },
    { id: 'b', type: 'agent' },
    { id: 'c', type: 'approval' },
  ];
  assert.deepEqual(topoSort(steps), ['a', 'b', 'c']);
});

test('topoSort: respects depends_on (parallel steps ordered by deps)', () => {
  const steps: WorkflowStep[] = [
    { id: 'impl', type: 'agent', dependsOn: ['design'] },
    { id: 'design', type: 'agent' },
    { id: 'review', type: 'agent', dependsOn: ['impl'] },
  ];
  const order = topoSort(steps);
  assert.ok(order.indexOf('design') < order.indexOf('impl'));
  assert.ok(order.indexOf('impl') < order.indexOf('review'));
});

test('topoSort: throws on cycle', () => {
  const steps: WorkflowStep[] = [
    { id: 'a', type: 'agent', dependsOn: ['b'] },
    { id: 'b', type: 'agent', dependsOn: ['a'] },
  ];
  assert.throws(() => topoSort(steps), /cycle/);
});

test('topoSort: throws on unknown dependency', () => {
  const steps: WorkflowStep[] = [{ id: 'a', type: 'agent', dependsOn: ['ghost'] }];
  assert.throws(() => topoSort(steps), /unknown step/);
});