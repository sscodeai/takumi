# ADR-046: A Service-Shaped Delivery Is Bounded And Asserted

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `packages/core/src/requirement-decisions.ts`
  (`MIN_RUN_TIMEOUT_MS`, `DEFAULT_RUN_TIMEOUT_MS`, `DeliverableBlock.timeoutMs`, `Scenario.expectStatus`,
  `Scenario.expectBody`, the `expect_status`/`expect_body` readers in `parseScenarios`, and the front-door
  refusals), `packages/core/src/index.ts` (the exports), `packages/core/src/ci-pipeline.ts`
  (`readDeliverableRunTimeoutMs`, `runTimeoutSeconds`, `renderBoundedCiJobScript`, the wiring into
  `renderCiConfig`/`renderGitlabCiConfig`), `extensions/judges/metamorphic-forge.sh` (the
  `RUN_MIN_TIMEOUT_MS`/`DEFAULT_RUN_TIMEOUT_MS` lines, the `deliverable.timeoutMs` reader, the bounded
  `run_tool`, the `{csv}` resolution in a scenario's `start`/`run`, the response assertion, the
  health gate, and the refusals), and `extensions/skills/req-intake/prompts/intake.md` (rule 13, rules
  17–18, the example). Tests in `packages/core/src/test/service-shape.test.ts`,
  `packages/core/src/test/judge-forge-scenarios.test.ts` and `packages/core/src/test/judge-vocabulary.test.ts`.
  The requirement document that found it is `docs/requirements/service-station-summary.yaml`, derived from
  `docs/requests/station-temperature-service.md`.
- **Related**: ADR-013 (the vacuous green), ADR-026 (a forged judge), ADR-033 (the document declares the
  world its judge checks), ADR-035 (a scenario is a check the document declares), ADR-037 (the generated
  pipeline), ADR-039 (the delivered tests must be able to fail), ADR-045 (a standing authorization)

## Context

Every delivery the black-box chain had ever produced was a SCRIPT: one file, invoked once per input,
prints to stdout and exits. The whole chain — the forged judge's `run_tool`, the generated CI
`deliverable` job, the scenario runner — was written against that shape, and the shape was never said out
loud.

A live spike asked for the OTHER shape: an HTTP service with a JSON endpoint
(`docs/requests/station-temperature-service.md`, confirmed as
`docs/requirements/service-station-summary.yaml`). Its `deliverable.run` is `bash serve.sh {csv}` — a
command that STARTS the thing and NEVER exits. That single difference exposed four places where the chain
would have waited for ever or read green without looking, and one place where a declaration read as
compliance while nothing ran:

1. **The judge's `run_tool` had no bound.** The mutation path and the scenario path already ran their
   commands under `timeout`; the invocation of the deliverable did not
   (`RUN_OUT=$( ( cd "$WORKTREE" && sh -c "$cmd" ) 2>&1 )`). A start-and-serve `run` hung the judge for
   ever, and nothing in the report said which command was hanging.
