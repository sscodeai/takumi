# Requirement intake prompt

You are a requirements analyst. Turn the incoming request below into ONE
structured requirement document. You do NOT design or implement anything.

## Incoming request

{input}

## Output contract

Write the document to `docs/requirements/intake.yaml` (create the directory if it
does not exist) AND emit it as your answer, exactly one YAML document and nothing
else: no prose before it, no prose after it, no markdown fence. The file is what the
loop reads -- a document that exists only in the conversation is a document the next
step cannot confirm -- and the text of that file is what the confirmation hashes.

The document has three top-level keys: `requirements`, `ambiguities`, and `deliverable`.

```yaml
requirements:
  - id: REQ-001
    title: "Short imperative title"
    description: "What must hold, in behavioural terms"
    acceptance_criteria:
      - "An independently checkable statement"
    priority: High
    source: "Where in the request this came from"
  - id: REQ-002
    title: "..."
    description: "..."
    acceptance_criteria:
      - "..."
    priority: Medium
    source: "..."
ambiguities:
  - id: AMB-001
    question: "The decision the request leaves open"
    options:
      - "First bounded option: skip the row and count it"
      - "Second bounded option: stop with an error"
    default: "First bounded option: skip the row and count it"
    chosen: "First bounded option: skip the row and count it"
    checkedAs: skip-count        # ON THE DECISION: what the chosen answer means to a judge
    blocking: true
  - id: AMB-002
    question: "When the group key repeats, which occurrence wins?"
    options:
      - "merge: every occurrence counts as its own reading"
      - "last-row: only the last occurrence is kept"
    default: "merge: every occurrence counts as its own reading"
    chosen: "merge: every occurrence counts as its own reading"
    checkedAs: merge             # ON THE DECISION, never on the relation that settles it
    blocking: true
  - id: AMB-003
    question: "How do the numbers round when the answer is recomputed independently?"
    options:
      - "half-up: round half away from zero"
      - "truncate: drop the remainder"
    default: "half-up: round half away from zero"
    chosen: "half-up: round half away from zero"
    checkedAs: half-up           # ON THE DECISION, never on the anchor that settles it
    blocking: true
deliverable:
  run: "bash summary.sh {csv}"          # how a judge invokes the thing; {csv} is the input file
  timeoutMs: 120000                     # optional: the bound on ONE invocation (floor 1000; default 120000)
  input_format:                         # the WORLD a judge builds its fixtures in: it has no other source
    columns: "date:date,station:id,temperature_c:measure"   # name:role, in file order
    sample: |                           # >= 3 real rows, >= 2 distinct ids, numeric measures
      2024-01-01,ALPHA,10.4
      2024-01-01,BRAVO,-2.5
      2024-01-02,ALPHA,11.6
  output_format:
    station_line:
      shape: "<station> <count> <min> <max> <mean>"
      fields: [id, count, min, max, mean]       # one role per <placeholder>, in order
    total_line:
      shape: "TOTAL <count>"
      fields: [count]
  scenarios:                            # the surface a person LOOKS AT, when the request asks for one
    - id: SCN-001
      run: "bash e2e/check.sh"          # required: exits 0 when the scenario holds
      expect: "the page lists one row per station with count, min, max and mean"   # required, in words
      start: "python3 -m http.server 8731 -d site"    # optional: the judge starts this and always kills it
      url: "http://127.0.0.1:8731/index.html"         # optional: the judge waits for this before running
      expect_status: 200              # REQUIRED when `url`/`start` is declared: what the surface must answer
      expect_body: "station"          # and/or a substring the response body must contain
      report: ctrf                    ## optional: one of the three formats below (see rule 13)
      report_path: "e2e/report.json"  # required when `report` is given
  relations:                            # what a judge must be able to CHECK, from output alone
    - id: REL-001
      relation: malformed-row-accounting
      decides: AMB-001
      description: "A bad row is skipped and counted the way AMB-001 decided."
    - id: REL-002
      relation: additivity
      description: "The per-station counts sum to the printed total count."
    - id: REL-003
      relation: duplicate-resolution
      decides: AMB-002
      description: "A repeated station id resolves the way AMB-002 decided."
    - id: REL-004
      relation: mutation-detection
      description: "The delivered tests fail when the delivered behaviour is mutated."
  differential:
    - id: DIFF-001
      anchor: independent-aggregation
      decides: AMB-003
      description: "An independent recomputation of the summary matches the tool's output."
  mutation:                             # how the mutation-detection relation runs its tool (see rule 16)
    run: "npx stryker run --reporters json"       # required: how the judge runs the tool, in the worktree
    report_path: "reports/mutation/mutation.json" # required: where the tool writes its verdict
    format: survivors-json              # required: only survivors-json is implemented for now
    max_survivors: 0                    # required: how many uncaught mutants are tolerated (usually 0)
    timeoutMs: 900000                   # optional: a mutation run is many test runs (default 900000)
```

## Rules

1. `requirements[]` is never empty for a non-empty request. Use `REQ-nnn`
   ids in order starting at `REQ-001`, and give each requirement at least one
   acceptance criterion.
