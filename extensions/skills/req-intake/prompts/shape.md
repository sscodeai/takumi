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

## Your answer

Answer with EXACTLY these four lines and nothing else:

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
WHY_NOT_THE_OTHER: <one sentence: why the other shape does not express this number>
```

Do not write a requirement document. Do not write YAML. Do not list requirements or decisions. The next
step does that, using your answer.
