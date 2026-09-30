# ADR-015: A Delivery With No Review Surface

- **Date**: 2026-09-19
- **Status**: Accepted (`deliveries/git`, `DeliveryOutcome.pr?`, `deliveryRefFor`)
- **Related**: ADR-007 (the delivery port), ADR-013 (the deterministic reviewer), and the correction
  note appended to ADR-007 on 2026-09-19

## Context

ADR-007 built the delivery port around the thing every host so far offered: a **pull request** — a
place with a diff, checks and a merge button. It also claimed a bare git remote
(`deliveries/git`: a pushed branch, nothing to review) would need **no port change**. Measured
against the code, that was wrong: `DeliveryOutcome.pr` was required, and the three steps that
follow a delivery — `status`, `checks`, `merge` — all took a pull request reference. The first
attempt at the adapter produced 20+ compile errors, every one of them in the shared delivery
contract suite.

Two honest ways out were available, and both were lies:

1. **Invent a pull request.** A synthetic reference (`number = branch`) would have flowed through
   the loop fine — and put "opened PR #takumi/7-abc" into the event trail, the board state and the
   closing comment for a delivery where no pull request exists.
2. **Weaken the suite.** Deleting or skipping the PR-shaped assertions would have made the adapter
   compile, and quietly lowered the bar for the two adapters that DO open pull requests.

## Decision

**The port describes what a delivery IS, not what the first two hosts happened to offer.**

1. **`DeliveryOutcome.pr` is optional.** A provider declaring `canOpenPullRequest: false` reports
   no reference; `deliveryRefFor(outcome, baseSha)` yields the pull request when there is one and
   the pushed branch when there is not. The provider is never asked to invent a reference at the
   call site: it receives the branch it just pushed, which is exactly what it can answer about.
2. **The loop threads one reference through a round.** `status`/`checks`/`merge`/`waitForChecks`
   and the reviewer all use the same `ref`, whatever shape it has, so a delivery without a review
   surface takes the same path as any other.
3. **Nothing claims a pull request that does not exist.** PR-specific events are emitted only when
   there IS a pull request, the per-event `pr:` field is spread conditionally, and the trail,
   the state record and the closing comment name the branch instead.
4. **The contract suite enforces the honesty in BOTH directions**, gated on the capability (the
   pattern ADR-007 already used for `canRunChecks`/`canMerge`):
   - a provider declaring `canOpenPullRequest: false` that reports a pull request **FAILS**;
   - one declaring `true` that reports none **FAILS**;
   - the PR-shaped assertions (one pull request per delivery, reused on the second call, the
     reference points at the pushed head) apply exactly when the capability is there;
   - everything that holds regardless — a plain push, the pushed branch being the task branch,
     the head being reported, stale-head and conflicting merges refused — is asserted
     unconditionally.
5. **`deliveries/git` reads the remote back.** The head it reports is `ls-remote`'d after the push
   rather than inferred from an exit code, and a merge is a fast-forward of the base branch to
   exactly the reviewed head (a plain push; git refuses a non-fast-forward itself). `squash` and
   `rebase` are `unsupported`, not silently approximated.

## Consequences

- A delivery with no review surface is now a first-class, TESTED shape: the shared suite runs
  against a real bare remote and reports the capability-gated parts rather than skipping them.
- The `deliveries/git` provider gives takumi a delivery target that is real end to end with no
  forge at all — which is also what makes the "delivery side is real" claim checkable locally.
- **The ordering rule this cost us twice**: when a port change is blocked by a contract suite, the
  SUITE is the first file to touch, not the last. Both reverted attempts started from the loop and
  the port; the one that landed started from the suite. Recorded in the ledger's class list.
- **Still open** (deliberately, and now explicit): a delivery with no review surface has no place
  for the run marker the forge adapters write into the commit, and no `url` to comment with — the
  trail names the branch and the commit instead. If a future provider needs a marker, it belongs in
  the commit body the agent writes, not in the delivery.
