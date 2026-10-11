# ADR-042: The ci_config dialect comes from the delivery provider, not from the workflow

Status: accepted (implemented in `packages/core/src/ci-pipeline.ts` and
`packages/core/src/workflow-engine.ts`; the shipped `request-to-delivery-attempt` no longer declares a
dialect)
Related: ADR-037 (a run publishes through a provider it was handed), ADR-041 (what a GitLab delivery
guarantees), ADR-007 (the delivery port)

## Context

`ci_config` writes the DELIVERY HOST's own pipeline file into the delivery, so the host runs it and
`await_checks` can read a real result (ADR-037). Which file that is depends on the HOST, and the host is
the run's delivery provider: GitHub runs `.github/workflows/ci.yml`, Forgejo/Gitea
`.forgejo/workflows/ci.yml`, GitLab `.gitlab-ci.yml`.

The step's dialect was nevertheless HARD-CODED per workflow (`dialect: forgejo` in
`request-to-delivery-attempt`) — the WORKFLOW's opinion, not the host's. The defect was measured, not
theoretical: the first true green end-to-end on GitHub (run i15) had to declare `dialect: github` by hand
before it could work at all, and a run whose `delivery:` section says `provider: github` with the shipped
workflow would have written `.forgejo/workflows/ci.yml` — a file GitHub never runs, so `await_checks`
would have failed closed on an EMPTY check set (docs/bugs-fixed.md #48). The same mistake against GitLab
writes a GitHub-Actions file GitLab does not read.

The provider already knows its host: `metadata().id` is its own name for it (`github`, `gitlab`,
`forgejo`) — the same word the dialects use.

## Decision

1. **The dialect is DERIVED from the delivery provider unless the step declares one.** The engine reads
   `ctx.delivery.metadata().id` and maps it to a dialect; the mapping is the identity, because the
   provider's id for its host IS the dialect's name (`dialectForDeliveryProvider`). This is why a
   `provider: github` run writes the file GitHub actually runs without any workflow saying so.
2. **An explicit `dialect:` on the step WINS.** A step that genuinely needs a dialect of its own — a
   delivery into a host the provider does not name, or a test of one specific renderer — keeps the
   authority; the derivation is only the fallback.
3. **A provider that names no host takumi writes a pipeline for derives NOTHING.** A bare git remote
   (`git`) and the fake provider are not hosts with a CI dialect, so the historical `forgejo` default
   stands rather than a dialect being invented for them.
4. **The summary says WHICH of the three applied** — `declared by the step`, `derived from the delivery
   provider "<id>"`, or `the default: …`. A transcript that shows only the resulting path cannot be
   audited: the same file can come from a declaration, a derivation or a default, and the run must not
   make a reader guess which.
5. **The shipped workflow stops declaring a dialect.** `request-to-delivery-attempt`'s `dialect: github`
   was the workaround for #48; keeping it would pin every run to one host's file and leave the defect in
   place for the other hosts. The implementer prompt is likewise dialect-agnostic (it names all three
   paths) instead of asserting the GitHub one.

## Consequences

- A run against a GitHub or GitLab host needs no workflow edit to write the right pipeline file; the
  dialect follows the `delivery:` section the operator already set.
- The dialect is a property of the RUN, so two runs of the same workflow against two hosts write two
  different files — which is the point.
- A step that declares a dialect is unchanged: the declaration still wins, so existing tests and any
  host-specific workflow keep their behaviour.
- The derivation is a fallback, not a validation: a provider whose `metadata()` throws derives nothing
  and the default stands, rather than failing a run over a naming call.

## Evidence

- `packages/core/src/ci-pipeline.ts`: `dialectForDeliveryProvider`, and `executeCiConfigStep`'s
  declared → derived → default resolution with the origin carried into the summary.
- `packages/core/src/workflow-engine.ts`: the `ci_config` branch reads `ctx.delivery.metadata().id` and
  passes it as `deliveryProviderId` (guarded — a `metadata()` that throws derives nothing).
- `packages/core/src/test/ci-config-step.test.ts`: a github/gitlab/forgejo provider with NO declared
  dialect derives the matching path and NOT the forgejo default; an explicit `forgejo` beats a `github`
  provider; a `git`/absent provider derives nothing and the default stands; and
  `dialectForDeliveryProvider` maps the provider ids directly.
- `extensions/workflows/request-to-delivery-attempt/workflow.yaml`: the `dialect:` line is gone, with the
  reason written where it was.
