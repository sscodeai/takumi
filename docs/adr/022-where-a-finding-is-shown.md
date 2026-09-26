# ADR-022: Where a Finding Is Shown (a report surface behind a hook)

- **Date**: 2026-09-25
- **Status**: Accepted (`ReportContext` + `DeliveryLoopHooks.report` in core, `reporters/reviewdog`,
  `reporter: reviewdog` in `takumi.yaml`)
- **Related**: ADR-013/019 (what the rules find), ADR-018 (a review is evidence about one set of
  inputs), ADR-021 (the semgrep sidecar), ADR-017 (mirror boards — the same problem one layer out),
  ADR-006/007 (the ports). Measured against `reviewdog`.

## Context

By ADR-019 the reviewer could find things — a weakened test, a committed credential, anything semgrep
brings — and every one of those findings lived in exactly two places: the **event trail**, and a
one-line summary in the **board comment**. Both are ours. The person who actually reads a merge
request, the reviewer of the change, sees nothing at all.

This is the mirror-board problem (ADR-017) one level down. There, the delivery state needed to reach
people who look at Notion. Here, the FINDINGS need to reach people who look at the pull request. The
answer is the same shape: one authority (the review), N write-only projections for the people looking.

## Decision

1. **A hook, not a port.** The ports (ADR-006/007) exist for things that OWN state a run must
   coordinate with. A report surface owns nothing: the board already carries the delivery, the trail
   already carries the facts. Making it a port would put it in the delivery's critical path, where a
   comment nobody needed could hold up a merge.
2. **A report is a BYPASS, never a gate.** It is called after the verdict is known and before the item
   moves; a reporter that throws is recorded (`report.failed`) and the delivery outcome is **exactly**
   what it would have been. This is asserted, not asserted-about: the core test runs the same scenario
   with a working reporter and a broken one and requires the same outcome.
3. **Findings travel WITH the verdict** (`ReviewOutcome.findings`), so a reporter never re-derives
   what was found. A reporter that recomputes is a second source of truth about a review, which is how
   a comment and a decision come to disagree.
4. **The translation is one pure function** (`toRdjsonl`, exported): our severities back to the host's
   vocabulary (block→ERROR, human→WARNING, note→INFO), the line carried through, the rule id as the
   diagnostic's code. Anything reasoning about the report reads the same bytes we post.
5. **`-diff` is a COMMAND STRING** that reviewdog executes, so the shas are validated as hex before
   they are interpolated, and the refusal happens **before** anything runs. A reporter is not a shell —
   and a "commit" that is `; rm -rf /` is not a commit.
6. **NOT_RUN is visible, and nothing is silently dropped.** A missing binary or a non-zero exit throws.
   A finding with no path cannot be an inline comment, so it comes back as `unlocated` and the CLI
   PRINTS it: the finding still reaches the tick's output instead of disappearing because the report
   surface had nowhere to put it.
7. **Only the diff's own lines are reported** (`-filter-mode=added` by default): this is a review of a
   CHANGE, which is the same discipline as semgrep's `--baseline-commit` (ADR-021).
8. **Credentials come from the environment**, never from argv, and a test asserts no token-shaped
   string ever reaches argv.

## Consequences

- **Verified with the real binary** (reviewdog 0.21.1): a finding on a line the change did not touch is
  filtered OUT, and one on an added line is reported — the filter is exercised with the real tool.
  And through the real CLI, with a reporter configured on a host that has no reviewdog: the item is
  still `blocked` by its finding, and the trail carries `report.failed`.
- **Not done, and named**: posting to a LIVE host. reviewdog's host reporters need their own context
  (a `-conf` file with the project and merge-request ids, plus a token in the environment), and that
  wiring — and the demonstration on the GitLab e2e project — is the next step. Until then the shipped
  configuration is verified with `-reporter=local`, which exercises everything except the host call.
- **The layout bug this slice made and caught**: the first wiring put the `report` hook into the loop
  PLAN (where the loop never looks) instead of `hooks`. Every unit test still passed; the CLI test
  (reporter configured, binary absent, expecting `report.failed` in the trail) failed, because a
  configuration that reaches nothing is silent — the ledger's own class, committed in miniature, and
  the reason the wiring has a test that asserts the EFFECT and not the plumbing.
- **A model reviewer, a SARIF artifact, a Check run**: all of them are the same seam now. The report
  hook takes findings and a verdict; what a surface does with them is the surface's business.
- **ADR-017's five wiring steps remain open.** This ADR makes the mirror board MORE useful (a mirror
  can project review conclusions) without closing that gap, and saying so is the point: two bypasses
  with one of them unwired is exactly the state that looks finished from a distance.
