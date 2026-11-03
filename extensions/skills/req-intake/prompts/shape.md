# Intake, step 1: what KIND of answer is this?

You are deciding ONE thing about the request below, before any document is written. You are NOT writing
the document, and you are NOT designing or implementing anything.

## Incoming request

{input}

## The one decision

Look at what NUMBER the delivered tool must PRINT for each group, and say which of two shapes of answer
that number is:

**(A) AN AGGREGATE OF A PER-ROW MEASURE.** The request asks for a count, a total, a minimum, a maximum,
or an AVERAGE of a column of numbers that already exist in the input — "the total salary per department",
"the mean temperature per station", "the highest score per student". The answer is computed by summing,
counting, or averaging the input's own values.

**(B) A QUOTIENT — a percentage or a rate.** The request asks for a figure that is one count DIVIDED BY
another count: "availability", "pass rate", "hit rate", "success rate", "conversion", "error rate",
"percentage", "what fraction", "how often". The answer is a division, and the two counts are usually both
printed next to it.

## Decide from the ANSWER, never from the input

These phrases describe the INPUT and must NOT decide the question. A request can contain them and still
have a quotient for an answer:

- "skips malformed rows", "reports how many it skipped"
- "handles duplicate ids", "the same name may appear twice"
- "order does not matter", "any order"
- "a header row", "comma separated"

Measured 2026-10-27, five times: a request for a pass PERCENTAGE that also said "reports how many it
skipped" was written as shape (A) every time, because skipping rows reads like a record-shaped thing to
say. The answer was a percentage, the judge had nothing it could check, and every run was refused.

The tell: if the request names a unit like "percent", "%", "rate", "ratio", or "fraction", or if the
number is described as one count out of another ("passes divided by total", "failures out of probes"), the
answer is **(B)** — no matter what it says about rows, duplicates or ordering.

## The second thing: the entry point

The document you are handing off also has to name HOW the delivered thing is invoked, and the
implementer and the judge both read that one line. Measured 2026-10-29, three times: the document
block `deliverable:` came out with NO `run` at all, so the judge had no way to invoke anything and
every run died before a line of code was written.

The rule is already written in the document prompt ("`run` is the invocation, and the requirement
text MUST state the same entry point"). It was ignored there, because it sits among eighteen others.
So decide it HERE, where it is the only other thing on the page:

- Name ONE command that runs the tool on a CSV file given as its first argument, in the form
  `bash <name> {csv}` — the literal `{csv}` is replaced with a fixture path by the judge.
- Pick a script name that says what the tool does (`summary.sh`, `tally.py`, `report.sh`). It lives
  at the root of the delivered repository.
- Use the interpreter the file extension implies: `bash x.sh`, `python3 x.py`, `node x.mjs`.
- A one-file command-line tool that reads a CSV is what these requests ask for. Do not invent a
  package, a subcommand, or a build step.

## The third thing: which relations are even possible

The judge can check some relations on a ratio report and some on an aggregate one, and the split is
not a matter of taste — it follows from the fields. Getting this wrong has cost five separate runs,
including one on 2026-11-04 that declared `independent-aggregation` on a ratio line and was refused
before a line of code was written.

So write the list yourself, from the shape you just chose. Copy the line for your answer EXACTLY:

**If `ANSWER_SHAPE: QUOTIENT`** (the printed number is a division):

```
ALLOWED_RELATIONS: derived-ratio, row-order-invariance, mutation-detection, browser-scenario
```

**If `ANSWER_SHAPE: AGGREGATE`** (the printed number is a count, total, min, max or mean):

```
ALLOWED_RELATIONS: independent-aggregation, additivity, duplicate-resolution, malformed-row-accounting, row-order-invariance, mutation-detection, browser-scenario
```

Why the difference, so you can apply it rather than copy it: `additivity`, `duplicate-resolution`,
`malformed-row-accounting` and `independent-aggregation` all work by recomputing COUNTS and SUMS from
the input records and requiring those numbers on the report line. A ratio line prints a numerator, a
denominator and the ratio — it has no count or sum for them to find, so those four cannot check it.
`row-order-invariance` needs no fields at all (it shuffles the input and compares the two reports), and
`mutation-detection` and `browser-scenario` run commands, so all three work for either shape.

## Your answer

Answer with EXACTLY these six lines and nothing else:

```
ANSWER_SHAPE: AGGREGATE
```
or
```
ANSWER_SHAPE: QUOTIENT
```
followed by:

```
THE_NUMBER_IS: <one short phrase naming the printed number, e.g. "mean salary per department" or "pass percentage per suite">
THE_TWO_COUNTS_ARE: <for QUOTIENT only: what is divided by what, e.g. "passes divided by total runs". Write NONE for AGGREGATE.>
ENTRY_POINT: bash <name> {csv}
ALLOWED_RELATIONS: <the exact list above for your shape, copied verbatim>
WHY_NOT_THE_OTHER: <one sentence: why the other shape does not express this number>
```

Do not write a requirement document. Do not write YAML. Do not list requirements or decisions. The next
step does that, using your answer.
