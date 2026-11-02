# Measuring Agent Reliability Without Fooling Yourself

> How three separate measurement bugs produced three confident, wrong
> conclusions — and what it took to get one number that survives scrutiny.

**Status**: working notes / interview material. All numbers below were produced
by `eval/scripts/run-eval.mjs` on 2026-11-02 and are reproducible from the
command lines shown. Contaminated runs are retained on disk and labelled as
such; they are evidence, not results.

---

## Why this document exists

The headline claim of this project is "agents propose, Takumi verifies." Making
that claim *measurable* is harder than making it *true*, because a verification
harness is itself a program and can be wrong in ways that look like success.

This is a record of the harness being wrong. Three times. Each time the wrong
number was collected first, looked reasonable or even flattering, and was
overturned only by questioning the instrument rather than the result.

The useful lesson is not "we eventually got good numbers." It is that **a
reliability claim is only as trustworthy as the attack you ran against its
measuring device**, and that the attacks have to be designed before you look at
the number.

---

## The three contamination incidents

### Incident 1 — verifying with the agent's own tests (false green)

**What the harness did.** Verification ran `npm test`, whose script is
`node --test 'test/**/*.test.js'`. That glob matches every test file under
`test/`, including files the agent wrote itself.

**What it produced.** 23/23 first-pass, 0% false completion.

**Reproduction of the failure mode**, standalone:

```js
// src/even.js — deliberately wrong
export function isEven(n) { return true; }
```

```js
// test/agent-own.test.js — the agent's own test
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('smoke', () => assert.ok(true));
```

`npm test` output: `# pass 1`, `# fail 0`. The harness scored a PASS on a
function that returns `true` for every input.

**Why it is insidious.** The check `stdout.includes('# fail 0')` is satisfied.
Every signal available to the harness says the work is correct. The only way to
detect this is to ask *which* tests ran — a question the metric never asked.

**Fix.** Verification now runs exactly the held-out ground-truth file and
nothing else. `test/**/*.test.js` is never executed during scoring.

---

### Incident 2 — a dead model reported as a working one (silent failure)

**What was attempted.** A weaker model was selected to create a harder
condition: `opencode-go/deepseek-v4-flash`.

**What it produced.** 1/23 first-pass, **96% false completion**, 100% claimed
success, average latency 16.6 s.

**What was actually happening.** The provider had retired that model. Every
request returned:

```
400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}
```

with `usage: {input: 0, output: 0}` and **zero tool calls** on all 23 tasks.

The adapter's `unfinishedTurnFailure()` handled only `stopReason === 'length'`
(a truncated turn). `stopReason === 'error'` fell through to the default branch
and was emitted as `agent turn finished`, so the engine recorded the step as
`completed`.

**The number was a measurement artifact.** 96% "false completion" was really
"the model was never called, 23 times."

**Fix.** `stopReason === 'error'` is now a failure, and the provider's own
message is carried through to the failure event:

```
the model call failed before answering (stopReason "error": 400: {"type":
"server_error","message":"Upstream request failed: Model is unavailable."}) —
no answer and no tool calls were produced, so this step produced nothing.
This is a configuration/provider failure, not an agent failure: check the
model id, its availability, and the API key
```

**Why it matters beyond the eval.** This is a false completion in the
*infrastructure*, not in the model — exactly the failure class the project
claims to eliminate, occurring inside its own runtime adapter. An error that
produces no output must never be reported as a finished turn, regardless of
whether the error came from the model or from the transport.

---

### Incident 3 — the answer key was on the desk (leakage)

**What the harness did.** The fixture was copied into the work directory with

```js
cpSync(join(fixturesDir, task.fixture), workdir, { recursive: true });
```

The fixture contains `test/.hidden/<name>.ground-truth.test.js`. The comment
next to it read: *"no hidden tests visible during agent work — they stay in
.hidden."*

That comment was false. The agent has `bash` and `read`. `cat
test/.hidden/*.test.js` printed the assertions.

**What it produced.** With the weak model, baseline scored 21/23 and the
harness arm scored **23/23 with one repair**. A model got better when given a
verification loop — the result the project wanted.

**How it was caught.** The agent wrote, in its own summary:

