# ADR-024: What Judges a Workflow's Review (a structured verdict, and the rules as the gate)

- **Date**: 2026-09-26
- **Status**: Accepted (`parseReviewVerdict` + the `rule_review` step type in core,
  `rule_review` wired into `jp-si-standard`, `GitRunner` injectable through
  `WorkflowExecutionContext.git`)
- **Related**: ADR-013 (the deterministic reviewer), ADR-018 (a review is evidence about one set of
  inputs), ADR-021 (the semgrep sidecar), ADR-008/009 (the pilot's safety rails), ADR-023 (bug #25's
  fail-closed gate, the sibling of this one). Ledger #26 and #27.

## Context

The delivery path (`examples/pi10/extensions/workflows/jp-si-standard`) had two steps that could stop a
delivery: `quality_gate` (a command whose output is parsed, strengthened by ADR-023/bug #25) and
`independent_review` (an LLM reading the repository and reporting). The second one decided its verdict
with:

```ts
const hasCritical = /Critical|High|重大|must fix|要修正|ng|✗|不合格/i.test(res2.summary);
```

Both directions of that were wrong, and both were observed. A real defect written as 「脆弱性」,
"broken" or 「不整合」 matched nothing, so the step was `completed` and the workflow continued. `ng`
has no word boundary, so "all tests passing" matched; `Critical` matched "No Critical or High issues
found" — a clean review aborted the delivery. A verdict read from vocabulary is chosen by the party
being judged, which makes it a coin flip dressed as a gate.

Worse, the repository ALREADY had the opposite of that check. ADR-013's deterministic rules
(`review-rules.ts`) read the real change set and emit structured severities — `test-weakening/deleted`,
`test-weakening/skipped`, `test-weakening/assertions-removed`, `protected-path`, `secret/committed` —
and they were reachable only from the PILOT path (`review.ts:createRuleReviewer`) and the semgrep
sidecar. On the path a Japanese-SI delivery actually runs, 「delete the failing test」 was unbeatable:
the only thing standing in its way was a prompt.

## Decision

1. **A verdict is a FIELD, not a reading of prose.** The reviewer emits one marker line,
   `REVIEW_VERDICT: pass|findings|blocked` (the key and value case-insensitive, `=` accepted, markdown
   decoration around the value tolerated). The marker decides the step; the prose decides nothing. A
   **missing, unknown or conflicting** marker FAILS the step — the absence of a verdict is not a pass.
2. **The prompt shows ONE marker line with a placeholder, never the option list.** A template that
   prints all three values invites a reviewer to echo all three, which is a contradiction, which fails
   closed, which is a false failure — and a gate that cries wolf gets switched off, which is worse
   than no gate (ADR-013's own rule).
3. **The deterministic rules are the GATE on the workflow path.** A first-class `rule_review` step
   resolves `baseRef`/`headRef` to SHAs, collects the change set (`collectReviewInput`) and lets the
   existing rules judge it (`runReviewRules` → `verdictFromFindings`). The strong check moves to the
   path that deploys, instead of a second check being built beside it.
4. **Two severities stop automation, for different reasons.** `block` — a defect the agent can answer
   (it weakened a test; it can put it back) — fails the step. `human` — a decision no machine may make
   and no agent may undo (a dependency manifest, CI configuration) — fails the step too: the delivery
   stops and waits for a person. Only `note` passes, rendered one line per finding so an observation
   still reaches a reader.
5. **A review that could not run is a FAILURE, never `skipped`.** No `baseRef`, an unresolvable ref, a
   directory that is not a repository, an unreadable change set: all fail the step. The manifest
   validation refuses a `rule_review` step with no `baseRef` at LOAD time, because a review with no
   base is not a review.
6. **Git access goes through the seam.** The step uses the `GitRunner` injected as
   `WorkflowExecutionContext.git` (default: the bounded async runner); it never spawns git itself, so a
   test can inject a runner that refuses and prove the step fails closed.
7. **The prose reviewer stays, as a SECOND READER — never the gate.** It runs in its isolated context
   (a separate session), its verdict is persisted as an artifact, and its marker is still required
   because a missing verdict must not read as approval. But it is the same model family as the
   implementer: it shares the implementer's blind spots, so it is a second opinion, not a check.

## Consequences

- **Verified on a real machine**, through the real CLI (`takumi run --workflow …`) rather than by
  unit test alone: a deleted test file fails with `test-weakening/deleted` and names both SHAs; an
  added `package.json` fails as `protected-path` — "a human must decide this"; a clean implementation
  change (with a strengthened test) passes; an unresolvable `baseRef` fails without running the next
  step. On the prose side: 「レビュー所見: 脆弱性あり」 + `REVIEW_VERDICT: findings` aborts, the SAME
  prose with no marker aborts (the old regex passed it), and `REVIEW_VERDICT: pass` completes.
- **The two paths no longer disagree about what a review is.** The pilot path keeps ADR-018's digest
  (head + base + policy + ruleset + reviewer in one hash, compared before merge). The workflow path now
  has the same rules, addressed by the same rule-set identity (`REVIEW_RULESET_ID`).
- **Not done, and named**: the workflow path's `rule_review` writes the base/head SHAs, the verdict and
  the findings into its artifact, but it does not yet write ADR-018's digest into a board state record —
  that binding belongs to the delivery loop, so a workflow delivery that merges through the pilot gets
  it and one that delivers directly does not. Closing that means giving the workflow path the same
  review-evidence record, and it is the next slice when a real deployment merges from a workflow.
- **A workflow can now be judged without an LLM in the loop.** With `rule_review` and the fail-closed
  `quality_gate`, the two things that can stop a delivery on that path are both deterministic; the
  reviewer's prose is advisory. That is the shape a Japanese-SI delivery needs in order to argue for
  its gate at all (ADR-013's principle: deterministic things are never handed to an LLM judge).
