# 057 — The intake is repaired, not thrown away

Status: accepted (2026-10-12)

## Context

In the four unattended chains run on 2026-10-12, **three** produced a requirement document the machine
contract refused, each for a different reason: a missing totals line (docs/bugs-fixed.md #69), six
decisions over the budget of five (#70), and blocking decisions no relation exercised. Every one of them
cost the whole run.

Two things were wrong, and only one of them was the intake's:

1. `retry` was declared on the AGENT step while the shape gate was a SEPARATE step. A bad sample
   therefore failed the gate with nothing left to retry: the agent step had succeeded (it wrote a
   document), and the only thing that could fix the document was never asked again. The delivery already
   had the right shape — a `repair` step around a sub-workflow, whose next attempt is told exactly which
   checks failed (ADR-034) — and the intake did not.

2. In the repair loop, the brief came only from a step of type `acceptance`, and an acceptance is
   SKIPPED while any step it depends on fails. So the round after an upstream refusal was handed "a judge
   which reported nothing has told you nothing" while the run log named the failing check — and the third
   chain's implementer, told to repair a failure no implementation could touch, left its worktree and
   edited the platform itself (#68).

## Decision

**The intake is a repair round over its own sub-workflow, and a failure no implementation can repair ends
the loop instead of spending it.**

1. `extensions/workflows/intake-attempt/` holds one attempt: `req_intake` (agent, `produces` the
   document, 15-minute bound) then `intake_shape` (the gate, ADR-056). `request-intake` runs it with
   `type: repair`, `maxRounds: 2`, and the confirmation depends on the attempt. A bad sample costs one
   more attempt instead of the run.

2. The agent's prompt carries `{repairFailures}`: empty on the first attempt, the gate's own failing
   checks on the next. The instruction is to repair the DOCUMENT and never the contract — no dropping a
   real question to fit a budget, no weakened criteria, no invented `chosen:`.

3. In the engine's repair loop, the brief comes from **the step that failed** when the acceptance never
   ran: a judge that reported nothing has told the implementer nothing, but the step that refused has said
   exactly what is wrong.

4. A failure of a `judge_forge` step ENDS the loop. It derives the judge from the CONFIRMED DOCUMENT,
   which does not change between attempts, so another round can only spend — measured: 1 047 s to fail
   identically. The run fails closed and names the step and its reason.

5. The delivery's agent steps declare bounds (`implementation` 1 800 000 ms, `unit_and_integration_tests`
   900 000 ms), so a wandering round cannot spend without limit.

## Consequences

- A fluctuation in the intake — which is the least reliable agent in the chain, by measurement — now
  costs ~2 minutes of repair rather than the whole run.
- The brief an attempt receives is always something the run can point at, so "try again" is never an
  unexplained retry.
- One class of run no longer reaches the delivery at all: a document no judge can be forged from is
  refused at the gate (ADR-056), and the document-level refusal that used to be retried as if it were an
  implementation defect now stops the chain.
- The declared bound on a step is now honest about the PROCESS too: the bound's timer is cleared and
  `unref`'d (docs/bugs-fixed.md #71). Before that, a step that declared a bound kept the process alive for
  the whole bound after finishing, which is how a test with a 600 s bound came to sit for ten minutes.
