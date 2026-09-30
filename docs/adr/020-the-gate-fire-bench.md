# ADR-020: The Gate-Fire Bench

- **Date**: 2026-09-25
- **Status**: Accepted (`packages/core/src/test/delivery-loop.test.ts`, the `gate fire:` block and its
  scoreboard; `verdictFromFindings` exported from `review.ts` and `index.ts`)
- **Related**: ADR-013 (the deterministic reviewer), ADR-018 (review digests), ADR-019 (committed
  credentials). The vocabulary and the fixture names are borrowed from the adversary set measured in
  `code-oz` (`docs/benchmarks/agent-gate-bench.md`).

## Context

Every guard in this system is a claim: "tests cannot be weakened past us", "a stale approval is
refused", "an unknown mergeability never becomes a yes". Each was written with tests for the code it
was built from — and none of those tests answers the question that matters about a guard:

> Is there a fixture, today, that would FAIL LOUDLY if this guard stopped working?

A test proves the implementation does what the author wrote. A bench proves the *guard* fires. They
are different artefacts, and a system whose only evidence is the first kind cannot tell a working
gate from a gate that was quietly disabled in a refactor.

The second requirement is that the bench must not be a parallel universe. A bench that re-implements
the decision it is measuring passes when the implementation is wrong and fails when it is right, and
nobody ever trusts it enough to act on it — which is the same as not having it.

## Decision

1. **Every row is an adversarial fixture with a named expected outcome.** Nine rows: weakened tests,
   a committed credential, a protected path, a dirty worktree, a head that moves after the review,
   mergeability that never resolves, an unavailable reviewer, a force-push attempt, a stale approval.
   Each is the *cheapest* fixture that exercises the real seam — a fake delivery, a real rules
   engine, a real worktree check — not a bespoke path built for the bench.
2. **Rows call production predicates.** The verdict comes from `verdictFromFindings`, the same
   function the live reviewer reaches its verdict through (exported from `review.ts` for exactly this
   reason). A row may not compute its own expectation from first principles: it asks the system, and
   checks that the answer is the one the guard exists to produce.
3. **The vocabulary is fixed and the empty cells are visible**: `Block` / `Allow` / `Pass` / `Fail` /
   `Partial` / `n/a` / `TBD`. A row that needs a live forge or a real git binary is marked **`n/a`
   with the suite that does cover it** — never guessed at, and never quietly filled with the answer
   the author hoped for. The scoreboard test fails if a deterministic row is left `TBD`.
4. **A blocked gate and a firing gate are distinguishable.** The protected-path row documents the
   difference: a human-owned change is not *blocked*, it *waits*, which is why it consumes no fix
   round. A bench that scored both as "Block" would hide a regression in either direction.

## Consequences

- The bench found its own first bug, in the bench: the head-moved row originally asserted "nothing
  merges", and it failed — because that is not the guard. The guard is "never merge code the review
  did not see": the stale merge is refused, the item returns for review, and the run merges a head
  that was reviewed. The loop was right and the assertion was wrong, and the row now counts the
  re-review. **A bench whose rows cannot fail is not evidence**, and this one failed against the
  implementation before it passed against it.
- Two rows are honest `n/a` (force-push, stale approval in the live shape) and name their coverage
  instead of claiming a green cell. The `n/a` count is the bench's own measure of how much of the
  guard set is still only covered by unit tests.
- **The bench measures GUARDS, not ABILITY.** It says nothing about whether the agent solves the
  item — that needs the frozen-task harness with hidden tests and per-instance cost (`takumi-bench`),
  which is a different artefact with a different vocabulary. Conflating them is how "our gates work"
  becomes "our agent is good".
- It runs offline and deterministically, so it can be required on every change; the day a row needs a
  network it stops being a gate on the gate and becomes a flaky test nobody reads.
