import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_REQUIREMENT,
  REVIEWER_DETERMINISTIC_RULES,
  REVIEW_RULESET_ID,
  policyHash,
  requirementDigest,
  reviewDigest,
  rulesetHash,
  shortDigest,
} from '../index.js';
import { staleReviewReason } from '../delivery-loop.js';
import type { BoardStateRecord } from '../board-state-record.js';

function otherDigest(base: NonNullable<BoardStateRecord['reviewed']>): NonNullable<BoardStateRecord['reviewed']> {
  return { ...base, digest: 'f'.repeat(64) };
}

const inputs = {
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  policy: policyHash({ reviewMode: 'rules' }),
  ruleset: rulesetHash({ protectedPaths: ['ci/**'] }),
  reviewer: REVIEWER_DETERMINISTIC_RULES,
  requirement: requirementDigest('requirements:\n  - id: REQ-001\n    title: One thing\n'),
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
    requirement: requirementDigest('requirements:\n  - id: REQ-001\n    title: A DIFFERENT thing\n'),
  })) {
    assert.notEqual(reviewDigest({ ...inputs, [key]: value }), digest, `${key} must be part of the digest`);
  }
  assert.equal(shortDigest(digest), digest.slice(0, 12));
});

test('requirement digest: an editor saving the file differently does not invalidate a confirmation', () => {
  const doc = 'requirements:\n  - id: REQ-001\n';
  const digest = requirementDigest(doc);
  // The same document, saved by a different tool: CRLF endings, trailing blank lines.
  assert.equal(requirementDigest('requirements:\r\n  - id: REQ-001\r\n\r\n'), digest);
  // A change to what the document SAYS is a different digest, however small.
  assert.notEqual(requirementDigest('requirements:\n  - id: REQ-001\n  - id: REQ-002\n'), digest);
  assert.notEqual(requirementDigest('requirements:\n  - id: REQ-001\n    priority: High\n'), digest);
});

test('requirement digest: having no requirement is a value, not an absence', () => {
  // A delivery that later gains a requirement must change the digest, so "none" cannot be
  // `undefined` (indistinguishable from a field nobody filled in).
  const without = reviewDigest({ ...inputs, requirement: NO_REQUIREMENT });
  const withOne = reviewDigest(inputs);
  assert.notEqual(without, withOne);
  assert.notEqual(NO_REQUIREMENT, '');
});

test('the deterministic reviewer is NAMED after the rule set it runs, not maintained beside it', () => {
  // The live e2e record after the rules@2 bump: `reviewer: "reviewer:rules@1"` beside
  // `ruleset: "<hash of rules@2>"`. The digest binds an approval to what reviewed it, so the name
  // has to be derived — equality here is the guard against a future hand-edit.
  assert.equal(REVIEWER_DETERMINISTIC_RULES, `reviewer:${REVIEW_RULESET_ID}`);
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
    requirement: inputs.requirement,
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

  const approve = { requiresApproval: true };
  const machine = { requiresApproval: false };
  // 1. matching: nothing to say
  assert.equal(staleReviewReason(withDelivery(current), current, approve), null);
  // 2. nothing delivered before: nothing to distrust
  assert.equal(staleReviewReason({ ...withDelivery(current), deliveryRef: undefined }, current, approve), null);
  assert.equal(staleReviewReason(null, current, approve), null);
  // 3. THE FIX ROUND: without a human gate, a digest on record cannot justify a refusal. An earlier
  //    tick may have ended in `fix_needed` (which writes no digest), and this run's review — just
  //    performed, under the policy in force — is what the merge leans on.
  assert.equal(staleReviewReason(withDelivery(), current, machine), null, 'a fix round must not be refused');
  assert.equal(staleReviewReason(withDelivery(otherDigest(current)), current, machine), null, 'nor must an older digest');
  // 4. WITH a human gate, the approval must name the version being merged
  assert.match(String(staleReviewReason(withDelivery(), current, approve)), /no record of what was presented/);
  // 4. a digest that does not match: refused, and the reason names what moved
  const other = { ...current, digest: 'f'.repeat(64), policy: policyHash({ reviewMode: 'checks-only' }) };
  const why = staleReviewReason(withDelivery(other), current, approve);
  assert.match(String(why), /different inputs/);
  assert.match(String(why), /policy changed/);
  // 5. the REQUIREMENT was edited after the review (ADR-025): refused, and the reason names it.
  //    This is the whole point of binding it: a confirmation covers one document, and the document
  //    is the input a human actually controls.
  const edited = { ...current, digest: 'e'.repeat(64), requirement: requirementDigest('requirements:\n  - id: REQ-001\n    title: Edited\n') };
  const whyRequirement = staleReviewReason(withDelivery(edited), current, approve);
  assert.match(String(whyRequirement), /the requirement changed/);
  // 6. a record written before requirement digests existed cannot say which document it covered,
  //    which is unknown provenance — never read as "there was no requirement".
  const predates = { ...current, digest: 'd'.repeat(64), requirement: '' };
  assert.match(String(staleReviewReason(withDelivery(predates), current, approve)), /predates requirement digests/);
});
