# ADR-033: The Document Declares The World Its Judge Checks

- **Date**: 2026-10-05
- **Status**: Accepted (`input_format`/`output_format` parsing and the refusals in
  `packages/core/src/requirement-decisions.ts`, `JUDGE_COLUMN_ROLES`/`JUDGE_FIELD_ROLES`; the fixture
  generator and aggregator in `extensions/judges/metamorphic-forge.sh`; the `input_format` block in
  `docs/requirements/intake.yaml`; tests in `packages/core/src/test/judge-forge-decisions.test.ts`)
- **Related**: ADR-025 (acceptance bound to the confirmed document), ADR-026 (the judge is forged
  outside the implementer's context), ADR-028 (a decision is only real if it is checked), ADR-031
  (the document declares what its answers mean), ADR-013 (the vacuous green), bug ledger #37

## Context

The forged judge (ADR-026) is generated from the confirmed document's `deliverable` contract: how to
run the thing, the relations to check, and a differential anchor. It ran in a worktree with no access
to the implementation and did not read it. That was the third ring, and it worked -- for the one
scenario the flow was built on.

The first real end-to-end run that reached an acceptance made the gap concrete
(`/tmp/i7-delivery.log`, lines 176-181):

```
requirement: docs/requirements/intake.yaml sha256:021f16e4ac66
verdict: fail
checks: 2/10 ok
ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing
not ok 2 - REL-002 additivity: department totals sum to 0 but the report says  — sum=0 reported=
not ok 3 - REL-003 duplicate-resolution: the chosen option "merge" does not hold (headcount 0 want 5,
  late-date total  want 628, early-date total  want 628) — headcount=0/5 totals=/628,/628
```

The requirement was about temperature stations (`date,station,temperature_c`); the judge's fixtures
were employee/department rows (`employee_id,name,department,start_date,annual_salary`), its parser
looked for `DEPT <dep> <count> <total>`, and its row-validity predicates were for five fields and a
numeric salary. "department totals", "headcount", the empty `want` values — all of it was the forge's
own world. And `ok 1 - REL-001` PASSED because both sides were empty: the station tool printed
nothing for an employee CSV, and the judge compared two empty results. The rejection was right about
the format of the loop and wrong about the delivery (bug ledger #37).

The forge read the document's RELATIONS and DECISIONS and nothing else, so it had to supply both the
input world and the output world itself. The document had no way to say what its columns or its
output fields MEAN.

## Decision

1. **The document declares its input world.** The `deliverable` block carries an `input_format`: a
   typed column list and a sample.

   ```yaml
   input_format:
     columns: "date:date,station:id,temperature_c:measure"
     sample: |
       2024-01-01,ALPHA,10.4
       2024-01-01,BRAVO,-2.5
       2024-01-02,ALPHA,11.6
       2024-01-02,BRAVO,-1.5
       2024-01-03,ALPHA,9.5
   ```

   (`docs/requirements/intake.yaml`, lines 130-137.) The roles are a closed set --
   `JUDGE_COLUMN_ROLES = ['id', 'measure', 'date', 'other']` -- and the format is a flat, shell-parsable
   list because the forge reads the document line-wise.

2. **The document declares its output shapes, positionally.** Each `output_format` entry has a
   `shape` and the roles of its placeholders, in order:

   ```yaml
   output_format:
     station_line:
       shape: "<station> <count> <min> <max> <mean>"
       fields: [id, count, min, max, mean]
     skipped_line:
       shape: "SKIPPED <count>"
       fields: [skipped-count]
     total_line:
       shape: "TOTAL <count>"
       fields: [count]
   ```

   The roles are a closed set -- `JUDGE_FIELD_ROLES = ['id', 'count', 'sum', 'min', 'max', 'mean',
   'skipped-count']`. The shape's placeholder count must equal the `fields` length, because the roles
   are positional.

3. **The forge builds its fixtures by transforming the declared sample, and computes every
   expectation from it.** From the document's `sample` the forge generates `base`, `ord-base`,
   `ord-reversed`, `dup-late-date`, `dup-early-date` and `malformed` (observed on disk under
   `.takumi/acceptance/judge_forge/fixtures/`). Every expected number is computed by the forge's own
   awk aggregator over the declared columns -- no expected value is written into the forge. The
   output is parsed through the declared shapes and roles: `<placeholder>` becomes a positional
   capture, so the same judge can read a document it has never seen.

4. **The document is refused before a human confirms if it cannot be judged this way.** The validator
   refuses: a document with no `input_format`; a column role or field role outside the closed sets; a
   count of `id` columns other than exactly one ("the judge groups rows by the id column"); a count of
   `measure` columns other than exactly one ("the judge computes every expectation from it"); more
   than one `date` column; a sample of fewer than three rows; a sample whose rows do not have one
   field per declared column; a sample whose measure column holds a value that cannot be added; a
   sample naming fewer than two distinct ids; output lines that declare no fields; a field/placeholder
   count mismatch; and a `checkedAs: latest-start-date` with no `date` column to order by. The forge
   refuses the same cases again at acceptance time.

5. **The vacuous green is gone.** When the deliverable's output matches no declared shape, NO relation
   may pass by comparing two empty results. The guard reads the base output and, finding nothing
   parseable, fails every relation:

   ```
   not ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing — the judge did not
     exercise the deliverable: nothing in its output (exit 0) matched a declared output shape, so
     this relation is unproven
   ...
   # tests 10
   # pass 1
   # fail 9
   ACCEPT_VERDICT: fail
   ```

   (`extensions/judges/metamorphic-forge.sh`, lines 855-864; reproduced by pointing the forged judge
   at a `summary.sh` that prints nothing and exits 0.)

## Consequences

- The document -- not the forge -- decides which scenario gets judged. A document about any other
  world is now judged in that world, and bug ledger #37's failure (an employee world judging a
  station delivery, one relation passing on two empties) cannot recur for a document that declares
  its world, because the validator refuses a document that does not.
- The judge got materially larger: the fixture generator and the awk aggregator are now driven by
  declared columns and roles, and the forge's world-specific fixtures and predicates are gone
  (`git show --stat 0e10d0b`: `extensions/judges/metamorphic-forge.sh` +763/-220).
- **The cost is that a requirement document now has to describe its data.** The intake has to name
  every column's role and a sample, and every machine-readable output shape's fields, or the document
  is refused. That is the intended pressure -- a world nobody described is a world the judge would
  have invented -- and it is more work per document.

### Limits, stated plainly

These were reported by the implementer and re-read against the forge; they are true.

- **Row validity is only field-count, non-empty id, numeric measure, and ISO date.** There is no way
  to declare a stronger validity predicate (a range, a column that must be one of a set, a
  cross-field rule). A row the document considers invalid but the forge's four checks accept will be
  counted as valid by the judge.
- **There is no per-role precision or rounding field.** The forge's aggregator derives a scale from
  the sample (`DEC_SCALE`) and rounds at one decimal place in the declared mode; a document that
  prints, say, two decimals, or rounds only the mean and not the min/max, cannot say so. For the
  station document this forced a choice: the `sum` role had to be defined as "the sum of the per-row
  values rounded at that precision" rather than left to the document, because the document has no
  field to declare which it means.
- **There is no way to declare that a relation is judged on a projected fixture.** Every relation is
  judged on the whole declared output. A relation about one line's shape cannot be tested in
  isolation from the other lines.
- **The `id` role is both the row identity and the group key.** A report that groups by a column
  different from the one its rows are identified by is not describable yet -- the forge would group
  the wrong way and there is no second role to say otherwise.
- **`poc-blackbox-acceptance.yaml` had to be corrected to five columns for the same reason**: its
  employee rows did not line up with a single `id`/`measure`/`date` reading under the roles above, so
  the document's world was edited to fit the vocabulary. That is the vocabulary narrowing the world,
  which is the direction this ADR exists to move away from.

## Evidence

- `/tmp/i7-delivery.log`, lines 176-181: the employee-world judge on a station delivery --
  `checks: 2/10 ok`, `REL-001` passing on two empty outputs -- the failure this ADR is for.
- The hand re-verification, reproduced here. Against the known-good implementation
  (`.takumi/worktree-station4`, the accepted one) with the judge forged from the current document:

  ```
  $ cd .takumi/acceptance/judge_forge
  $ TAKUMI_WORKTREE=.takumi/worktree-station4 TAKUMI_PROJECT=<repo> bash judge.sh
  ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing
  ok 2 - REL-002 additivity: the parts sum to the whole the tool printed (count)
  ok 3 - REL-003 duplicate-resolution: the chosen option "merge" holds on both duplicate fixtures
  ok 4 - REL-004 malformed-row-accounting: 3 malformed rows are out of the aggregates, 5 valid rows
    still report a summary (skip-count)
  ok 5 - DIFF-001 independent-aggregation: an independent recomputation (rounding: half-up) matches
    the report
  ok 6 - DOC-001 every open decision has a chosen option (5/5)
  ok 7 - DEC-001 AMB-001 honoured: "skip-count: ..." (checked by REL-004)
  ok 8 - DEC-002 AMB-002 honoured: "merge: ..." (checked by REL-003)
  ok 9 - DEC-003 AMB-003 honoured: "half-up: round half away from zero" (checked by DIFF-001)
  ok 10 - DEC-004 AMB-005 honoured: "valid readings only: ..." (checked by REL-002)
  # tests 10
  # pass 10
  # fail 0
  ACCEPT_VERDICT: pass
  ```

- A deliberately broken copy (the same tree with the `TOTAL` line computed as `total + 1`) is caught,
  naming the right relations and decisions:

  ```
  not ok 2 - REL-002 additivity: the count values sum to 5 but the totals line says 6; — roles=count
    sums=count
  not ok 3 - REL-003 duplicate-resolution: the chosen option "merge" does not hold (late-date: totals
    count=7 want 6; early-date: totals count=7 want 6)
  not ok 5 - DIFF-001 independent-aggregation: an independent recomputation (rounding: half-up)
    disagrees with the report — totals count=6 want 5
  # pass 2
  # fail 8
  ACCEPT_VERDICT: fail
  ```

- `packages/core/src/test/judge-forge-decisions.test.ts` (14 tests), whose names include
  `decisions: CHANGING THE ANSWER fails the UNCHANGED implementation — the decision binds it` and
  `decisions: a defect the implementer tests would share anyway still fails a DEC line`.

### A limit found while writing this record, not by the ledger

The ledger's claim for #37 is that "three deliberately broken copies" fail. One class of broken copy
does NOT fail, and the difference is worth recording because it is exactly the limit above made
concrete. The rounding invariance the document promises is not, on the approved fixture, observable.

Taking the delivered implementation and changing only the rounding constant
(`ROUND_HALF_UP` -> `ROUND_HALF_EVEN`) leaves it identical to the accepted file in every other byte
(`diff` after re-substituting the constant reports no difference). Against the judge's own base
fixture it prints:

```
$ bash summary.sh .takumi/acceptance/judge_forge/fixtures/base.csv
ALPHA 3 9.5 11.6 10.5
BRAVO 2 -2.5 -1.5 -2.0
SKIPPED 0
TOTAL 5
```

and the forged judge still reports

```
# tests 10
# pass 10
# fail 0
ACCEPT_VERDICT: pass
```

The reason is in the fixture: `fixtures/base.csv` holds `10.4, -2.5, 11.6, -1.5, 9.5` — every mean
is exactly representable at one decimal place, so half-up and half-even agree on all of them.
`DEC_SCALE` is derived from the sample (`10.4` gives scale 1), so the judge's own recomputation
rounds at the same one decimal place and the same values, and `DIFF-001` cannot separate the two
modes. The delivery's OWN suite of 39 tests does catch this change (`# tests 39 / # pass 32 / # fail 7`,
exit 1), so the defect is not invisible to the implementation's tests — but the forged judge, whose
entire purpose is to be the check the implementer did not write, does not. The `half-up` mode is
matched, the decision `DEC-003` is reported `ok`, and it is not honoured.

This is not a contradiction of the ledger's "three broken copies"; those copies broke relations
(field count, additivity, duplicate accounting) that the fixtures do exercise. It is a limit on the
diff coverage: the declared sample fixes the fixture, and a mode whose effect is a tie-break cannot
be exercised by a sample with no tie in it, because the document has no way to declare a second
fixture for one relation. The honest statement is that `DIFF-001`'s "rounding: half-up" is checked
against a sample that happens not to discriminate, and the document cannot currently say otherwise.
