# ADR-049: An Invocation Is Torn Down, Whichever Shape It Is

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `extensions/judges/metamorphic-forge.sh` (the script branch of
  `run_tool`: `start_scenario_surface "deliverable-script"`, the bounded wait, `kill_scenario_surfaces`
  on every path). Tests in `packages/core/src/test/service-read.test.ts` (the leak) and
  `packages/core/src/test/service-shape.test.ts` (the bound, both shapes).
- **Related**: ADR-013 (the vacuous green), ADR-046 (a service-shaped delivery is bounded and asserted),
  ADR-047 (a service's report is fetched, not printed), docs/bugs-fixed.md #57 (a hard-coded port let one
  run answer for another), bug #41 (a leaked `python3 -m http.server`)

## Context

The judge reads the deliverable's report in one of two shapes:

- **script** (the document declares no `read`): the deliverable is invoked once per fixture and the report
  is its stdout;
- **service** (the document declares `read` + `url`): the deliverable is STARTED per fixture on a port the
  judge allocated, health-gated, fetched through `read`, and the surface is torn down (ADR-047).

The service shape tears its surface down — it is started with `setsid` in its own process group and the
group is killed on every path. The script shape did not. It ran the deliverable as

```sh
RUN_OUT=$( ( cd "$WORKTREE" && timeout "$RUN_TIMEOUT_S" sh -c "$cmd" ) 2>&1 ); RUN_STATUS=$?
```

and `timeout` signals the DIRECT child. A deliverable is free to background a surface before it returns —
the spike's own `serve.sh` does exactly that, deliberately: it prints the report on stdout and starts the
HTTP surface in the background "so that both a pipe-reading judge and a CI step finish instead of hanging
on a long-running server". So the surface outlived the invocation.

**Measured, not inferred.** After a live `request-to-delivery` run of the script shape ended, a
`station_service.py` was still bound to `127.0.0.1:8787`, started from a judge fixture
(`/tmp/station-service-8787.csv`). That is exactly the hazard bug #57 names: a leaked listener answers the
NEXT fixture — or the next run — and a check that reads it passes for the wrong reason. It also explains
how a document whose relations are judged from stdout can appear to pass while nothing is exercising the
surface it declares.

## Decision

**An invocation is torn down, whichever shape it is.** The script shape is a started surface like any
other:

1. It is started with `setsid`, so the invocation is the leader of its OWN process group and everything it
   backgrounds inherits that group.
2. It is bounded by the same `RUN_TIMEOUT_S` as the service shape, and a bound that was hit is still
   `RUN_STATUS=124` — the existing FAILURE that names the command (`the deliverable command timed out
   after <n>ms, so the deliverable was never exercised: <cmd>`), unchanged.
3. Its group is torn down on EVERY path: after the report is read, on the bound, and through the judge's
   `EXIT INT TERM` trap. Nothing the invocation started survives it.

## Consequences

- A deliverable that backgrounds a surface — which the spike's own implementation does, on purpose — no
  longer poisons the next fixture or the next run. Verified on the real deliverable: the same script-shaped
  judge that left `8787` listening now leaves nothing.
- **A deliverable that leaves its own process group escapes this, and that is stated rather than
  claimed solved.** A double-fork that calls `setsid` itself is outside the group the judge kills. The
  judge is not a sandbox and does not pretend to be one: no cgroup, no namespaces, no supervisor, no
  restart.
- A document that hard-codes a port still gives up the isolation `{port}` buys (ADR-047), but it no longer
  leaks the process behind it. The two defects were separable, and only one of them is fixed here.
- The bound is now enforced by a poll loop rather than `timeout`, so the judge owns the exact moment it
  gives up and can tear the group down at it. The user-visible behaviour is identical (status 124, the
  same message, the same relation failing).

## Evidence (RED then GREEN)

- RED, before the fix: a script-shaped document whose `serve.sh` prints its report and backgrounds a real
  HTTP listener → the relations are exercised and the verdict is `pass`, and the listener is **still
  there** afterwards:
  `the judge left the deliverable's own surface listening: a leaked listener answers the next fixture`.
- GREEN, after the fix: the same test passes, and `service-read` 5/5, `service-shape` 8/8,
  `judge-forge-scenarios` 11/11 (the timeout message it asserts is unchanged), `@takumi/core` **531 tests,
  528 pass, 0 fail, 3 skipped**.
- Real machine: the REAL deliverable (`serve.sh` that backgrounds its surface) judged by a script-shaped
  judge → `11/11`, `ACCEPT_VERDICT: pass`, and **no listener left behind** (before the fix, `8787`).
