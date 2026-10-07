# ci-pipeline

Documentation for the two CI/CD workflow steps (ADR-037). Neither step is
agent-driven — there is no prompt here on purpose: a pipeline file written by a
model is a pipeline a model can fit, and a wait for a pipeline that a model
reports is not a wait. These are engine steps, and this skill exists so the
contract is written down next to the workflows that use it.

## `ci_config` — write the host's pipeline into the delivery

Fields:

| field | type | meaning |
|---|---|---|
| `testCommand` | string (required) | the command that runs the **delivered project's own tests**. A step with no non-empty `testCommand` is refused at load, and refused again at run time. |
| `dialect` | `forgejo` \| `github` (default `forgejo`) | which host's pipeline file to write. |
| `requirementRef` | string | the confirmed requirement document the pipeline is derived from (usually `"{requirement}"`). |

Behaviour:

- Writes the pipeline file into the **delivery worktree**: `.forgejo/workflows/ci.yml`
  (Forgejo/Gitea) or `.github/workflows/ci.yml` (GitHub). Both are
  GitHub-Actions-compatible YAML; only the path differs.
- The file runs the delivered project's own tests — **not takumi's** — and, when
  the requirement document declares a `deliverable.run`, a second job that runs
  the deliverable against the `input_format.sample` the document itself declares
  (`{csv}` resolves to that sample).
- The generated file is a real file a human can read and a repair round can fix,
  and it is also recorded as a run artifact.
- **Refused when the step declares no test command**: a pipeline that runs no
  tests would run nothing and still report green, which is decoration.
- The step summary says the delivery now **CONTAINS the pipeline that will judge
  it**, and states the protected-path consequence: CI configuration is a protected
  path (`packages/core/src/review-rules.ts`). A pipeline the delivery CREATES is
  reported by the deterministic reviewer as a **note** inside the delivery
  (ADR-032), never silently waved through; a change to one that already existed
  stays a `human` finding that stops the run.

Ordering: `ci_config` must run **before the implementer's commit**. takumi never
commits (the agent's boundary is the commit), so a pipeline written after that
commit is an uncommitted file the host never runs.

## `await_checks` — wait for the host's pipeline on the delivered head

Fields:

| field | type | meaning |
|---|---|---|
| `waitSeconds` | integer 1..1800 (default 300) | the bounded wait budget. |
| `ref` | string (optional) | the delivery reference to poll (a pull-request number or URL). When absent, the head is derived from the delivery worktree's branch and HEAD. |

Behaviour:

- Polls the delivery provider's `checks()` on the delivered head, inside the
  declared budget.
- **`success` for every check is the only pass.**
- A `failure` fails the run immediately, naming the failing checks **and their URLs**.
- Checks still `pending` when the budget runs out fail the run, naming the checks
  still pending.
- A host that cannot report checks at all fails with that said plainly: no
  delivery provider (`ctx.delivery`), `capabilities.canRunChecks === false`, a
  `checks()` that throws, or a host that reports **no checks at all**. "No checks"
  is not a pass.
- `neutral` / `unknown` conclusions are not `success`, so they fail too.
