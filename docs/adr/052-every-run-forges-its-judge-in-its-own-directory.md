# ADR-052: Every Run Forges Its Judge In Its Own Directory

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `packages/core/src/workflow-engine.ts` (the `judge_forge` step's
  `judgeDir`). Tests in `packages/core/src/test/judge-forge.test.ts`.
- **Related**: ADR-026 (a forged judge), ADR-033 (the document declares the world its judge checks),
  docs/bugs-fixed.md #63

## Context

The forged judge lived at `<project>/.takumi/acceptance/<stepId>/` — ONE path for the whole project — and
the step RECREATES it (`rm -rf` then `mkdir`) before forging, so that a judge from an earlier run can
never be reused as this run's evidence. That intent is right; the path was not.

The consequence, measured on 2026-10-11: a second run on the same project **destroyed the judge the first
run was being judged by**. During this work the run directory had to be cleaned by hand between runs for
exactly this reason, and two runs that overlap (a pilot tick plus a manual run, or two pilots) overwrite
each other's judge — which is the artifact a run's acceptance is bound to.

## Decision

The judge directory is `<project>/.takumi/acceptance/<runId>/<stepId>/`. It stays OUTSIDE the
implementation worktree (ADR-026, unchanged: an agent that can read the judge can fit it) and it is still
recreated per run, so a judge from an earlier run is never this run's evidence — but every run now has its
own copy of it, and one run cannot delete another's.

## Consequences

- Two runs on one project no longer interfere through the judge. The test asserts it directly: run the
  workflow twice on one project, read the judge path out of each run's ACCEPT artifact, and check the
  paths differ AND that the first run's judge still exists after the second run.
- The path is now per-run, so the artifact records it per-run: a reader gets the judge path from the
  artifact (which is the evidence) rather than from a path convention.
- **Still shared, and NOT fixed here**: the ARTIFACT store root (`<project>/.takumi/artifacts/…`) is one
  path for the project, so `acceptance/ACCEPT-001.md` and `REJECT-001.md` are still overwritten by a
  second run. The judge — the thing a verdict is bound to — is isolated; the artifact files are not, and
  that is the next collision to close for genuinely parallel runs.

## Evidence (RED then GREEN)

- RED: `judge forge: two runs on one project do not share a judge directory` →
  `error: 'the second run judges from its OWN directory'`.
- GREEN: the same test passes; `judge-forge.test.ts` 11/11; `@takumi/core` **533 tests, 530 pass, 0 fail,
  3 skipped**. The tests that had hard-coded `.takumi/acceptance/judge` now read the path from the
  artifact, and the "no judge existed during implementation" property asks whether ANY judge exists under
  the project, because the run-scoped path is not knowable in advance.
