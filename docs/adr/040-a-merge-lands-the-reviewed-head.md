# ADR-040: A merge lands the reviewed head

Status: accepted (implemented; `packages/core/src/test/merge-step.test.ts`,
`extensions/workflows/request-to-delivery/workflow.yaml`)
Related: ADR-007 (the delivery port), ADR-025 (a confirmed requirement and an acceptance bound to it),
ADR-034 (a refused delivery is repaired before it is returned), ADR-037 (a run publishes through a provider
it was handed)

## Context

ADR-037 gave the black-box path a host-side half: `publish` pushes the committed branch and opens exactly one
pull request, and `await_checks` waits for the host's own pipeline on the published head, failing closed when
that pipeline is red or still pending. The chain could therefore *describe* a delivery a person would
recognise — a branch, one pull request, an issue that records what was asked, a pipeline result the run
actually waited for — and then stop.

Nothing LANDED it. The port has had `merge(ref, { expectedHeadSha, method })` with an exact-head guard since
ADR-007, and the loop driver (`delivery-loop.ts`) already merges on the board path, but no workflow step ever
called it: every run of `request-to-delivery` ended at "an open pull request", with the pipeline green and the
work still unlanded. The last mile was missing.

## Decision

1. **The last mile is a STEP, not the loop.** The loop and the workflow are different drivers of the same
   port: the loop claims a board item and merges on its own schedule, while the workflow is a declared DAG
   that must be able to say *structurally* "only after the pipeline went green". A `merge` step is what lets
   `dependsOn: [await_checks]` mean that: a red or pending pipeline fails `await_checks`, and the engine's
   dependency rule then SKIPS the merge — nothing is landed on a pipeline that did not pass, and the skip is
   an engine fact rather than a check the step could be argued out of. (The loop's own merge is unchanged;
   this is the same invariant expressed where the workflow path can reach it.)
2. **The reviewed head is the only mergeable head.** The step merges exactly the commit the acceptance
   judged — `vars.acceptedHead`, set by the `acceptance` step when it passes — and refuses when that head
   cannot be determined at all. Two independent guards, both required:
   - the reviewed head is passed to the port as `expectedHeadSha`, so the HOST refuses a moved head. This is
     the port's own contract rule and it is proven live: a stale head against a real Forgejo returned
     `409 head out of date` — a guard a client bug cannot bypass.
   - the pull request's CURRENT head is read from `status(ref)` and compared to the reviewed head BEFORE any
     merge call, naming both SHAs when they differ. A green pipeline on one commit says nothing about
     another, and a merge of a different head is exactly the failure this whole layer exists to prevent; the
     step refuses in its own code rather than trusting the host to be the only guard.
3. **The reference and the head are not manifest fields.** The pull request merged is the one THIS RUN
   published (`vars.deliveryRef`, set by `publish`) and the commit merged is the one the acceptance judged.
   The step declares only its method (`mergeMethod`: `merge`, `squash`, `rebase`; default `merge`). A manifest
   that could name a pull request or a head would be a manifest that could land a commit nobody reviewed, so
   there is deliberately no such field — a refusal is better than a field that can only be misused.
4. **`merged: false` is a failure.** The step reads what the provider actually returned. A provider that
   reports it did not merge, or that reports a different commit than the reviewed head, FAILS the run: a merge
   that did not happen must never be reported as one, and the port requires the merged commit to be the
   reviewed head. On success the summary names the method, the head and the URL the provider returned, an
   artifact records the same, and `vars.deliveryMerged`/`mergedHead`/`mergedRef` let a later step know the
   delivery landed without reading prose.
5. **The fact crosses the sub-workflow boundary.** The acceptance that judges a delivery runs inside the
   `request-to-delivery-attempt` sub-workflow that a `repair` step drives, while `merge` runs in the parent.
   `WorkflowRunResult` therefore carries the run's final `vars`, and the repair loop lifts `acceptedHead` from
   the accepted sub-run into the run that invoked it. Without this a `merge` after a `repair` could not say
   which commit it was landing, and would refuse every time.

## Consequences

- The black-box path can now finish where a person expects work to land: the branch is merged, and the commit
  merged is the one that was judged and whose pipeline went green.
- A host that cannot merge (`capabilities.canMerge === false`) is reported by the port as `unsupported` and
  fails the run loudly, rather than being papered over as a delivery that landed.
- A red or pending pipeline skips the merge structurally (via `dependsOn`), so the failure that stops the run
  is the pipeline's, named by `await_checks`, and never a merge the step should not have attempted.

## What this does NOT license

- **It does not verify the pipeline itself.** `merge` trusts that `await_checks` passed because the engine
  makes it depend on that step; it re-reads the pull request's HEAD, never its checks. If `await_checks` did
  not run, the merge is skipped, not made to double as a pipeline gate.
- **It does not re-review.** The acceptance is the review. The merge adds no judgement about the code; it only
  decides *whether it may land the commit that was already judged*, and refuses if that commit is not the one
  the host would merge.
- **It lands exactly one commit.** Not a batch, not a merge train, not "the branch as it stands": the reviewed
  head, and only when the pull request still points at it. Two heads, one judged and one not, is not a
  situation this step resolves — it refuses.

## Evidence

- `merge-step.test.ts` (13 tests) driving the REAL engine with a stub provider and a real git worktree fixture,
  as `publish-step.test.ts` does: the accepted head is merged and the summary/artifact name the
  method/head/url; the method defaults to `merge` and a declared `squash` is passed through; the PR's current
  head differing from the reviewed head is refused BEFORE the merge call (the provider's `merge` was never
  called); a host that refuses a moved head fails the run naming both SHAs; `merged: false` fails the run; an
  undeterminable reviewed head refuses without even reading `status`; no provider fails; no published
  reference fails; a throwing `status()` fails; a failed `await_checks` SKIPS the merge (asserted, not
  assumed); and the head a `repair` sub-run accepted reaches the parent and is merged. A manifest with a
  method no host implements is refused at load.
- The port's exact-head guard itself is proven in `packages/delivery-forgejo` and by a live run against the
  operator's self-hosted Forgejo (ADR-037): a STALE-head merge was refused by the host with `409 head out of
  date`. This step is what puts that guard on the workflow path.
