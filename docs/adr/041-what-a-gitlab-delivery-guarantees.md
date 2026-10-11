# ADR-041: A GitLab delivery guarantees a merge request, not a pipeline result

Status: accepted (provider implemented in `deliveries/gitlab`; this ADR records the boundary and the
measured probe that fixed a misdiagnosis)
Related: ADR-007 (the delivery port), ADR-037 (a run publishes through a provider it was handed),
ADR-038 (the check itself can be wrong), ADR-040 (a merge lands the reviewed head)

## Context

`deliveries/gitlab` already exists and is not rebuilt here: it pushes the task branch PLAINLY, opens
EXACTLY ONE merge request whose body carries the run marker, the board state record and the item
cross-reference, reads checks as one entry per pipeline from
`GET /projects/:id/merge_requests/:iid/pipelines` (falling back to the head commit's statuses when the
merge request reports none), and merges exactly the reviewed head through the host's own `sha` guard.
The `gitlab` dialect of `ci_config` writes a real `.gitlab-ci.yml` at the repository root (a `tests`
job from the delivered project's own test command, plus a `deliverable` job only when the requirement
document declares one), and `await_checks` waits on the provider's `checks()`.

What was NOT written down was where that chain's guarantees stop. On GitLab the CI half is not the
host's alone: whether a pipeline produces JOBS at all is a property of the ACCOUNT/NAMESPACE the
project lives in, not of the delivered repository and not of takumi. A probe against the e2e project
(`aicodesh/takumi-e2e`, id `86516245`, private, default branch `main`) produced exactly the pipeline
shape that had been read as "the host has no runner":

- pipeline `2919912475` (source `push`, ref `probe/runner-diagnosis-20261007081835`):
  `status: failed`, `jobs: []` (0), `yaml_errors: null`, `started_at: null`,
  `finished_at: 23:18:38.045Z` BEFORE `created_at: 23:18:38.047Z`, `duration: null`.
- the same shape again for the merge-request pipeline `2919918777` (source `merge_request_event`).

That shape is NOT evidence of a missing runner, and this ADR fixes the reading of it.

## Decision

1. **A `failed` pipeline with ZERO jobs is not a runner diagnosis.** A job that never exists is a
   different fact from a job that exists and is not picked up. Three states must be told apart, and
   each has its own evidence:
   - no pipeline at all — `GET /projects/:id/pipelines?ref=<ref>` is empty;
   - a pipeline with jobs nothing picked up — `GET /projects/:id/pipelines/:id/jobs` is non-empty and
     every job is `pending`/`created`, with `runner: null` and `started_at: null`;
   - a pipeline with ZERO jobs — `jobs: []`, and the cause is on the creation side, which the jobs
     endpoint cannot show. `yaml_errors: null` only means GitLab did not attribute the failure to the
     YAML; it does not mean the file was fine.
2. **The project's runner list is not the pipeline's runner list.** `GET /projects/:id/runners`
   answers "which runners MAY serve this project", and on GitLab.com that includes every instance
   (shared) runner, mostly `stale` or `paused`. Reading that list as "a runner exists" or its absence
   as "no runner" is not a diagnosis either way. The probe found 100 records, 4 `active: true`, 2 of
   them `online` instance/shared runners — so a claim of "no runner is available for this project" is
   NOT supported by the runner list.
3. **What a GitLab delivery GUARANTEES:** the branch is pushed plainly and never forced; exactly one
   merge request exists for the run; the merge request carries the run marker, the board state record
   and the item cross-reference; `checks()` reports the host's pipelines (one per pipeline) and never
   reads an unmodelled status as green; `merge` lands exactly the reviewed head, with the host's own
   `sha` guard as the second, unbypassable half.
4. **What it does NOT guarantee, and must not be reported as if it did:** that a job runs, that a
   pipeline goes green, or that a green pipeline is even possible on this host. A namespace that
   cannot create jobs yields a `failed` pipeline with zero jobs for every push, forever, no matter how
   correct the delivered `.gitlab-ci.yml` is. `await_checks` fails closed in that state — which is the
   correct behaviour — but the failure it reports is the pipeline's, and it cannot name the cause.
5. **The remedy is on the host, not in the delivery.** Until the account/namespace can run jobs,
   `request-to-delivery-no-pipeline` is the honest variant: it writes the same `.gitlab-ci.yml` into
   the commit and lands the delivery, and it does NOT claim to have waited for a pipeline.

## The probe finding (stated plainly)

The earlier diagnosis — "no runner is available for this project", drawn from a `failed` pipeline with
`jobs: []` — was WRONG on the cause. The probe created a branch from `main`, wrote `.gitlab-ci.yml` at
the repository root using the REAL `renderGitlabCiConfig` output (not a hand-written file), confirmed
it via `GET /projects/86516245/repository/files/.gitlab-ci.yml?ref=<branch>` (`200`,
`file_path: .gitlab-ci.yml`), and watched the ref for 5 minutes:

- **The CI file is not the problem.** GitLab's own lint accepted it (`valid: true`, no errors, no
  warnings) and the resolved `merged_yaml` contains the `tests` job; the file is at the root; there
  are no `rules`/`only` that could exclude the push; `yaml_errors` is `null`.
