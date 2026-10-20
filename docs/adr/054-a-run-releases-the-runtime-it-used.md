# ADR-054: A Run Releases The Runtime It Used

- **Date**: 2026-10-12
- **Status**: Accepted. Implemented in `apps/cli/src/commands.ts` (`runTask`), `packages/core/src/runtime.ts`
  (the optional `close` on the runtime contract). Tests in
  `apps/cli/src/test/runtime-release.test.ts`.
- **Related**: ADR-049 (an invocation is torn down), ADR-053 (a declared output is checked), docs/bugs-fixed.md #65

## Context

Measured on the real machine, 2026-10-12: a `request-intake` run against the real pi runtime **completed**
at `01:23:10Z` — run record written, artifact written, summary printed — and the CLI process was **still
alive at `01:25:30Z`**, 2.5 minutes later. An earlier foreground invocation of the same command had to be
killed at 600 s. The process was not working: it had nothing left to do.

The cause is a resource nobody released. The pi adapter **pools a live `AgentSession`**
(`createAgentSession`, kept for the next task in the same cwd so a retry is cheap), the adapter exposes
`close()` for exactly that pool, and **nothing on the run path ever called it**. An open session holds the
process's event loop open, so a process that had finished its work did not exit.

For an unattended chain this is not cosmetic: a supervisor sequences runs by waiting for a process to
**exit** — that is how a pilot knows a run is over, when to start the next one, and what to record. A run
that never exits cannot be sequenced, retried, or measured, and a pilot that waits on it waits forever.
This is the same shape as ADR-049 (an invocation left listening): work finished, resources still held.

## Decision

**The caller that created the runtime releases it, on every path.**

- The runtime contract gains an OPTIONAL `close?(): void` — optional because a runtime that holds
  nothing (the fake one) needs no teardown, and a required method would force every adapter to implement
  a no-op.
- `runTask` releases whichever runtime it used in a `finally`: the one it resolved from `runtimeId`, or
  the one handed to it through the new `runtime` seam on `RunOptions`. `finally` because a FAILED run is
  exactly when the operator wants the process back — and because the failure path is the one that used to
  be reported as a hang.
- The release lives in `runTask` rather than in the engine: the engine does not own the runtime's
  lifetime (a runtime may serve several runs), while `runTask` is what creates or is handed one.

## Consequences

- A finished run exits. The contract is asserted directly instead of inferred from a process that happens
  to exit: the tests inject a runtime whose `close()` is counted, on a completed run and on a failed one.
- The `runtime` seam on `RunOptions` is the first injection point on the run path, which also removes a
  reason for tests to reach for the runtime registry.
- Pooling is unaffected in practice: the pool only ever reused a session for a RETRY OF THE SAME task, so
  closing at the end of the run gives up nothing that was being used.

## What this does NOT fix (named rather than worked around)

- **Why the process lingered for as long as it did is not fully characterised.** One earlier run of the
  same command exited cleanly (`exit 0`), so this was intermittent; the pool is the mechanism this ADR
  found and closed, and a second cause (if any) would need another measurement rather than a guess.
- The console/embedding callers that bring their own runtime now own the same question: `runTask` closes
  what it is given, so a caller that wants a runtime to survive several runs must pass it knowing that.
- The rest of the chain's teardown is unchanged, including the two ADR-053 left open: the shared artifact
  store root and the disagreement between the `approval` step's non-TTY auto-approval and
  `requirement confirm`'s refusal.
