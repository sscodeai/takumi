# ADR-021: A Sidecar Reviewer (semgrep, behind the review seam)

- **Date**: 2026-09-25
- **Status**: Accepted (`reviewers/semgrep`, `reviewer: semgrep` in `takumi.yaml`, ADR-018's
  `reviewer` field in the plan)
- **Related**: ADR-013 (the deterministic reviewer), ADR-018 (a review is evidence about one set of
  inputs), ADR-019 (a committed credential), ADR-006/007 (the ports). Measured against
  `reviewdog`/`semgrep` before adopting either.

## Context

ADR-013 built a reviewer out of rules: pure functions over the change set, exhaustible by tests, with
a failure mode that is a fact about the diff rather than a mood. It found two things CI cannot — a
weakened test (ADR-013) and a committed credential (ADR-019) — and it will never find the third
thing, because every new rule is code we have to write and maintain.

`semgrep` is the opposite trade: a rule LANGUAGE plus a large corpus of community rules, so "does this
change introduce an insecure pattern" stops being our maintenance burden. It costs a ~333MB toolchain,
its own release cadence, and a rule corpus that changes under whoever consumes it.

The interesting decision is therefore not "should we run semgrep" but **what kind of thing it is in
this system**, because the answer decides what happens on the day it is missing, old, or configured
differently than someone remembered.

## Decision

1. **It is a PROCESS behind the existing review seam, not a dependency and never a git submodule.**
   A submodule puts someone else's release into our tree; a dependency puts it into our build. A
   process boundary keeps the judge replaceable, auditable and — crucially — ABSENT, which the build
   has to be able to represent. `reviewers/semgrep` is a workspace package whose only job is
   translation: argv in, findings out.
2. **Absence is a refusal, not a smaller build.** A missing binary, a non-zero exit, output that is
   not JSON, a JSON body without `results`, a non-empty `errors` array (semgrep's own per-target
   failures — a partial scan), or more findings than the configured cap: each throws
   `ProviderError('transport'|'precondition')`, the loop retries, and **nothing merges**. There is no
   configuration in which this reviewer's answer is "clean" without having run.
3. **There is no `--config auto`.** That form fetches a rule set over the network at review time and
   reports usage. The rule set that judges a merge is pinned **in the repository it judges**
   (`reviewers/semgrep/rules/takumi.yml`), its content hash is part of the reviewer's identity, and a
   rule file edited while a reviewer instance is alive is refused rather than applied
   (`precondition`): the review would judge by a standard its own identity does not name.
4. **The engine can be pinned, and a mismatch fails closed.** `expectedVersion` turns "we reviewed
   with semgrep 1.177.0" into something the reviewer can check; a different version is a different
   interpreter of the same rules, so it is not the reviewer the identity names.
5. **The severity translation lives in ONE table and is documented.** `ERROR -> block`,
   `WARNING -> human`, `INFO -> note`. An unknown severity from a newer tool is treated as a
   JUDGEMENT (`human`), never as a gate: a tool must not be able to start blocking deliveries by
   inventing a level through our translation.
6. **The sidecar composes; it does not replace.** The built-in deterministic rules still run unless
   `composeDeterministic: false`. semgrep knows nothing about a weakened test, and an integration that
   traded one reviewer's coverage for another's would be a downgrade wearing an upgrade's clothes.
   The identity says which of the two ran: `reviewer:rules@2+semgrep:<hash>`.
7. **The reviewer's identity is recorded.** `plan.reviewer` (bug #19) carries it into the review
   digest, so an approval binds to the judge that actually ran. Without that fix, wiring a sidecar
   would have written `reviewer:rules@2` into every record it produced.

## Consequences

- **Measured, not assumed** (this host, semgrep 1.177.0): the scan of a two-file change with
  `--baseline-commit` takes ~1.7s; exit code is **0 whether or not findings were produced**, so the
  JSON is the signal and a non-zero exit means the tool could not do its job (a missing rule set exits
  7); the pinned rule set finds a committed `AKIA…` key with its line, and the CLI's end-to-end test
  (`runOnce (REAL semgrep)`) drives an agent that commits one, then asserts the item is **blocked**,
  the exit code is 1, and the finding names `semgrep:…aws-access-key` in the event trail.
- **The price is paid in the right currency**: 333MB per host and a hard dependency for every
  `reviewer: semgrep` delivery. The alternative is worse in this system: unverified merges that look
  verified. A host without semgrep does not quietly merge — it stops, which is visible.
- **`--baseline-commit` is what makes this a review of the CHANGE.** Pre-existing findings are not
  this delivery's doing, and re-reporting them every round buries the finding that is new. Offline the
  direction is pinned (a change that ADDS a violation is reported); the discrimination on a repository
  with pre-existing findings is not yet covered by a test, and is named here rather than implied.
- **Named, not solved: inline suppression.** semgrep honours `# nosemgrep`. An agent that adds one to
  the reviewed diff is silencing its own judge, which is the "agent must never be able to write a
  suppression" rule that has no implementation yet. It belongs in the deterministic rules (they read
  the diff, and `nosemgrep` in an ADDED line is a fact about the change), and it is the next rule.
- **A cap, not a truncation**: more findings than `maxFindings` (default 100) is a refusal, because a
  report that stops early and a report that found 100 things are indistinguishable afterwards.
- **Two reviewers, one verdict**: the composition happens inside the reviewer, so the loop still sees
  one `ReviewOutcome`. A future reviewer (a model, a linter) plugs into the same place, and the
  fail-closed posture and the identity discipline are already there.