- **No job ran, and no job existed.** `GET /projects/86516245/pipelines/2919912475/jobs` → `job_count = 0`;
  the project's whole job list (`GET /projects/:id/jobs`) is `[]`. So this is neither "a job ran and
  went green" nor "jobs exist but nothing picked them up": there were no jobs to pick up.
- **The actual cause, from two independent calls:**
  - `POST /projects/86516245/ci/lint` with `ref=<branch>` and `include_jobs=true` →
    `HTTP 200 {"valid": false, "errors": ["Identity verification is required in order to run CI jobs"], "jobs": []}`
    (the same content WITHOUT `ref` lints `valid: true` — the difference is that only the ref-aware
    evaluation actually asks GitLab to build the job graph for that pipeline);
  - `POST /projects/86516245/pipeline` (`{"ref": "<branch>"}`) →
    `HTTP 400 {"message": {"base": ["Identity verification is required in order to run CI jobs"]}}`.

So the honest statement is: the project's namespace/account has not completed GitLab.com identity
verification, and GitLab therefore creates a pipeline record that fails immediately with ZERO jobs.
That is a fourth cause, outside the "no runner" / "bad CI file" pair, and it is provable only from the
pipeline-CREATION side (the ref-aware lint or an explicit pipeline create), never from
`jobs: []` plus `yaml_errors: null`.

## What `await_checks` concludes from this

Measured against the provider's own endpoint, `GET /projects/86516245/merge_requests/11/pipelines`
returned `[]` immediately after the merge request was opened (the merge-request pipeline is created a
moment later) and returned the `failed` pipeline `2919918777` afterwards. The provider's
`PIPELINE_CONCLUSION` maps `failed` → `failure`, so:

- with the pipeline present, `await_checks` FAILS: "1 check(s) FAILED on <mr url>: pipeline #2919918777
  (https://gitlab.com/aicodesh/takumi-e2e/-/pipelines/2919918777)" — it names the pipeline and stops;
- with the merge request reporting no pipelines yet, the fallback (`GET /commits/:sha/statuses`, which
  answers `404` for this commit, disambiguated by reading the commit, which exists) yields an empty
  list, and `await_checks` FAILS with "the host reported NO checks … and 'no checks' is not a pass".

Neither path reports a green pipeline, so the fail-closed rule holds. The limitation this ADR records
is that both paths report a FAILED/absent pipeline and neither can say WHY: the real cause
(identity verification) is not visible in the pipeline status, and a human reading the run summary
would otherwise be pointed at the runner or at the CI file again.

## Consequences

- A GitLab delivery can be fully green in every part takumi controls and still fail `await_checks`,
  because the host cannot run jobs. That is a host problem, and the run says so as a failed check.
- `request-to-delivery-no-pipeline` is the correct variant for such a host: same delivery, same
  pipeline file in the commit, no claim of a pipeline result (ADR-037's rule that "no checks is not a
  pass" stays intact, because the variant does not call `await_checks` at all).
- The check the adapter reports is only as good as the host's association of a pipeline with the merge
  request: a project whose pipelines are branch (`push`) pipelines that the merge request does not
  list produces "NO checks", which fails the run — correct, but again not a statement about the code.

## What this does NOT license

- **It does not license reading `jobs: []` as "no runner".** That inference was made once and it was
  wrong; the runner list contradicted it and the creation-side API named the real cause.
- **It does not license treating `yaml_errors: null` as "the CI file is fine".** `yaml_errors` is
  null here while the pipeline still created no jobs.
- **It does not license weakening `await_checks`.** When the host cannot produce a readable green
  pipeline, the run must fail; the fix is a host that can run jobs, not a step that stops looking.

## Evidence

- Probe (no takumi chain was run; all writes were to `aicodesh/takumi-e2e` only):
  branch `probe/runner-diagnosis-20261007081835` created from `main` via
  `POST /projects/86516245/repository/branches`, `.gitlab-ci.yml` written at the root via
  `POST /projects/86516245/repository/files/%2Egitlab-ci.yml` with the output of the real
  `renderCiConfig({dialect: 'gitlab', …})`, file re-read at the root (`200`), pipeline
  `2919912475` polled every 15s (terminal `failed` on the first poll), `jobs: []`, and the two
  creation-side calls above that named the cause. The branch was DELETED afterwards
  (`DELETE /projects/86516245/repository/branches/…` → `204`, re-read → `404`).
- Runner list for the same project: `GET /projects/86516245/runners?per_page=100` → 100 records,
  4 `active: true` (2 `online`, 2 `stale`), all `instance_type`/`is_shared`; `type=project_type` and
  `type=group_type` are both `[]`.
- Provider code this ADR describes, unchanged: `deliveries/gitlab/src/index.ts`
  (`checks()` → `merge_requests/:iid/pipelines`, `PIPELINE_CONCLUSION`, the commit-status fallback,
  `merge()` with `expectedHeadSha`), `packages/core/src/ci-pipeline.ts` (`renderGitlabCiConfig`,
  `ciConfigPath('gitlab') === '.gitlab-ci.yml'`, `executeAwaitChecksStep`'s fail-closed paths),
  `extensions/workflows/request-to-delivery/workflow.yaml` and
  `request-to-delivery-no-pipeline/workflow.yaml`.
