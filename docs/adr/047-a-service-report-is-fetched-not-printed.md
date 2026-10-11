# ADR-047: A Service's Report Is Fetched, Not Printed

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `extensions/judges/metamorphic-forge.sh` (`deliv_child`, the
  `read`/`url` readers and refusals, `subst`, `alloc_port`, the per-fixture `run_tool` that starts /
  health-gates / fetches / kills, and `strip_outer` in both value parsers),
  `packages/core/src/requirement-decisions.ts` (`DeliverableBlock.read`, `DeliverableBlock.url`, the
  pairing refusals), and `docs/requirements/service-station-summary.yaml` (the spike document). Tests in
  `packages/core/src/test/service-read.test.ts`.
- **Related**: ADR-013 (the vacuous green), ADR-026 (a forged judge), ADR-033 (the document declares the
  world its judge checks), ADR-035 (a scenario is a check the document declares), ADR-038 (the check
  itself can be wrong), ADR-046 (a service-shaped delivery is bounded and asserted)

## Context

ADR-046 made a service-shaped delivery BOUNDED and made a scenario ASSERT the response. A live
`request-to-delivery` run against the spike's service document then reached the acceptance and produced
**1 of 11 checks ok** — and the failure was not in the implementation:

- `implementation` committed a working service (`station_service.py`, `serve.sh`), the delivered suite
  passed (**133 tests, OK**), `quality_gate` PASSED and `rule_review` PASSED;
- the judge reported **every output-shape relation** as
  `the judge did not exercise the deliverable: nothing in its output (exit 0) matched a declared output
  shape, so this relation is unproven` — REL-001, REL-002, REL-003, REL-004, DIFF-001, and the decisions
  bound to them;
- SCN-001 failed with `the response body does not contain the declared expect_body '\'total\'' (the
  surface answered HTTP 200)` against a body that plainly contained `"total": 5`.

Two facts were hiding behind that: the judge **cannot read a service at all** (its whole relation
machinery parses the deliverable's STDOUT, and a service prints nothing), and the body assertion searched
for a substring that still carried the document's YAML quoting.

## Decision

**1. `deliverable.read` + `deliverable.url`: how a judge READS the report of one fixture.**

A script prints its report, so `run` alone is enough and `read` is absent. A service starts and serves,
so the document declares the command that FETCHES the report and the surface to wait for:

```yaml
deliverable:
  run: "bash serve.sh {csv} {port}"     # starts the thing (never exits)
  read: "curl -fsS {url}"               # fetches ONE fixture's report
  url: "http://127.0.0.1:{port}/summary"
  timeoutMs: 120000
```

Per fixture the judge now: allocates a port, starts `run` on that fixture, health-gates `url`, runs
`read` under the same bound, and **kills the surface on every path**. `read` and `url` go together and
either alone is REFUSED at the front door and in the forge — a service whose report no judge can fetch is
a delivery judged on nothing. The bound (ADR-046) applies to `read` as well: a fetch that never returns
is the same hang one step later.

**2. `{port}`: the port is ALLOCATED by the judge, not declared by the document.**

`{csv}`, `{port}` and `{url}` are resolved in every command the document declares (`run`, `read`, and a
scenario's `start`/`url`/`run`). The judge probes for a free port (`/dev/tcp`, pure bash — the judge
depends on awk + curl only) and substitutes it, so two runs — or two fixtures, or a leftover process from
an earlier run — cannot answer for each other. A document that hard-codes a port instead gives that
isolation up; the ADR says so rather than pretending the isolation is unconditional.

**3. The OUTER quote pair is the quoting, not the value.**

Both line-wise value parsers stripped only double quotes, so `expect_body: '"total"'` (YAML
single-quoting a string that CONTAINS double quotes) was read as `'"total"'` and the judge searched for a
substring no response contains. The parsers now strip a matched outer pair of EITHER kind, which is what
YAML means: `'"total"'` is `"total"`, and `"station"` is `station`. A single quote cannot be written
literally inside a shell-quoted awk program, so it is built from its byte code.

## Evidence

`packages/core/src/test/service-read.test.ts` (4 tests) runs the REAL forge and the REAL judge against a
real HTTP service:

- the judge starts the service per fixture, fetches the report through `read`, and the relations are
  EXERCISED (`ok REL-001`, `ok REL-002`, `ok REL-003`, `ok DIFF-001`, `ACCEPT_VERDICT: pass`) — the five
  checks the live run could not exercise — with **no listener left behind**;
- the same service with its count deliberately one too low FAILS `DIFF-001` (the check is real, not
  vacuous);
- `read` without `url` (and `url` without `read`) is refused by the front door AND by the forge;
- `expect_body: '"TOTAL"'` against a body carrying `"TOTAL"` now passes SCN-001.

## What remains UNMODELLED (stated plainly)

- **The report must be LINE-shaped.** The judge's relation machinery is line-oriented by design
  (ADR-033: the document declares line shapes), so a report that puts every object of a compact JSON
  document on ONE line is parsed as one object. A service that answers with a single-line JSON array is
  therefore not judgeable today: the document declares per-object line shapes and the implementation must
  answer in them. A JSON-aware shape reader is a separate decision, not a promise made here.
- **No sandboxing.** The service runs as a child of the judge with the judge's own privileges.
- **Port isolation is only as good as the document.** `{port}` gives it; a hard-coded port does not, and
  nothing refuses a hard-coded one.
- **The shared acceptance directory.** The forged judge is written to a fixed path
  (`.takumi/acceptance/judge_forge`), so two runs at once still collide there even though their PORTS no
  longer do. Making that directory per-run is the engine's change to make.
- **`read` is one command per fixture.** No headers, no auth, no retry, no streaming; a report that needs
  any of those is out of scope.