2. Every decision point the request does not settle becomes an `AMB-nnn`
   entry. Do not silently choose an interpretation and drop the question.
3. Each ambiguity has 2 to 4 `options`. They must be mutually exclusive and
   bounded — not open questions.
4. `default` must be exactly one of that ambiguity's `options`.
5. `blocking: true` when implementation must not start until a human decides;
   `blocking: false` when the decision can be deferred but recorded.
6. An intake with an empty `ambiguities` list is valid only when the request
   genuinely leaves nothing undecided. Never pad with invented questions, and
   never omit a real one.
7. Emit nothing around the YAML document.

## The `deliverable` block: the contract a judge is forged from

The acceptance of this flow is a JUDGE GENERATED FROM THIS BLOCK, not from the implementation
(ADR-026): it runs the deliverable against fixtures it makes itself and checks the relations you
declare. So the block is a requirement like any other — and the implementer must be able to satisfy it
from your text alone.

8. `run` is the invocation, and the requirement text MUST state the same entry point: name the script
   the deliverable has to provide (for example `summary.sh` at the repository root, taking the input
   file as `$1`), so an implementer who only reads this document knows what to build. `{csv}` is
   replaced with a fixture path when the judge runs it.
9. `output_format` declares the EXACT line shapes a judge may parse. A judge that has to guess a format
   is a judge that checks something you did not write. Each machine-readable shape also declares the
   MEANING of its placeholders, positionally, as `fields:` from this list — and only this list:
     - `id`:            the group key the line is about (station, department, employee …)
     - `count`:         how many rows the group counted
     - `sum`:           the group's total of the measure column
     - `min` / `max`:   the smallest / largest measure in the group
     - `mean`:          the group's average of the measure
     - `skipped-count`: how many rows were skipped (the line a `skip-count` decision promises)
   The number of `fields` must equal the number of `<placeholders>` in the shape, and at least one shape
   must declare its fields: a judge can compare two runs without them, but it cannot say which number is
   the count, so the whole document is refused.
10. `input_format` declares the data the whole thing is ABOUT, and it is what the judge generates its
   fixtures from — reshuffled, duplicated and mangled versions of YOUR sample. `columns` is a flat list of
   `name:role` pairs in file order, where a role is `id` | `measure` | `date` | `other`: exactly one
   column must be `id` (the group key the report prints), exactly one must be `measure` (every aggregate
   is computed from it), at most one may be `date` (needed when a decision orders rows by date). `sample`
   holds at least three real data rows (no header line), each with one field per declared column, at least
   two distinct ids and numeric values in the measure column. A missing or unreadable world, an unknown
   role, two measures, a one-id sample or a non-numeric measure is REFUSED before the human confirms:
   without it a judge would invent a world and judge a scenario nobody asked for.
11. `relations` are the invariants a judge must be able to check from the output alone, each `REL-nnn`
    with a `relation:` from this list — and only this list, because these are the ones the forge can
    implement:
      - `row-order-invariance`   the result does not depend on the order of the input rows
      - `additivity`             the parts sum to the whole the tool itself printed
      - `duplicate-resolution`   what happens when a key repeats (needs a decision)
      - `malformed-row-accounting`  what happens to a bad row (needs a decision)
      - `independent-aggregation`   recompute the answer independently and compare (differential)
      - `browser-scenario`       run a declared end-to-end scenario of the surface and judge it by the
                                 command's exit code and the report it writes (see rule 13)
      - `mutation-detection`     the delivered TESTS fail when the delivered behaviour is mutated — the
                                 judge runs the mutation tool the document declares and reads its report
                                 (see rule 16)
    A relation outside this list will be REFUSED at acceptance time (after the implementation has been
    paid for), so use only these. Every BLOCKING decision must be settled by one of them, through
    `decides: <AMB-nnn>` — a blocking decision that no relation exercises is refused as well. A decision
    that genuinely needs an answer outside this vocabulary must be marked blocking: false, and the
    requirement text must say plainly that no judge checks it yet.
12. **Say what each answer MEANS to a judge.** Prose is for humans; a judge needs to know which
    behaviour to test, and it will not guess from a sentence. Every decision that a `duplicate-resolution`,
    `malformed-row-accounting` or `independent-aggregation` relation settles must carry
    `checkedAs: <mode>` from that relation's list:
      - `duplicate-resolution`:      `first-row` | `last-row` | `latest-start-date` | `merge` | `error`
        (which row wins, or whether repeated rows are merged into one aggregate, or whether a repeat is an
        error)
      - `malformed-row-accounting`:  `skip-count` | `skip-silent` | `stop-error`
        (skipped and counted, skipped silently, or a hard failure)
      - `independent-aggregation`:   `half-up` | `truncate`   (how numbers round in the recomputation)
    A decision settled by `row-order-invariance` or `additivity` needs no `checkedAs`: those check a
    property of the output, not the meaning of an answer. `checkedAs` goes ON THE `AMB-nnn` ENTRY (`chosen:`, then `checkedAs:`), NEVER on a relation or an
 anchor: the relation says WHICH decision it settles (`decides:`), the decision says what its answer
 MEANS. A missing `checkedAs`, a `checkedAs` outside the list above, or one written on the relation
 instead of the decision is REFUSED — before the human confirms it, and again when the judge is
 forged — so put it in the right place (the first real run of this prompt put all three on the
 relations and the gate refused the document, which is the gate working).