2. **The generated CI `deliverable` job had no bound.** `renderCiConfig`/`renderGitlabCiConfig` emitted
   the declared `run:` command bare, so a start-and-serve command sat in the runner until the host's own
   job limit (GitHub's default is six hours) and then reported a timeout for the wrong reason, with the
   command nowhere in the message.
3. **`{csv}` was resolved in `deliverable.run` and nowhere else.** A scenario's `start` was passed to the
   shell verbatim, so `start: "bash serve.sh {csv}"` tried to serve a file literally named `{csv}`.
4. **A service scenario could pass without looking at the response.** The scenario's `run` only had to
   exit 0; a command that reached the surface and exited 0 passed whatever the surface said. The document
   declared a `url` and a `start` and nothing about the answer — the vacuous green (ADR-013) one level up
   from the output-shape guard.
5. **`deliverable.build` and `deliverable.tests` were dead text.** Nothing in the chain read either key:
   the delivered project's own tests are run from the WORKFLOW's `testCommand` (the `ci_config` step and
   the quality gate), and no install/build step exists in `request-to-delivery{,-attempt}/workflow.yaml`
   at all. A document that declared them READ as compliance while nothing ran — the same defect class as a
   key inherited through a merge (docs/bugs-fixed.md #47).

## Decision

**1. One invocation of the deliverable is ALWAYS bounded, in the judge and in the generated pipeline.**

`deliverable.timeoutMs` declares the bound for ONE invocation, in milliseconds. It is optional in the
document; the bound is not. When it is omitted the forge and the generated CI job apply
`DEFAULT_RUN_TIMEOUT_MS = 120000` (two minutes). A declared value below `MIN_RUN_TIMEOUT_MS = 1000` is
REFUSED at the front door and again in the forge — a bound nobody could apply is a refusal nobody sees.
The floor and the default live on their own lines in both languages (`RUN_MIN_TIMEOUT_MS=1000`,
`DEFAULT_RUN_TIMEOUT_MS=120000` in the shell) and a test parses the shell to keep the two honest.

**A bound that is hit is a FAILURE that names the command — never a pass, never a silent "no output".**
The judge reports it with the same wording as the mutation relation, so one kind of timeout reads the same
wherever it is hit:

> `not ok 1 - REL-001 row-order-invariance: … — the deliverable command timed out after 1000ms, so the
> deliverable was never exercised: sleep 30`

The generated job prints

> `the deliverable command did not exit within 1s and was killed, so this job fails instead of waiting out
> the runner's own limit: sleep 30`

and exits 124. The `|| { … }` keeps that message reachable under `bash -e`, where a bare failing command
would abort before it printed.

**2. `{csv}` is resolved wherever the judge runs a command the document declares** — in `deliverable.run`
(as before) and in a scenario's `start` and `run`. It resolves to the judge's own base fixture, the same
world the relations run against, so the surface a scenario starts and the world the judge judges are one
and the same file.

**3. A service scenario must ASSERT something about the response.** A scenario that declares a `url`
and/or a `start` must declare `expect_status` (an HTTP status 100–599) and/or `expect_body` (a non-empty
substring of the body). A document that declares a service scenario without either is REFUSED at the front
door and again in the forge:

> `SCN-001 declares a url/start but neither expect_status nor expect_body: a scenario that reaches a
> surface without asserting anything about the response passes without ever looking at it, so the check is
> vacuous — declare expect_status: <100-599> and/or expect_body: <substring of the response body>`

The JUDGE applies the assertion itself, before the scenario's `run` is invoked, so a scenario cannot pass
by running a command that merely reaches the surface. A mismatch FAILS naming both numbers (or the missing
substring):

> `the surface answered HTTP 500 where the document declares expect_status 200`
> `the response body does not contain the declared expect_body "station-table" (the surface answered HTTP 200)`

The listening-process model is deliberately minimal: the port is the one the DOCUMENT declares in its
`url` — the judge neither allocates nor randomises one — `start` brings the process up in its own process
group, the `url` is health-gated, the declared assertion is applied, the scenario's `run` executes, and
the process is torn down (TERM, then KILL, on success, failure and the report path alike).

**4. The health gate waits for the surface to ANSWER, not for it to answer 2xx.** The gate previously used
`curl -f`, which treats 4xx/5xx as "not up" — so a surface that answered 500 was reported as "did not
answer within 20s", a failure for the wrong reason that would have hidden the declared `expect_status`
behind a timeout. Whether the answer is the RIGHT one is the assertion's job. (The gate decides on curl's
exit status: `curl` still prints `000` when it cannot connect, and a printed `000` is not an answer.)

**5. `deliverable.build` and `deliverable.tests` are REFUSED, naming the key.** Nothing in the chain reads
or runs either one; the delivered project's own tests come from the workflow's `testCommand`, and no
install/build step exists. Dead text that reads as compliance is worse than a refusal, so the front door
names the key and says where the tests actually come from. The FORGE refuses the same two keys, so a
document that reached a judge without passing the front door cannot have one silently ignored.

## What a service-shaped delivery now requires

- `deliverable.run` — how the thing is STARTED (it may never exit).
- `deliverable.timeoutMs` — the bound on one invocation (optional; floor 1000; default 120000).
- A `scenarios` entry with `start`, `url`, `expect_status` and/or `expect_body`, and a `run` — the ONLY
  mechanism in the chain that starts a surface, waits for it, and asserts what it answers with.
- `input_format`/`output_format`/`relations`/`differential` — unchanged from ADR-033/ADR-035: the world
  the judge builds fixtures in and the invariants it checks from the output.
- NO `build` and NO `tests` key. The delivered project's tests are the workflow's business.

## What remains UNMODELLED (stated plainly)

- **Sandboxing.** The judge starts the surface as a child process in its own process group on the host.
  There is no container, no namespace, no filesystem or network isolation, and no resource cap beyond the
  bound. A malicious or merely careless `start` command runs with the judge's own privileges.
- **Port collisions across concurrent runs.** The port is the one the document declares in its `url`; the
  judge neither allocates nor randomises one, and it does not check that the port was free before
  starting. Two runs of the same document at the same time will collide, and the second run's scenario can
  then be answered by the FIRST run's surface — a green for the wrong reason. (This is why the port is
  documented as declared, not allocated: allocation would be the fix, and it is not built.)