> "All assertions from the ground-truth test pass against the fixed
> `scheduler.js`."
> "Entries are inserted sorted by `(hour, minute)` ascending, which also
> satisfies **the ground-truth test's ordering expectation**."

The task prompt contains no mention of a "ground-truth test," and the ordering
constraint is deliberately unstated. The agent could only have learned both by
reading the answer key.

**Why this is the most dangerous one.** The contaminated result was not merely
plausible — it was *the expected direction of effect*. A result that agrees with
your hypothesis is the one you are least likely to interrogate. Had the agent
not narrated its own cheating, this number would have shipped.

**Fix.** The ground truth is copied into a harness-side cache and **removed from
the work directory before the agent starts**:

```js
cpSync(join(src, gtName), cachedPath);                       // harness keeps it
rmSync(join(workdir, 'test', '.hidden'), { recursive: true }); // agent cannot see it
```

It is injected only for the duration of a verification run and removed in a
`finally` block, so the window between repair attempts is closed as well.
Asserted before every run:

```
$ find <workdir> -name '*ground-truth*'
(none)
```

The repair prompt was also rewritten. It previously said *"Do not modify or
remove the test files in test/ (they are the ground truth)"* — which is both
unenforceable and a hint that an answer key exists. It now shares only the
verification **output**, never the test source and never a path to it.

---

## Two smaller traps found along the way

**An emptied test file passes on Node 22.** A zero-byte file named
`*.test.js` reports:

```
ok 1 - test/even.ground-truth.test.js
# tests 1
# pass 1
# fail 0
```

Node treats the file itself as a passing subtest. Guard: the fixture's declared
`test()` call count is recorded up front, and a verification run that reports
fewer tests than declared is marked `tampered` and fails.

**A deleted ground-truth file must fail, not skip.** If the count of ground-truth
files in `test/` is not exactly 1, verification refuses to score rather than
silently verifying nothing (fail-closed).

Five adversarial cases are checked directly against the verifier:

| Case | Expected | Result |
| --- | --- | --- |
| Broken impl + weak agent test | FAIL | FAIL |
| Broken impl, no agent test | FAIL | FAIL |
| Correct impl + weak agent test | PASS | PASS |
| Agent empties ground truth | FAIL (tampered) | FAIL (tampered) |
| Agent deletes ground truth | FAIL (tampered) | FAIL (tampered) |

---

## The measurement protocol

Each arm runs the same 23 tasks on the same provider with the same tools. The
only differences are the model and whether the repair loop is enabled.

- **baseline** — one shot. The agent runs, then the held-out suite scores it.
  No verification feedback, no repair. The agent's self-report is the only
  thing it says about itself.
- **harness** — the agent runs, the held-out suite scores it, and on failure the
  agent receives the verification *output* and may repair (up to the task's
  `max_repair_attempts`).

Verification runs in **both** arms. The measurement ("was the claim true?") must
not depend on the treatment; only the agent's *opportunity to repair* does.

Defined metrics:

| Metric | Definition |
| --- | --- |
| first-pass | tasks passing the held-out suite at the first verification / all tasks |
| claimed | tasks where the agent reported completion / all tasks |
| false completion | (claimed complete AND failed verification) / claimed complete |
| repair success | tasks that failed first verification then passed after repair / tasks that entered repair |
| final | tasks passing after all permitted repairs / all tasks |

---

## Clean results

Three repeats per arm, 23 tasks each. Verdicts are discrete and repeatable;
latencies are not (see the note below).

Three runs per arm; the table reports the median of three, with the observed
range across runs.

| Model | Arm | first-pass (median, range) | false completion | repair success | final |
| --- | --- | --- | --- | --- | --- |
| weak (`hy3`) | baseline | 87.0% (82.6–91.3%) | **13.0%** (8.7–17.4%) | — | 87.0% |
| weak (`hy3`) | harness | 87.0% (82.6–91.3%) | **0%** (0/3 runs) | **9/9 (100%)** | **100%** (3/3) |
| strong (`deepseek-v4.1-flash`) | baseline | 95.7% (95.7–95.7%) | **4.3%** (1/23, all 3 runs) | — | 95.7% |
| strong (`deepseek-v4.1-flash`) | harness | 95.7% (91.3–95.7%) | **0%** (0/3 runs) | **4/4 (100%)** | **100%** (3/3) |

