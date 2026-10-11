/**
 * What a review is evidence ABOUT (ADR-018).
 *
 * A clean review is not evidence about "the code" in the abstract. It is evidence about ONE set of
 * inputs: that head, off that base, judged by that reviewer, under that policy and that rule set.
 * Change any of them and the review says nothing about what would now merge.
 *
 * This is not theoretical. The case that actually happens: a tick is interrupted between the review
 * and the merge, the operator edits `reviewMode` (say from `rules` to `checks-only`), and the next
 * tick — which resumes the delivery, because that is what resuming is for — merges the OLD review
 * under the NEW policy, with nothing anywhere saying so. The digest is what makes that refusal
 * possible, and the refusal is the whole point.
 *
 * The rule borrowed from the artifact-approval designs this was measured against (code-oz): an
 * approval binds to a VERSION, and a stale version is refused by name rather than re-derived.
 */

import { createHash } from 'node:crypto';
import { REVIEW_RULESET_ID } from './review-rules.js';

/** The reviewer that produced a verdict: a deterministic engine, so its identity is a version. */
/**
 * The deterministic reviewer's identity, DERIVED from the rule set it runs.
 *
 * This was a second hand-maintained constant (`'reviewer:rules@1'`), and the `rules@2` bump left it
 * claiming a version the reviewer no longer was: a live state record read
 * `reviewer: "reviewer:rules@1"` right beside `ruleset: "<hash of rules@2>"`. The digest's job is to
 * bind an approval to what did the reviewing, so the reviewer's name has to come from the thing that
 * defines it — two labels for one fact drift, and the drift is invisible until a human compares them.
 */
export const REVIEWER_DETERMINISTIC_RULES = `reviewer:${REVIEW_RULESET_ID}`;

/** The inputs a review covers. Everything here is a fact about the run, never a timestamp. */
export interface ReviewInputs {
  head: string;
  base: string;
  /** Hash of the review-relevant policy (see `policyHash`). */
  policy: string;
  /** Hash of the rule set actually used. */
  ruleset: string;
  /** Who judged. */
  reviewer: string;
  /**
   * The CONFIRMED requirement document this delivery implements: `requirementDigest` of its text,
   * or `NO_REQUIREMENT` when the delivery has none (ADR-025).
   *
   * A requirement is an input like any other: a review is evidence about the code THAT satisfies
   * THAT document. Editing the document after a review — adding a criterion, changing a chosen
   * option — makes the recorded review say nothing about what would now ship, and the digest is
   * what lets the next run refuse the mismatch by name instead of merging it quietly.
   */
  requirement: string;
}

/**
 * The requirement input of a delivery that has NO confirmed requirement document.
 *
 * A real value rather than an absent field: a delivery that later gains a requirement must produce
 * a different digest, and `undefined` would be indistinguishable from "the field was forgotten".
 */
export const NO_REQUIREMENT = 'none';

/**
 * The digest of a requirement document's text.
 *
 * Canonicalised before hashing (CRLF → LF, trailing whitespace at the end of the document removed,
 * exactly one trailing newline) so that an editor saving the file differently does not invalidate a
 * confirmed acceptance — while any change to what the document SAYS still does.
 */
export function requirementDigest(text: string): string {
  const normalised = `${text.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`;
  return sha256(normalised);
}

/**
 * The review-relevant policy, canonicalised.
 *
 * Only the keys that decide whether a change may merge belong here: a digest that changed when an
 * unrelated knob moved (a poll interval, a retention window) would refuse merges for no reason,
 * and a digest that ignored a relevant one is the hole this closes.
 */
export function policyHash(policy: {
  reviewMode?: string;
  approvalLabel?: string;
  maxReviewRounds?: number;
  reviewRules?: unknown;
}): string {
  return sha256(
    canonical({
      reviewMode: policy.reviewMode ?? null,
      approvalLabel: policy.approvalLabel ?? null,
      maxReviewRounds: policy.maxReviewRounds ?? null,
      reviewRules: policy.reviewRules ?? null,
    }),
  );
}

/** The rule set's identity: its version plus whatever was configured on top of it. */
export function rulesetHash(options: { protectedPaths?: readonly string[]; id?: string } = {}): string {
  return sha256(
    canonical({
      id: options.id ?? REVIEW_RULESET_ID,
      protectedPaths: options.protectedPaths === undefined ? null : [...options.protectedPaths].sort(),
    }),
  );
}

/** The digest of a review: what was judged, under what, by whom. */
export function reviewDigest(inputs: ReviewInputs): string {
  return sha256(canonical(inputs));
}

/** A digest short enough to read in a comment or an event line. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable JSON: sorted keys, no whitespace, so the same inputs always give the same digest. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
