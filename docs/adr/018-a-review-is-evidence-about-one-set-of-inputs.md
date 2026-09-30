# ADR-018: A Review Is Evidence About One Set of Inputs

- **Date**: 2026-09-19
- **Status**: Accepted (`review-digest.ts`, `BoardStateRecord.reviewed`/`approval`, the merge refusal)
  — **with decision 4 corrected on 2026-09-25** (see the correction note at the end: the digest
  protects the HUMAN gate, not the machine review of a previous tick)
- **Related**: ADR-013 (the deterministic reviewer), ADR-014 (resuming an incomplete delivery),
  ADR-007 (the delivery port). Inspired by the artifact-approval designs measured in `code-oz`
  (`gate_artifact_sha256_mismatch`, approvals bound to an artifact's SHA-256).

## Context

takumi's third delivery rule already refuses to merge anything but the reviewed head: the merge
re-reads the branch and will not touch a head that moved since the review. That closes the obvious
race (approve → the agent pushes again → ship anyway).

It does not close this one:

> A tick reviews a change cleanly and is interrupted before the merge. The operator edits the
> policy — say `reviewMode: rules` to `checks-only`, or the protected-path list, or the rule set.
> The next tick **resumes the delivery** (which is exactly what ADR-014 added, and exactly what
> resuming is for) and merges the OLD review under the NEW policy. Nothing anywhere says so.

The head is pinned; the **judgement** is not. An approval that names a commit but not the standard
it was approved against is evidence about half of what matters.

## Decision

1. **A clean review is bound to a digest of its inputs**: `reviewDigest({ head, base, policy,
   ruleset, reviewer })`, where `policy` hashes only the knobs that decide whether a change may
   merge (`reviewMode`, `approvalLabel`, `maxReviewRounds`, the rule options) — a digest that moved
   for a poll interval would refuse merges for no reason.
2. **The digest goes into the state record** (`reviewed{...}`), written **forcibly**: progress
   writes are throttled, evidence is not.
3. **The merge re-checks it against what the board said BEFORE this run started.** The read is
   taken at the top of the loop, not at merge time — this run overwrites the record as it goes, so
   a digest compared against our own fresh write would always agree and would check nothing.
4. **Unknown provenance is refused, not assumed fine.** A delivery on record with no `reviewed`
   block cannot merge: it predates digests or was written by another tool, and neither is evidence.
   This is fail-closed in the same direction as everything else here: re-reviewing is cheap,
   merging something the review does not describe is not.
   **[Correction, 2026-09-25] As written this fires on the common path.** See the correction note at
   the end: the refusal is now approval-centric and applies only under a human gate.
5. **The refusal is a named fact**: `review.stale`, carrying both digests and which input moved,
   plus the item moves to `blocked` with the reason. A silent re-review would also be defensible;
   a merge nobody can explain afterwards is not.
6. **A human's approval becomes a first-class record** (`approval{by, at, digest, ref}`) instead of
   "the label exists". `by` is `null` when the board gave no identity — a label says somebody
   approved, not who, and an unknown actor is never written as a known one.
7. **A malformed `reviewed`/`approval` block throws** (`BoardStateRecordError`), like every other
   present-but-corrupt block: a block we cannot read is not the same as no block, and the
   difference decides whether a delivery may merge.

## Consequences

- The `reviewMode`-flip hole is closed, and the fix is the same shape as the artifact-approval
  designs this was measured against: an approval binds to a version, and a stale version is refused
  **by name**.
- **Deliveries created before this change cannot be finished by a merge.** Their records carry no
  digest, so the resume path now refuses them — which is why the resume test asserts a refusal
  rather than a merge. That is the intended answer, not a regression: those deliveries need one
  re-review, and their records will carry a digest from then on.
- The record is fatter by two optional blocks; the versioned `schema: 1` shape was built for this.
- **Still not covered offline**: "a resumed delivery whose digest MATCHES merges". The head of a
  real delivery is unknowable in a fixture, so this is verified on the live instance instead (a
  first tick writes a digest; a second tick on the same policy must find it matching).
- **Next, and named**: the same digest discipline applied to the rule set itself when the rules
  become data (`review-rules.yml`), and the cross-family assertion (builder family != reviewer
  family) that a model reviewer will need.

**[Correction, 2026-09-25] Decision 4 was too broad, and the broadness was worse than the hole it closed.**

The rule as first written — "a delivery on record with no `reviewed` block cannot merge" — was
measured on the live instance and fails on an ordinary fix round: tick 1 reviews, finds something,
returns `fix_needed` (**no digest is written, because the review was not clean**); tick 2 fixes it,
the review is clean, and the record from tick 1 has no digest → **refused**. That refusal would land
on the common path far more often than on the rare one it targets.

What the live failure forced into the open: **every merge is already justified by the review THIS run
performed, under the policy in force now** — the loop reviews before it merges, always. A digest on
record therefore cannot justify a refusal in a machine-gated delivery at all. What a digest really
binds is the **human's approval**, given in an earlier run, which can name a head or a policy the
human never saw. The check is now approval-centric: it applies only when `reviewMode: label`, and it
refuses when the record cannot show what was presented for approval, or when that digest differs from
the one about to be merged. Under any other mode a digest is audit evidence, not grounds to refuse.

Decisions 1-3 and 6 are unchanged, and both merge rules (the head is pinned, the judgement is pinned)
now hold without refusing legitimate work. The lesson belongs to the same class as the ledger's
"a check's SCOPE is part of the check": a guard that fires on the paths it was not aimed at is not a
conservative guard, it is a broken one, and only a real run says which it is.
