import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEWER_DETERMINISTIC_RULES,
  policyHash,
  reviewDigest,
  rulesetHash,
  shortDigest,
} from '../index.js';
import { staleReviewReason } from '../delivery-loop.js';
import type { BoardStateRecord } from '../board-state-record.js';

const inputs = {
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  policy: policyHash({ reviewMode: 'rules' }),
  ruleset: rulesetHash({ protectedPaths: ['ci/**'] }),
  reviewer: REVIEWER_DETERMINISTIC_RULES,
};

test('review digest: the same inputs give the same digest, and every input changes it', () => {
  const digest = reviewDigest(inputs);
  assert.equal(digest.length, 64);
  assert.equal(reviewDigest({ ...inputs }), digest, 'stable across calls and key order');
  for (const [key, value] of Object.entries({
    head: 'c'.repeat(40),
    base: 'c'.repeat(40),
    policy: policyHash({ reviewMode: 'checks-only' }),
    ruleset: rulesetHash({ protectedPaths: ['ci/**', 'deps/**'] }),
    reviewer: 'reviewer:model@x',
  })) {
    assert.notEqual(reviewDigest({ ...inputs, [key]: value }), digest, `${key} must be part of the digest`);
  }
  assert.equal(shortDigest(digest), digest.slice(0, 12));
});

test('review digest: the policy hash covers the merge-deciding knobs and nothing else', () => {
  // These all decide whether a change may merge, so they must move the digest.
  assert.notEqual(policyHash({ reviewMode: 'rules' }), policyHash({ reviewMode: 'checks-only' }));
  assert.notEqual(policyHash({ reviewMode: 'label', approvalLabel: 'ok' }), policyHash({ reviewMode: 'label', approvalLabel: 'ship-it' }));
  assert.notEqual(policyHash({ reviewMode: 'rules', maxReviewRounds: 1 }), policyHash({ reviewMode: 'rules', maxReviewRounds: 3 }));
  // An irrelevant knob has no business in it: a digest that moves for a poll interval would refuse
  // merges for no reason.
  assert.equal(policyHash({ reviewMode: 'rules' }), policyHash({ reviewMode: 'rules' }));
});

test('review digest: the rule set hash is order-insensitive and names its version', () => {
  assert.equal(rulesetHash({ protectedPaths: ['a', 'b'] }), rulesetHash({ protectedPaths: ['b', 'a'] }));
  assert.notEqual(rulesetHash({ id: 'rules@1' }), rulesetHash({ id: 'rules@2' }));
  assert.notEqual(rulesetHash({}), rulesetHash({ protectedPaths: ['a'] }));
});

test('staleReviewReason: the three answers, and no fourth', () => {
  const current: NonNullable<BoardStateRecord['reviewed']> = {
    digest: reviewDigest(inputs),
    head: inputs.head,
    base: inputs.base,
    policy: inputs.policy,
    ruleset: inputs.ruleset,
    reviewer: inputs.reviewer,
    at: '2026-09-16T00:00:00.000Z',
  };
  const withDelivery = (reviewed?: BoardStateRecord['reviewed']): BoardStateRecord => ({
    schema: 1,
    runId: 'r',
    item: 'ITEM-1',
    reviewRound: 0,
    updatedAt: '2026-09-16T00:00:00.000Z',
    deliveryRef: '#1',
    ...(reviewed === undefined ? {} : { reviewed }),
  });

  // 1. matching: nothing to say
  assert.equal(staleReviewReason(withDelivery(current), current), null);
  // 2. nothing delivered before: nothing to distrust
  assert.equal(staleReviewReason({ ...withDelivery(current), deliveryRef: undefined }, current), null);
  assert.equal(staleReviewReason(null, current), null);
  // 3. a delivery with no digest: unknown provenance, refused
  assert.match(String(staleReviewReason(withDelivery(), current)), /carries no review digest/);
  // 4. a digest that does not match: refused, and the reason names what moved
  const other = { ...current, digest: 'f'.repeat(64), policy: policyHash({ reviewMode: 'checks-only' }) };
  const why = staleReviewReason(withDelivery(other), current);
  assert.match(String(why), /different inputs/);
  assert.match(String(why), /policy changed/);
});
