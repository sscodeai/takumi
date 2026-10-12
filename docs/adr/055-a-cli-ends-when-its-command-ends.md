# ADR-055: A CLI Ends When Its Command Ends

- **Date**: 2026-10-12
- **Status**: Accepted. Implemented in `apps/cli/src/index.ts` (`exitWhenFlushed`, the entry-point guard,
  the `TAKUMI_TEST_HOLD_ALIVE_MS` test seam). Tests in `apps/cli/src/test/cli-exit.test.ts`.
- **Related**: ADR-054 (a run releases the runtime it used), docs/bugs-fixed.md #66

## Context

ADR-054 closed one leak (the pi adapter's session pool was never closed) and its test passes — and the
process STILL outlived its workflow. Measured on 2026-10-12, on the very build that had the release in it:
workflow `wf-ef034bc3` finished at `01:45:54Z` (record written, artifacts written, summary printed) and the
CLI process was still alive at `01:49:10Z`, when it had to be killed by hand. An earlier foreground
invocation had to be killed at 600 s.

The mechanism was never "one library holds a socket". It was this, at the bottom of `apps/cli/src/index.ts`:

```ts
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, …);
```

The exit was left to "the event loop drained". That makes a finished run depend on EVERY library
releasing EVERY socket — a condition no application can verify and no reader can see. The demonstration
is one line:

```
$ timeout 6 node -e 'setTimeout(()=>{},60000); console.log("command finished"); process.exitCode=0;'
command finished
$ echo $?
124        # the shell had to kill it: the command was done, the process was not
```

For an unattended chain this is the difference between a flow and a hang. A supervisor sequences runs by
waiting for a process to **exit** — that is how it knows a run is over, when to start the next, and what
to record. A run that never exits cannot be sequenced, retried, or measured.

## Decision

**The CLI exits when its command ends.**

- `exitWhenFlushed(code)` writes empty strings to stdout/stderr and waits for those writes to hand off to
  the OS, then calls `process.exit(code)`. Flushing first is the part that matters: exiting explicitly may
  never truncate what the command printed, and the test asserts the output arrived.
- The command runs **only when the file IS the entry point** (`import.meta.url === pathToFileURL(process.argv[1]).href`).
  This is not decoration: `apps/cli/src/test/run.test.ts` imports `runPilotCommand` from this module, so
  without the guard an import started a command and then exited the importer — which silently cut **16
  tests** off the end of the suite (1022 → 1006) while the suite still reported `0 fail`. A quiet loss of
  tests is a defect, not a footnote, so the guard is pinned by its own test.
- `TAKUMI_TEST_HOLD_ALIVE_MS` holds the event loop open in the built CLI (deliberately not `unref()`'d):
  the real leak needs a live model to reproduce, and a test that only passes on a clean event loop proves
  nothing. With the seam, the test child is a process that WOULD hang.

## Consequences

- A finished run returns its exit code and its terminal prompt. A supervisor can now sequence runs, which
  is what "unattended" was waiting on.
- stdio is flushed before the exit, so a piped or redirected run (the pilot, a CI job, a log file) keeps
  every line it printed — asserted in the same test that asserts the exit.
- Any library that leaves a handle open can no longer extend a run's life. The cost is that a delayed
  background write started by a command will not keep the process alive to finish it — which is the
  correct contract for a CLI, and the reason the flush comes first.

## What this does NOT fix (named rather than worked around)

- **Why the pi session outlived the release is still not fully characterised.** ADR-054 closed the one
  leak it found (the pool was never closed) and the process still lived past its workflow, so the
  explicit exit is the contract that makes the question moot — but a second cause has not been isolated,
  and this ADR does not claim one.
- Test-runner blindness: the suite reported `0 fail` while a whole test FILE was being cut short. The
  explicit-exit-plus-guard pair is now pinned, but the runner itself still has no notion of "this file
  was supposed to report more tests".
- The two ADR-053 items remain open: the shared artifact store root, and the disagreement between the
  `approval` step's non-TTY auto-approval and `requirement confirm`'s refusal of a non-interactive
  confirmation.