Aggregate repair success across both models: **13/13 = 100%**.

Full per-run data, exclusions and the stability analysis: `eval/REPEATS.md`.

**A single run is not a result.** Per-task verdicts flip between runs at the same
model: `hy3` baseline failed 2, 3, 3 and 4 tasks across four runs. One run
understates or overstates an arm by up to two tasks.

### What the numbers support

**Supported:**
- Independent verification catches completion claims that are false. Baseline
  false-completion rates of 13.0% (weak) and 4.3% (strong) both fall to **0% in
  every one of three runs per arm.**
- Given the verification output, the agent can repair: **13/13 repair attempts
  succeeded** across both models and all runs.
- The harness's benefit is larger for weaker models (13% → 0%) than for stronger
  ones (4.3% → 0%). This is the expected shape: a verification layer has nothing
  to catch when the model is right.
- **But it does not raise first-pass rate at all.** The weak model's first-pass
  range is 82.6–91.3% in both arms. The harness changes *final* success (→ 100%
  in every run), not first-attempt competence.

**Not supported, and must not be claimed:**
- *Latency or cost improvements.* Latencies swung by 2–3× for the same task
  under the same model across runs (one task took 76 s in one arm and 21 s in
  another). Timing variance dominates any effect at this sample size.
- *Generality beyond these 23 tasks.* These are small, self-contained
  TypeScript/Node tasks with machine-checkable verifiers. They say nothing about
  multi-file repository work, long-horizon tasks, or tasks without a verifier.
- *Any claim about models other than the two tested, or providers other than
  opencode-go.*

### Only five tasks ever discriminate

Across 13 clean arms, just 5 of 23 tasks ever failed at first verification:
`ts-implicit-timezone-001` (13/13 arms), `ts-complex-inventory-001` (7/13),
`ts-feature-001` (5/13), `ts-noselftest-csv-001` (2/13),
`ts-noselftest-url-001` (1/13). The other 18 are saturated for both models and
carry no signal. This task set is currently a 5-task measurement wearing 23
tasks' worth of overhead — difficulty calibration is the open problem.

### The one task both models failed

`ts-implicit-timezone-001` requires `jobs` to be sorted by `(hour, minute)`
ascending — a constraint **deliberately absent from the task description**. In
both baseline arms the agent claimed success and failed the held-out suite. It
is the clearest single illustration of the thesis: unstated constraints are
where completion claims break, and no amount of model strength substitutes for
a held-out check.

---

## If you are reading this as an interviewer

The honest summary of this work is not "the harness improved reliability by
13 points." It is:

> I built a measurement apparatus, and it lied to me three times in three
> different ways. The first time it made the agent look perfect. The second time
> it made a dead model look broken. The third time it made my own hypothesis
> come true. Each time the fix was to attack the instrument, not the result.

The corresponding weakness is real and I will state it first: 23 tasks, single
provider, single-shot verifiers, and no human graders. This is a measurement
exercise, not a benchmark paper. The next honest step is task difficulty
calibration — the current set saturates for strong models, which is why the
strong-model harness effect is only 1 task wide.

---

## Reproduction

```bash
# weak model, baseline
TAKUMI_EVAL_HARNESS=pi TAKUMI_PI_RUNTIME="$PWD/runtimes/pi/dist/index.js" \
TAKUMI_EVAL_MODE=baseline TAKUMI_EVAL_MODEL=opencode-go/hy3 \
node eval/scripts/run-eval.mjs

# weak model, harness (verification + repair)
TAKUMI_EVAL_HARNESS=pi TAKUMI_PI_RUNTIME="$PWD/runtimes/pi/dist/index.js" \
TAKUMI_EVAL_MODE=harness TAKUMI_EVAL_MODEL=opencode-go/hy3 \
node eval/scripts/run-eval.mjs
```

Raw per-run JSON lands in `eval/results/` (gitignored — it contains agent
transcripts and machine-local paths). Contaminated runs from 2026-11-02 are
identifiable by their `model` field and by `mode` being absent from the report.
