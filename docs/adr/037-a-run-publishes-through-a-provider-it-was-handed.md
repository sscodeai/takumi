# ADR-037: a run publishes through a provider it was handed

Status: accepted (implemented; `packages/core/src/test/publish-step.test.ts`,
`packages/core/src/test/ci-config-step.test.ts`, `packages/delivery-forgejo`)
Related: ADR-007 (the delivery port), ADR-013 (the deterministic reviewer), ADR-032 (a created protected
path is a note), ADR-034 (a refused delivery is repaired)

## Context

Everything a black-box run did until now happened inside a worktree nobody else could see: the engine
implemented, gated, reviewed, forged a judge, judged, and packaged a bundle — and never touched git, never
spoke to a code host. That is why "automatic pull request / issue / CI" had no place to stand: there was no
seam, and the engine had no opinion about which host a delivery belongs to.

The pilot line already had the rails (the delivery port, `deliver`/`status`/`checks`/`merge`, a contract
suite, a rule that the agent's boundary is the COMMIT and that pushing is never forced). What was missing was
a workflow-level seam for the `request-to-delivery` path and a real adapter for the operator's host.

## Decision

1. **The host is injected, never discovered.** `ctx.delivery` is a `DeliveryProvider` handed to the run by
   its caller, exactly like the workflow loader. The engine has no default host and no configuration of its
   own: an unattended run that can push wherever it likes is a run nobody can reason about.
2. **`publish` is the only step that writes to a host**, and it is narrow: push the committed branch with a
   PLAIN push, open EXACTLY ONE pull request whose body carries the run id, the confirmed requirement and
   its digest, and — when the host can record one — an issue that says what was asked for.
3. **Four refusals make the boundary real**, and each one has a test:
   - no provider ⇒ the run FAILS ("a local bundle is not a delivery");
   - a provider that reports `mode: 'force'` ⇒ the run FAILS (the reviewed history would be gone);
   - a host with no review surface ⇒ reported as exactly that, never as a pull request that does not exist;
   - an issue that could not be recorded ⇒ LOUD, and never undoes a pull request that already exists (the
     same rule the board mirror keeps: a projection failure is not allowed to block real work, and is not
     allowed to be silent).
4. **The delivery carries the pipeline that will judge it.** A `ci_config` step writes the host's pipeline
   file (`.forgejo/workflows/ci.yml` or `.github/workflows/ci.yml`) into the worktree, derived from the
   document's `deliverable.run` and the delivered project's OWN test command; a step with no test command is
   refused at load. The pipeline is a protected path, so the deterministic reviewer reports it — as a note
   for a created file, per ADR-032 — and the step summary says plainly that the delivery now contains the
   pipeline that will judge it.
5. **`await_checks` waits, and only a green pipeline passes.** Bounded by `waitSeconds` (default 300, ceiling
   1800), polling the provider's `checks()` on the published head: every check `success` is the only pass; a
   `failure` fails naming the check and its URL; `pending` at the timeout fails naming what is still pending;
   a missing provider, a host without the checks capability, a throwing `checks()`, or a host that reports
   ZERO checks all fail loudly. The step never reports a green pipeline it did not read.
6. **The exact-head merge guard is the host's, not ours.** The Forgejo adapter passes the head to the host's
   merge call and lets the host refuse; a live run against a real instance returned `409 {"message":"head out
   of date"}` for a stale head, which is the guard working where it cannot be bypassed by a client bug.

## Consequences

- The black-box path can now finish where a person expects work to land: a branch, one pull request, an
  issue that records what was asked, and a pipeline result that the run actually waited for.
- `publish` is deliberately not idempotent-forever: the port's `deliver()` reuses an existing pull request
  rather than opening a second one, and a repair round pushes to the SAME branch, so one run produces one
  review surface no matter how many attempts it spent.
- What is still absent: CI configuration is GENERATED but a host that has no runner configured will report no
  checks at all — `await_checks` then fails loudly, which is correct but means a fresh host needs its runner
  set up before the pipeline step is useful. And the adapters beyond Forgejo/Gitea do not exist yet; the port
  is what makes them a small, testable addition rather than a rewrite.

## Evidence

- `publish-step.test.ts` (7 tests): no provider fails; one plain push and one PR with the requirement digest
  in the body; a FORCE fails the run; no review surface reported honestly; an unrecorded issue loud but
  non-fatal; a provider without the issue surface says so; a dirty worktree refused by the provider fails the
  run.
- `ci-config-step.test.ts` (13 tests) driving the real engine: config written with the declared test command;
  refused with no test command; a red pipeline fails naming the check; a pending pipeline times out naming
  the pending checks; a host that cannot report checks fails loudly.
- `packages/delivery-forgejo` (35 tests) including the port's own contract suite, and a live run against the
  operator's self-hosted Forgejo (`10.0.3+gitea-1.22.0`): repo created, plain push, exactly one PR,
  `status`/`checks` read, issue opened, PR commented, correct-head merge `200`, and a STALE-head merge
  refused by the host with `409 head out of date`. Independently re-verified by the operator's agent: the
  repository, the pull request, the issue and the comment all exist on the live instance.
