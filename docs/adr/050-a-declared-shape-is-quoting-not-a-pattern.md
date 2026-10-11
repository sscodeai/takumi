# ADR-050: A Declared Shape Is Quoting, Not A Pattern

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `extensions/judges/metamorphic-forge.sh` (the `output_format`
  reader's `strip_outer`, applied to both places a `shape` value is read). Tests in
  `packages/core/src/test/service-read.test.ts`.
- **Related**: ADR-013 (the vacuous green), ADR-033 (the document declares the world its judge checks),
  ADR-038 (the check itself can be wrong), ADR-046 (a service-shaped delivery is bounded and asserted),
  ADR-047 (a service's report is fetched, not printed), docs/bugs-fixed.md #56 (the same class, on
  `expect_body`), #60

## Context

The spike document declares its JSON output shapes the way YAML invites — single-quoted, because the
value contains double quotes:

```yaml
    station_line:
      shape: '{"station":"<station>","count":<count>,"min":<min>,"max":<max>,"mean":<mean>}'
```

The `output_format` reader stripped only DOUBLE quotes (`gsub(/^"|"$/, "", v)`), so the outer single
quotes stayed part of the shape, and `shape_re` — which escapes every non-placeholder character —
turned them into a pattern that demands a literal `'` at both ends:

```
GROUP_RE='^'\''\{"station":"([^ ]+)",...\}'\''$'
```

**A pattern like that cannot match a correct report.** The judge classified every line as unknown, and
every relation reported `the judge did not exercise the deliverable: nothing in its output (exit 0)
matched a declared output shape, so this relation is unproven`.

Two live measurements, and the second is the one that matters:

1. A `request-to-delivery` run whose implementation served **exactly** the declared shape (one JSON
   object per line, no stray quotes) scored **2 of 11** — REL-001..004 and DIFF-001 all unproven, SCN-001
   and DOC-001 passing. Reproduced in isolation from that run's head, deterministically.
2. An earlier implementation scored **11 of 11** — but it served every line wrapped in literal single
   quotes (`'{"station":"ALPHA",...}'`). Judge and implementation agreed on the same mistake, so the
   check passed while asserting nothing about the declared shape. **That was a false green, and it is
   the failure mode ADR-013 exists to prevent.**

This is the same defect class as ledger #56 (a body assertion that searched for a substring carrying the
document's own quotes), in a second reader: the rule "the outer quote pair is the quoting, not the
value" had been applied to the deliverable block and the scenario block, and not to `output_format`.

## Decision

**A declared shape is a VALUE, and the outer quote pair is the quoting.** Before a shape becomes a
pattern, strip a matched outer pair of EITHER kind — the same `strip_outer` the deliverable and scenario
readers use, in both places a shape is read (the inline `key: value` form and the nested `shape:` key).
One rule, every reader: a reader that strips quotes differently from its neighbours is a reader that
disagrees with them.

## Consequences

- An implementation that serves the declared shape correctly is no longer punished for it. The run that
  scored 2/11 scores **11/11** on the same head with the fixed forge, with no change to the implementation.
- An implementation that wraps its report in literal quotes now **fails**, which is correct: the document
  declares a JSON object, not a quoted one.
- The false green is closed. Where the judge and an implementation previously agreed on a mistake, the
  judge now states the shape it actually expects, so agreement means agreement.
- **The class recurred, and that is the lesson recorded here**: fixing the quote rule in two readers left
  a third. The next reader that parses a document value has to strip the same way, and the way to know is
  to grep for every place a value is read rather than to fix the instance in front of you.

## Evidence (RED then GREEN)

- RED: a test that forges a judge from a document with a single-quoted JSON shape and runs it against a
  service that serves that shape correctly →
  `not ok 1 - REL-001 … the judge did not exercise the deliverable: nothing in its output (exit 0) matched
  a declared output shape`, and the forged judge carried `GROUP_RE='^'\''\{…\}'\''$'`.
- GREEN: the same test passes; the forged regex is `GROUP_RE='^\{…\}$'`; `service-read` 6/6; the full
  `@takumi/core` suite **532 tests, 529 pass, 0 fail, 3 skipped**; `pnpm typecheck` and `pnpm -r build`
  rc 0.
- Real machine: the run's own head (`b10817a`, extracted from its worktree, unmodified) went from **2/11**
  to **11/11, `ACCEPT_VERDICT: pass`** with the fixed forge and the unchanged implementation.
