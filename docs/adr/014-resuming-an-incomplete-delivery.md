# ADR-014: Resuming an Incomplete Delivery

- **Date**: 2026-09-19
- **Status**: **Accepted and implemented** (2026-09-19) for the part described under "Decision":
  the record's branch, the two-kind selection, the worktree checked out on the resumed branch and
  the agent skipped. **Still open**: the PR-less delivery seam (a bare remote has no reference to
  resume against) and the milestone-scope question — both belong to `deliveries/git`, which is why
  this ADR is not closed by this slice.
- **Related**: ADR-007 (delivery port), ADR-009 (the pilot), the ledger's #14 and #15

## Context

The pilot selects `ready` work. Everything after the claim — the pushed branch, the open merge
request, a review waiting on a human, a merge that a transient host hiccup interrupted — lives in
board states (`pr_open`, `claimed`) that **no tick selects again**.

Two real runs produced this, on the same afternoon:

- A delivery reached `pr_open` with a mergeable merge request and then hit a network failure
  (`gnutls_handshake() failed`) inside `git fetch`. The run was classified `transport` and the
  item was blocked — correct, but the delivery it had already pushed was left for a human.
- A delivery reached `pr_open`, the host answered "mergeability not computed yet", and the run
  returned `retriable` — leaving a finished, reviewed delivery in `pr_open` where nothing looked
  at it again (fixed in #15 by blocking visibly instead, which is a mitigation, not a resume).

Today the only way forward is a human editing the board, and that path has a cost: the item goes
back to `ready`, so a runner **re-runs the agent** and pushes a SECOND branch and a second merge
request for work that was already done and reviewed. The board then has to explain two MRs for
one item, and a human has to close one.

`sweepInFlight` already reports the situation (`pilot.in_flight: pr_open for 1447s (run …)`), so
this is not an invisible problem — it is an unfinished one.

## Decision (proposed)

**A tick may resume a delivery it already started, instead of starting over.**

The loop gains an explicit resume entry point:

1. **Selection.** In addition to `ready` items, the pilot considers items whose board state is
   `pr_open` *and* whose state record names a run that no longer holds the item (the same
   evidence the claim rule uses: no live runner holds it) *and* whose record carries a
   `deliveryRef`. `awaiting_review` items are NOT resumed — there a human is the next actor,
   which is a decision, not a stall.
2. **Resume, do not rebuild.** The plan carries `resume: { branch, deliveryRef }`. The loop skips
   worktree creation, the agent, and `deliver()` — the head already exists — and re-reads the
   delivery's own view of it (`status()`), then runs the existing pipeline: checks → review →
   merge **exactly the head the review covered**.
3. **The head is re-read, never assumed.** The record does not carry a head sha on purpose: a
   resumed run must ask the host what the merge request points at *now*, because the whole point
   of the frozen-head rule is that no run may trust a remembered commit.
4. **Duplicate-delivery protection comes first.** Merging the same change twice must be
   impossible: the resume path refuses when the delivery's status already reads `merged`, and the
   transition table already refuses an illegal move out of `merged`.
5. **Bounded again.** A resume that finds nothing to do (the branch is gone, the MR was closed by
   a human) ends as `blocked` with the reason — never as a silent no-op.

## Open questions (why this is proposed, not accepted)

- **A delivery surface with no merge request.** `DeliveryRef` is PR-shaped today (see the ADR-007
  correction). Resuming a bare-remote delivery needs the same ref generalization that
  `deliveries/git` needs — so the two slices touch the same seam and should probably land together.
- **A human's intent is not in the record.** If a human parked an item at `pr_open` deliberately
  (waiting for a colleague's review), a resume tick must not decide it is time to merge. The
  review hook's `awaiting-human` verdict is the mechanism that already covers this, and the resume
  path must go through it rather than around it.
- **Where the worktree comes from.** The rules reviewer reads the change set from a worktree. A
  resumed delivery's worktree may be pruned (`retainWorktreesHours`), so the resume path has to
  read the diff from a checkout that has both commits — the repository itself, after fetching the
  branch.
- **Whether the resumed unit should be a full tick or a second phase.** A resume is not "one item
  per tick" in the same shape as a fresh delivery, and ADR-009's scheduling contract (one tick,
  one item, one decision) should stay intact.

## Addendum (2026-09-25, measured on a live resumed delivery)

Round 0 of a resumed run now reports `agent.skipped` and runs no agent, because the work it would do
is already committed on the branch: the first live label-mode resume showed the trail announcing
`agent.started` / `agent.finished` for a tick whose branch history contained no commit it could have
made. The fix (`1ba710b`) is a `resumed` flag on the loop plan plus one new event kind, so the record
says `skipped` where nothing was skipped by accident. A LATER round of the same run — the fix round
after findings — still runs the agent: that work does not exist yet.
