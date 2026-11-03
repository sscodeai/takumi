# An unattended run, end to end, after the format and document fixes

Measured 2026-11-03/04, run `wf-ef7bfae2`.

## The run

Request: a command-line tool that reads `suite,passed,total` and prints a pass percentage per suite.

```
intake                accepted on the FIRST attempt (previous runs needed two)
ambiguity_confirmation approved
place_document        the confirmed document written into the worktree and committed
ci_config             pipeline written
implementation        the tool built
quality_gate          PASSED
worktree_clean        PASSED
rule_review           passed
judge_forge           forged, sha256:812f8a7d2d46
artifact_acceptance   PASSED (4 checks ok) — ACCEPT-001 written
publish               PR #72 opened
await_checks          all 4 checks succeeded after 30s
merge                 MERGED, head 500feff912
== delivered
```

No human step between the request and the merge.

## What landed

`sscodeai/takumi-delivery-demo` `main`, `docs/requirements/intake.yaml`:

```
source: "'The CSV has a header row with columns: suite, passed, total.'"
columns: "suite:id,passed:measure,total:other"
relation: derived-ratio
```

The document the confirmation licensed is the document in the repository — the `region:id,amount:measure`
that a previous request had left at that path is gone.

## The six defects that had to be fixed to get here

Each was found by a real run, not by a test, and each has a ledger row and a test:

| run failed on | fixed by |
|---|---|
| the worktree held a DIFFERENT document at the same path | #120 place the confirmed document (and #122: its digest is takumi's canonical digest, not `sha256sum`) |
| an uncommitted file found only at publish | #106 worktree_clean |
| a declared entry point that did not exist, found only by the judge | #118 worktree-ready.sh |
| the field model chosen inside a 400-line prompt | #102, #107, #121 — decisions moved into the 60-line shape step |
| `# checks 91` / `# failed 0` unreadable by the gate | #124 parseTap accepts the synonyms and counts the `ok` lines |
| `row-order-invariance` refused on a ratio document, and unable to fail when admitted | #110, #111 |

## What this establishes

An unattended request can reach a merged pull request with the correct document, a forged judge that
passes it, and the host's pipeline green — on a delivery repository whose `main` already held other
requests' work.

## What it does not establish

This is **one** run of **one** request shape. The measured first-attempt intake rate is still 1 in 3
(`docs/measurements/intake-rate-2026-10-29.md`), so an unattended run should still be expected to cost
about three attempts' worth of time for two of every three requests. `docs/limitations.yaml` keeps
`intake-reliability` for exactly that reason, and the four remaining entries are unchanged.
