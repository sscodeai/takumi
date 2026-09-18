import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_TERMINAL_STATES,
  BOARD_TRANSITIONS,
  BOARD_WORK_ITEM_STATES,
  BoardStateError,
  assertTransition,
  canTransition,
  isBoardWorkItemState,
  isTerminalState,
} from '../board-state.js';
import type { BoardWorkItemState } from '../board-state.js';

// The delivery state model is the part every adapter shares, so it is tested
// directly here rather than only through an adapter.

test('states: the six delivery states are stable and ordered', () => {
  assert.deepEqual([...BOARD_WORK_ITEM_STATES], ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked']);
});

test('transitions: the happy path is allowed', () => {
  assert.equal(canTransition('ready', 'claimed'), true);
  assert.equal(canTransition('claimed', 'pr_open'), true);
  assert.equal(canTransition('pr_open', 'merged'), true);
});

test('transitions: the review/fix loop stays on the same item', () => {
  assert.equal(canTransition('pr_open', 'fix_needed'), true);
  assert.equal(canTransition('fix_needed', 'pr_open'), true);
});

test('transitions: merged and blocked are terminal for the automated machine', () => {
  assert.deepEqual([...BOARD_TERMINAL_STATES], ['merged', 'blocked']);
  for (const state of BOARD_TERMINAL_STATES) {
    assert.equal(BOARD_TRANSITIONS[state].length, 0);
    assert.equal(isTerminalState(state), true);
    for (const target of BOARD_WORK_ITEM_STATES) {
      assert.equal(canTransition(state, target), false, `${state} → ${target} must not be automated`);
    }
  }
});

test('transitions: skipping a step is illegal (no silent fast-forward)', () => {
  assert.equal(canTransition('ready', 'merged'), false);
  assert.equal(canTransition('ready', 'pr_open'), false);
  assert.equal(canTransition('claimed', 'merged'), false);
  assert.equal(canTransition('claimed', 'fix_needed'), false);
});

test('transitions: a state never transitions to itself', () => {
  for (const state of BOARD_WORK_ITEM_STATES) {
    if (isTerminalState(state)) continue;
    assert.equal(canTransition(state, state), false, `${state} → itself must be illegal`);
  }
});

test('assertTransition: throws BoardStateError naming both states and the allowed set', () => {
  assert.doesNotThrow(() => assertTransition('ready', 'claimed'));

  let thrown: unknown;
  try {
    assertTransition('merged', 'claimed');
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof BoardStateError);
  const err = thrown as BoardStateError;
  assert.equal(err.from, 'merged');
  assert.equal(err.to, 'claimed');
  assert.match(err.message, /illegal board transition merged → claimed/);
  assert.match(err.message, /terminal/);

  // An illegal non-terminal transition reports the allowed targets.
  let thrown2: unknown;
  try {
    assertTransition('ready', 'merged');
  } catch (e) {
    thrown2 = e;
  }
  assert.ok(thrown2 instanceof BoardStateError);
  assert.match((thrown2 as BoardStateError).message, /allowed from ready: claimed/);
});

test('assertTransition: a detail string is appended for diagnostics', () => {
  try {
    assertTransition('blocked', 'ready', 'a human re-labels the item');
    assert.fail('expected a BoardStateError');
  } catch (e) {
    assert.ok(e instanceof BoardStateError);
    assert.match(e.message, /a human re-labels the item/);
  }
});

test('isBoardWorkItemState: guards untrusted board vocabulary', () => {
  assert.equal(isBoardWorkItemState('ready'), true);
  assert.equal(isBoardWorkItemState('done'), false);
  assert.equal(isBoardWorkItemState(undefined), false);
  assert.equal(isBoardWorkItemState(3), false);
});

test('every declared state has a transition entry (table stays total)', () => {
  for (const state of BOARD_WORK_ITEM_STATES) {
    assert.ok(Array.isArray(BOARD_TRANSITIONS[state]), `${state} must have a transition entry`);
    for (const target of BOARD_TRANSITIONS[state]) {
      assert.ok(
        (BOARD_WORK_ITEM_STATES as readonly BoardWorkItemState[]).includes(target),
        `${state} → ${target}: target must be a declared state`,
      );
    }
  }
});
