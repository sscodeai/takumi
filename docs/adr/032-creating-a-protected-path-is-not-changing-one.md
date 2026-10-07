# ADR-032: Creating A Protected Path Is Not Changing One

- **Date**: 2026-10-05
- **Status**: Accepted (`packages/core/src/review-rules.ts`; the `protected-path` rule; tests in
  `packages/core/src/test/review-rules.test.ts`)
- **Related**: ADR-013 (the deterministic reviewer), ADR-027 (a rule whose scope did not survive the
  path it runs on — the same shape as bug ledger #27), ADR-025 (acceptance bound to the confirmed
  document), ADR-033 (the document declares its own world), bug ledger #36

## Context

The black-box delivery path hands the implementer an EMPTY worktree and lets it choose the language,
the stack and the structure. That is the arrangement the mode is built on, and it is why the
delivery's own manifest is the delivery: on a worktree with nothing in it, a file the implementer
writes is not a modification of anything.

The deterministic reviewer (ADR-013) has a `protected-path` rule: a change to CI configuration, a
dependency manifest, a container build, or takumi's own configuration is a `human` finding — a person
decides, and the automation must not continue past it. Its subject is a CHANGE to the configuration
that builds a project that already exists; the failure it exists to stop is "quietly weaken the build"
or "revert the change the human wanted".

The first real run that got the requirement RIGHT stopped before its judge
(`/tmp/i6-delivery.log`, lines 153-158):

```
  step rule_review: failed — rule_review FAILED: a human must decide this — a machine may not decide
    it, and the automation must not continue
protected-path (package.json): this path is protected (CI configuration, dependency manifest,
  container build or takumi's own configuration): a machine must not wave it through, and an agent
  must not "fix" a legitimate change by reverting it — a human decides — this delivery waits for a
  person
  step judge_forge: skipped — skipped (dependency failed: rule_review)
  step artifact_acceptance: skipped — skipped (dependency skipped: judge_forge)
```

67 of the implementer's own tests were green and `quality_gate PASSED`, and the delivery halted
anyway — because it had written a `package.json`. As written, the rule stopped every delivery written
in a language that has a manifest, which on this path is every delivery, and its `human` severity
meant no machine could ever continue past it. This is the same shape as bug ledger #27: a rule that
was correct on the path it was written for (a delivery branch against a populated repository) and
whose scope did not survive the path it was moved to (an empty worktree the implementer fills).

## Decision

The rule distinguishes creation from change, by asking what was at the base.

1. **A protected path the change CREATES is a note, not a finding.** When nothing of the sort existed
   at the base, the create is reported inside the delivery and is non-blocking: it is how the
   implementer writes down a stack choice, and it is the delivery itself. The i7 run's
   `rule/rule_review.md` carries it as the run's one note:

   ```
   rule_review passed (1 note(s))
   - protected-path (package.json): this delivery CREATES a protected path (nothing of the sort
     existed at the base): how the implementer writes down a stack choice, reported for the human
     reading the delivery rather than treated as a change to configuration that was already there
   ```

   (`/tmp/i7-delivery.log`, lines 15, 157-158.)

2. **A protected path that existed at the base keeps `human` severity.** Modified, renamed, or
   deleted, it still stops the run and still waits for a person. The rule's original subject is
   untouched: a change to configuration that was already there is exactly what it was written to
   catch, and the severity is unchanged.

3. **The distinction is drawn from the change set's own status, not from a path name.** A create is
   `A` in the change set; a modify, rename or delete is not. Nothing about the rule is weakened for
   the populated-repository path: the older test that asserts `human` for the default (modified)
   status passes unchanged.

## Consequences

- The black-box path can now reach its judge at all. Before this, no delivery that chose a language
  with a manifest — every delivery — could pass `rule_review`, so the judge forge and the acceptance
  were unreachable on the real runtime; `/tmp/i7-delivery.log` is the first run in which they ran.
- **A created manifest is now a note, which means the human's look at it moved from a hard stop to
  the delivery bundle.** That is the right place for it on this path — the human reading the delivery
  makes the decision — but it is a real reduction in what stops the run. On a populated repository,
  where a manifest genuinely could be had, creation is a much rarer case and the note is still
  visible in the bundle and in the run summary; it is not silently dropped.
- The rule now carries a base-relative question ("did this exist before?"), so it depends on a
  resolvable base. The rule review step already fails closed when the base cannot be resolved (bug
  ledger #35), so an unresolvable base is a failed step, never a quiet downgrade of a change to a
  creation.
- **The severity is still decided by hand-written status sets, and only the CRUD shape of the
  distinction is derived.** A path that is both renamed AND edited is a rename; a path deleted and
  recreated under the same name is a create. Neither was exercised in a real run and neither is
  called out in a test as its own case. Recorded here as a limit rather than left implied.

## Evidence

- `packages/core/src/test/review-rules.test.ts` — "a protected path the delivery CREATES is a note;
  changing one that existed stays a human call": created `package.json`/`go.mod` are reported and
  non-blocking, modified/deleted/renamed are still a human's; the older test asserting `human` for
  the default (modified) status passes unchanged.
- `/tmp/i6-delivery.log`, lines 153-158: the `human` refusal that stopped the run, quoted above.
- `/tmp/i7-delivery.log`, lines 15 and 157-158: the same change set under the same rule, now one
  non-blocking note, with the run continuing to `judge_forge`, `artifact_acceptance` and
  `delivery`. The difference between the two logs is the fix, on an otherwise identical delivery.
