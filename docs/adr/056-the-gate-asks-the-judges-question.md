# 056 — The gate asks the judge's question

Status: accepted (2026-10-12)

## Context

The intake's shape gate decides whether a document may be confirmed at all. It asked two things about the
judge: whether the document HAS a `deliverable` block (`run` plus at least one `REL-nnn` relation), and
whether it passes every rule `takumi requirement confirm --dry-run` enforces. Neither of those is the
question the judge forge asks.

On 2026-10-12 the third unattended chain (`scripts/autopilot.sh`) produced a document that passed the gate
5/5 and that the forge refused:

```
the deliverable block declares 0 output line(s) that are neither a per-id line nor a skipped line,
where exactly one totals line is needed: additivity and the independent recomputation both compare
against it
```

The document was not unusable: it declared a per-id line and a skipped line, both correct and both
judgeable. It omitted the totals line the intake prompt's own example shows. The expensive part was
where the disagreement surfaced — `judge_forge`, inside the delivery, AFTER the implementation, the
delivered tests and the quality gate had been paid for (1 047 s for that round), and then again by the
repair round, because a `repair` step retries the chain and a document does not change between attempts.
The second round's implementer, handed a failure no implementation could repair, went looking for what
could and left its worktree for this repository (docs/bugs-fixed.md #68, #69).

The gate is the only place in the chain where a document is still free to fix. It was not asking the
forge's question, so nothing was fixed there.

## Decision

**The intake's shape gate dry-forges the document, using the same forge the run itself will use, and a
refusal is a failed check.**

1. The gate runs `extensions/judges/metamorphic-forge.sh` against the document, into a scratch judge
   directory, and requires the forge's own success marker (`JUDGE_FORGE: ok`). It runs the forge — not a
   re-implementation of its rules and not a copy of its vocabulary — so the two cannot drift: a rule
   added to the forge is enforced by the gate the same day, and nothing is maintained twice.

2. The document is forged **as the confirmation will leave it**, not as the intake wrote it: every
   decision that has no `chosen:` is answered with its own `default:` first. The forge derives its
   fixtures from `chosen` (ADR-028) and the intake is forbidden to write it (rule 4b), so forging the raw
   intake document would refuse every document in the chain for a reason that is not about the contract
   at all. Materialising the `default:` is what the confirmation does on the unattended path, and it is
   what the human is offered as a bounded choice.

3. `TAKUMI_WORKTREE` is a scratch directory, deliberately: forging takes the document alone (ADR-026) and
   no implementation exists yet. The forge refuses a judge that hard-codes the worktree it was told
   about, so a scratch path is the honest input and a real one would be a lie.

4. The refusal is reported with the forge's own words, so the failing check says what could not be
   implemented rather than that something went wrong.

## Consequences

- A document no judge can be forged from costs the chain ~2 s instead of ~35 minutes. Measured on the
  real document from that run: the gate exits 1 with the forge's refusal verbatim, while its other five
  checks still pass.
- The gap between "the gate passed it" and "a judge can be built from it" is closed by construction
  rather than by keeping two lists in step — which is the failure mode a hand-maintained vocabulary list
  would have reintroduced.
- The gate needs the forge to be present and runnable in the project (`extensions/judges/`), and it now
  takes ~2 s more per intake run. A missing forge is a failed check, not a silent pass.
- **A gate is not a wall, and the second half of the test is the one that matters**: the document the
  forge accepts must still pass. It also caught a real fragility — `intake-prechosen.test.ts` used
  `docs/requirements/intake.yaml` as its fixture, a path the chain REWRITES on every run, so it asserted
  "the gate passes this document" about whatever the last agent happened to write. It now uses a
  committed, forgeable document.
- The intake prompt's rule 9 now states the totals-line requirement instead of only showing one in its
  example: the gate can refuse a document, but the intake should not produce one that needs refusing.
- Two properties this ADR does NOT fix, named rather than implied: an agent step in
  `request-to-delivery-attempt` declares no `timeoutMs`, so a wandering round spends without limit; and a
  `repair` round is still entered for a document-level refusal, which no implementation can repair
  (docs/bugs-fixed.md #68).