13. `scenarios` declares end-to-end checks of a surface a person interacts with (a page, a CLI session, a
    service). The judge runs YOUR commands: it starts what `start` names, waits for `url` (it waits for
    the surface to ANSWER, not for it to answer 2xx), APPLIES the response assertion you declare, runs
    `run`, reads the `report` at `report_path` when one is declared, and always kills what it started. A
    scenario that exits 0 but whose report counts a failing test FAILS; a report that cannot be read
    FAILS — never a silent pass. `{csv}` in `start` and in `run` is replaced with the fixture the judge
    generated, exactly as in `deliverable.run`.
    A scenario that reaches a surface (`url` and/or `start`) MUST say what it asserts about the response,
    with `expect_status: <100-599>` and/or `expect_body: <substring of the response body>`. Without one the
    check is VACUOUS BY CONSTRUCTION: `run` only has to exit 0, so a command that reaches the surface but
    never looks at it passes whatever the surface said. The judge applies the assertion itself, so a
    service scenario cannot pass without looking at the response.
    Give at most a few scenarios, each naming one thing a human would check; a scenario whose only test is
    "the command exited 0" is worth less than a `relation` that recomputes a number. Refused before a human
    confirms: no `run`, no `expect`, `report` without `report_path` (or the reverse), a `report` outside
    the three formats, `url` with nothing to `start`, `url`/`start` with neither `expect_status` nor
    `expect_body`, an `expect_status` outside 100..599, ids that are not `SCN-nnn` in order.
14. `differential` declares at least one anchor (`DIFF-nnn`) that recomputes part of the answer
    independently of the tool's own arithmetic. Equality with the tool's own output is not a check.
15. Prose criteria that no fixture can decide (performance, file-size limits, human readability) stay as
    acceptance criteria on their requirements and are NEVER claimed by a relation: the judge reports them
    as not mechanised, and a criterion reported as checked when it is not is the worst thing you can
    emit here.
16. `mutation-detection` is the one relation that asks whether the delivered TESTS can fail. It is the
    check the vacuous-green guard cannot make: the deliverable ran, its tests passed, and they would have
    passed for a wrong implementation too. The judge injects nothing itself — it runs the mutation tool
    the document declares, reads the report that tool writes, and requires the delivered tests to fail on
    the mutants. One `mutation:` block inside `deliverable` configures it (one block per document):
      - `run`: how the judge runs the mutation tool, in the delivery worktree (required);
      - `report_path`: where the tool writes its verdict, relative to the worktree (required);
      - `format`: the report format — `survivors-json` only, for now (required);
      - `max_survivors`: how many uncaught mutants are tolerated, a non-negative integer, usually 0 (required);
      - `timeoutMs`: the bound for the whole run, at least 5000 (optional; default 900000).
    `survivors-json` is a tool-agnostic report, `{"total": <int>, "survivors": [{"file": "...", "line":
    <int>, "description": "..."}, ...]}` — wrap any tool into it. The judge fails closed when the tool did
    not run, the report is missing or unreadable, its shape is not the declared format, or it measured
    zero mutants: a mutation check that could not run is NEVER a pass. It is the most expensive check in
    the vocabulary (a suite run once per mutant), so declare it only when the request is worth it.
    REFUSED before a human confirms: a `mutation-detection` relation with no `mutation:` block, a
    `mutation:` block with no relation using it, an unknown `format`, a `max_survivors` that is not a
    non-negative integer, and a `timeoutMs` below the floor.
17. The invocation of the deliverable is ALWAYS BOUNDED. A service-shaped `run` STARTS the thing and never
    exits, so an unbounded invocation is not a check — it is a hang that ends as a timeout for the wrong
    reason. `deliverable.timeoutMs` tightens the bound for one invocation (a whole number of milliseconds,
    at least 1000); when it is omitted the judge and the generated CI job apply the default of 120000.
    A bound that is HIT is a FAILURE that names the command ("the deliverable command timed out after
    <n>ms, so the deliverable was never exercised: <command>"), never a pass and never a silent "no
    output"; and the generated CI `deliverable` job runs the command under the same bound, so a
    start-and-serve command fails the job by name instead of waiting out the runner's own limit.
18. `deliverable.build` and `deliverable.tests` are REFUSED. Nothing in the chain reads or runs either
    one: the delivered project's own tests are run from the WORKFLOW's `testCommand`, and no install/build
    step exists at all. A declaration that is never executed reads as compliance, which is worse than a
    refusal — so if the request needs a build or a test step, say it in the requirement text and in the
    acceptance criteria, never as a `deliverable` key.
