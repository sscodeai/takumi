# Takumi acceptance report

- **Scope**: the platform as it stands on `dev` (the 112 commits of 2026-09-18 to 2026-09-28,
  merged 2026-09-30), i.e. what a reader of the README is entitled to check.
- **Method**: every claim below is pinned by an executable test in this repository. Nothing
  here is a claim about intent; if a row is not pinned, it says so.
- **Reproduce**: `pnpm install && pnpm build && pnpm test` (Node 20+, pnpm). CI runs exactly
  those steps on Node 20 and Node 22 (`.github/workflows/ci.yml`).
- **Numbers on this tree**: 38 packages, **606 tests, 603 passing, 3 skipped, 0 failing**.

## What a gate is here — and what it is not

A gate is a *claim that a guard fires*, pinned by a test that fails if the guard stops firing.
Gates are named in code comments (`acceptance Gate 8`) and in the test that pins them
(`packages/core/src/test/acceptance-gate*.ts`), so a reviewer can go from the claim to the
evidence without asking anyone.

A gate is **not** a proof of correctness, and passing gates are not a statement about
production traffic. The honest limits are listed in [Limits](#limits-not-covered) below.

## The gates

| Gate | The claim | Pinned by |
|---|---|---|
| 2 | Core does not depend on a board or a delivery: those are ports, not imports | `packages/core/src/test-utils.ts` (import guard) |
| 3 | Every runtime (fake, Pi, CLI, …) satisfies **one** shared contract suite — a runtime that cannot do something fails explicitly instead of pretending | `packages/core/src/contract.ts`, run by `runtimes/*/src/test/` |
| 4 | FakeRuntime simulates start / events / artifacts / failure / retry / cancel | `acceptance-gates-core.test.ts` |
| 6 | A runtime's declared capabilities are enforced **before** execution, with a clear error | `acceptance-gate6.test.ts` |
| 7 | Skills, tools, workflows and runtimes are discovered by their manifest; removing one stops discovery without touching core | `acceptance-gate7.test.ts` |
| 8 | A step's `skill` drives behaviour (not artifact naming): the prompt comes from the skill template, with a documented fallback | `acceptance-gate8.test.ts` |
| 9 | A tool step runs a real command and persists its output as an artifact; a failing command fails the step with an actionable message | `acceptance-gate9.test.ts` |
| 10 | The quality gate passes on green tests, fails and aborts the workflow on red — and fails on output it cannot parse (bug #25) | `acceptance-gate-delivery.test.ts`, `quality-gate.test.ts` |
| 11 | `approval`: reject halts before the dependent step; approve resumes into it | `acceptance-gates-core.test.ts` |
| 12 | Artifacts are first-class: persisted with metadata, consumable by later steps | `acceptance-gates-core.test.ts` |
| 13 | Traceability `REQ → DESIGN → CODE → UT → EVIDENCE` is answerable and renderable as a matrix | `acceptance-gates-core.test.ts`, `traceability.test.ts` |
| 16 | Failure is explicit: unsupported capability, missing runtime, invalid workflow, timeouts and retry exhaustion all fail loudly | `acceptance-gates-core.test.ts`, `runtime.ts` |
| 17 | Cancel ends as `cancelled`, never as `completed` or `failed`, mid-flight included | `acceptance-gates-core.test.ts` |
| 18 | The event trail is ordered and complete: no event after `task.completed` | `contract.ts` (integrity check) |
| 19 | A run leaves an auditable trail on disk | `apps/cli/src/commands.ts` (audit record) |
| 20 | The artifact store refuses a path that escapes its root | `acceptance-gates-core.test.ts` |
| 22 | A runtime declares only the capabilities it honestly has (the fake one claims streaming and usage tracking, nothing else) | `runtimes/fake/src/index.ts`, `runtime-contract.test.ts` |
| 23 | Long runs do not lose state: 2000 events, a 100-artifact store, a 20-step workflow, all bounded in time | `acceptance-gate23.test.ts` |
| 24 | The same workflow runs on two different runtimes with no workflow change | `acceptance-gate24.test.ts` |
| 27 | Independent review runs in an isolated cwd and persists a verdict artifact | `acceptance-gate-delivery.test.ts` |
| 33 | A non-Japanese workflow (rapid-mvp) runs to completion — the Japanese SI flow is a workflow, not a boundary of the platform | `acceptance-gate33.test.ts` |

## Guards that are not numbered gates

These are the checks a delivery actually runs into, each with its own regression test and,
where noted, its own ADR:

| Guard | Behaviour | ADR / bug |
|---|---|---|
| Deterministic reviewer | A weakened test or a moved protected path **blocks** the delivery; the review reads the real change set, not prose | ADR-013, ADR-018 |
| Review bound to inputs | A review digest is bound to one set of inputs; a stale digest cannot be used to approve | ADR-018 |
| Committed credential | A secret in the diff blocks the delivery and asks for ROTATION, not deletion | ADR-019 |
| Gate-fire bench | For every adversarial fixture, the guard must FIRE — a guard that stays quiet is a failure | ADR-020 |
| Sidecar reviewer | semgrep as a second reader, pinned rules and tool version; if it cannot run it refuses, it does not pass | ADR-021 |
| Report surface | Findings are posted where reviewers already look; a broken reporter can never fail a delivery | ADR-022 |
| Workflow review | A `rule_review` step runs the deterministic rules on the delivery path; a missing verdict is not a pass (bugs #26, #27) | ADR-024 |
| Secret-free tests | Credential fixtures are assembled at runtime, so no token-shaped literal lives in the tree | — |

## Coverage: what has run against a real host

| Layer | Live evidence | Offline only |
|---|---|---|
| GitLab board | real private instance: items claimed, delivered, merged; defects #13–#16 found this way | — |
| GitLab delivery | real merge requests, including the no-statuses 404 case | — |
| Notion mirror | a real database: 8-item projection, text + labels, idempotent resync; defects #21, #23, #24 | — |
| File a defect | a red pipeline filed its own item, idempotently | — |
| GitHub board / delivery | — | contract + adapter suites |
| Jira board | — | contract + adapter suites |
| Redmine board | — | contract + adapter suites |
| reviewdog reporter | local reporter only; posting to a live host needs its own `-conf` and a token | — |
| semgrep sidecar | runs on small repositories | baseline discrimination on a repo with pre-existing findings |

## Limits (not covered)

1. **Agent Eval is a small sample**: 23 tasks, useful evidence, not statistically significant
   (see `docs/evaluation.md`).
2. **The eval tasks are pre-authored**: the held-out verifier tests are written by hand. The
   platform does not yet *generate* an independent oracle for an arbitrary new requirement.
3. **`takumi loop` is v1**: manager decisions are LLM-driven and non-deterministic.
4. **Traceability uses ID naming conventions**, not structural foreign keys.
5. **Tool plugins run with user privileges** unless a sandbox is explicitly selected.
6. **Claiming is not atomic on any board** (`atomicClaim: false`): one runner per item is still
   the caller's job (a local slot lock is provided).
7. **A merge conflict is never resolved by rewriting history** — it is aborted and handed to the
   review session.
8. **Real-repo-scale evaluation is not done yet**.
9. **Gates prove a guard fires, not that the code is correct**: no gate here is a formal
   verification, and the review rules are path-based heuristics — a missed test file is a
   missed finding.

## Reproduce the report

```bash
pnpm install
pnpm build
pnpm test          # 606 tests, 0 failing, on this tree
pnpm typecheck
```

Single gate, while iterating:

```bash
cd packages/core && node ../../scripts/run-node-tests.mjs
```

The defect ledger that sits behind the "bug #" references — symptom, root cause, fix commit
and the test that pins it — is in [docs/bugs-fixed.md](./bugs-fixed.md).