- **Process supervision.** One surface per scenario, killed with TERM then KILL. There is no restart, no
  readiness protocol beyond "the url answers", no log capture beyond the surface log the judge writes, and
  no detection of a process that forks and outlives its group.
- **Non-HTTP surfaces.** `expect_status`/`expect_body` are HTTP. A surface reached over a socket, a
  message queue or a CLI session can only be judged by the scenario's `run` and its report.
- **The response assertion is a status comparison and a substring search.** It is not a JSON-schema check,
  not a header check, and not a content-type check. `expect_body: "total"` is satisfied by any body
  containing those five characters.
- **Build and install steps.** The chain has no build/install step at all, so a service that needs one
  cannot declare it — the refusal in §5 names the gap rather than pretending to fill it. The delivered
  project's tests are run from the workflow's `testCommand`, which the OPERATOR sets, not the document.
- **TLS, authentication and outbound network.** Out of scope; the declared url is whatever curl can reach.

## Evidence

`packages/core/src/test/service-shape.test.ts` (8 tests) drives the real validator, the real renderer, the
REAL forge and the GENERATED job run through `bash -e`:

- `deliverable.build`/`deliverable.tests` are refused, naming the key, for both keys — at the front door
  and again BY THE FORGE (with a control document that forges cleanly, so the refusal is about the key);
- `deliverable.timeoutMs` below the floor is refused, a non-number is refused, a valid one is accepted;
- a service scenario with neither assertion is refused; a bad `expect_status` is refused; one WITH an
  assertion is accepted;
- the deliverable bound is read from the deliverable block and never from a scenario's or the mutation
  block's `timeoutMs`;
- the generated `deliverable` job is bounded for github/forgejo/gitlab, and a `sleep 30` under a 1s bound
  FAILS with the message above (the generated script is EXECUTED, not merely inspected);
- a command that exits inside the bound still passes, and the default bound is applied when the document
  declares none;
- the forge's `RUN_MIN_TIMEOUT_MS`/`DEFAULT_RUN_TIMEOUT_MS` equal the TypeScript constants, and the forge
  runs the deliverable under `timeout`.

`packages/core/src/test/judge-forge-scenarios.test.ts` (11 tests) runs the REAL forge and the REAL judge
against a real fixture project whose `start` brings up a real HTTP surface:

- `{csv}` in a scenario's `start` resolves to the judge's fixture (the server echoes the argv it was
  handed, so the assertion can only pass if the literal `{csv}` did not survive);
- an `expect_status` the surface does not answer → `not ok … — the surface answered HTTP 500 where the
  document declares expect_status 200`;
- an `expect_body` the response does not contain → `not ok … — the response body does not contain the
  declared expect_body "station-table" (the surface answered HTTP 200)`;
- a service scenario with no assertion is REFUSED before a judge is forged;
- a deliverable command that never exits is bounded and reported as a failure naming the command.

RED-then-GREEN was captured by reverting each fix in place: with the bound removed the generated job
returned 0 for a `sleep 30` (RED) and with the `{csv}` resolution removed the served body lost `base.csv`
(RED); both are green with the fixes in place. The two pre-existing suite failures (the spike's document
tripping the new rules) are gone: `pnpm --filter @takumi/core test` is green.

## Consequences

- A service-shaped delivery is now expressible AND bounded end to end: the judge cannot hang, the
  generated pipeline cannot wait out the host's limit, and a service scenario cannot pass without looking
  at the response.
- The bound is unconditional, so it is one more thing every document carries implicitly. The document may
  tighten it but cannot remove it — an unbounded invocation is not a check.
- A `url`/`start` scenario now costs the document two more lines (`expect_status`/`expect_body`). That is
  the price of the check not being vacuous, and it is refused rather than defaulted: a default assertion
  would be the judge inventing the behaviour the human was supposed to state.
- Two facts now live in two languages again (the floor and the default), so the drift test parses the
  shell. The alternative — the judge reading the number out of the document — is what it already does for
  the DECLARED bound; the floor and default are the constants both sides must agree on.
